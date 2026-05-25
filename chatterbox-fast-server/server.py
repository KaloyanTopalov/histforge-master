"""HistForge Chatterbox Fast sidecar.

Wraps `rsxdalv/chatterbox@fast` and exposes a minimal FastAPI surface
for HistForge's `chatterbox-fast` TTS provider. One model is loaded
eagerly at boot; further models are loaded lazily into the
`ModelPool` as request `workers` values demand them.

Endpoints:
  POST /tts        -> single chunk in, WAV bytes out
  POST /tts/batch  -> chunk array in, single concatenated WAV bytes out
                     (with per-request `workers` and `silence_ms`)

Single source of truth: both endpoints delegate to `_run_batch`. The
`/tts` endpoint is a one-element-list shell so HistForge can keep a
single body shape on the wire.

Internal parallelism uses a `ThreadPoolExecutor` over a `ModelPool` of
`ChatterboxTTS` instances. The rsxdalv@fast fork caches per-call state
on the model (KV cache, position embeddings); concurrent
`model.generate()` calls on one instance crash or silently corrupt
output, so each in-flight inference leases its own model and returns
it when done.

Speed handling lives on the HistForge side (ffmpeg atempo in the
WAV->MP3 transcode); this sidecar emits unmodified-tempo WAV.

Default port 8005 (devnen runs on 8004 — both can run side-by-side).
"""
from __future__ import annotations

import io
import logging
import os
import queue
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Literal, Optional

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from scipy.io import wavfile  # type: ignore[import-untyped]

from chatterbox.tts import ChatterboxTTS  # type: ignore[import-not-found]


HERE = Path(__file__).resolve().parent
VOICES_DIR = HERE / "voices"
REFERENCE_AUDIO_DIR = HERE / "reference_audio"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


# Logging — the sidecar runs in its own console window via
# `python server.py`. uvicorn configures the root logger when it boots,
# but module-level activity (model loads inside @app.on_event("startup"))
# happens before that, so install our own basicConfig if no handler is
# present yet. CHATTERBOX_FAST_LOG_LEVEL widens to DEBUG when needed.
LOG_LEVEL = os.environ.get("CHATTERBOX_FAST_LOG_LEVEL", "INFO").upper()
if not logging.getLogger().handlers:
    logging.basicConfig(
        level=LOG_LEVEL,
        format="%(asctime)s.%(msecs)03d [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
else:
    logging.getLogger().setLevel(LOG_LEVEL)
logger = logging.getLogger("chatterbox_fast")
logger.setLevel(LOG_LEVEL)


def _vram_summary() -> str:
    """One-line VRAM snapshot. CPU-safe.

    Reports PyTorch's caching-allocator view (`memory_allocated` =
    bytes currently held by live tensors; `memory_reserved` = bytes
    the allocator has claimed from the driver, including freed-but-
    cached blocks) plus the device's total capacity. Headroom is
    derived from `reserved` because that's the figure that bites:
    further allocations have to fit into `total - reserved`, and the
    cached-but-free blocks aren't returned to the driver until you
    call `torch.cuda.empty_cache()`. When `free` approaches zero
    while a generation is running, that's the OOM/thrash signature.
    """
    if not torch.cuda.is_available():
        return "vram=cpu"
    try:
        idx = torch.cuda.current_device()
        alloc_mb = torch.cuda.memory_allocated(idx) / (1024 ** 2)
        reserved_mb = torch.cuda.memory_reserved(idx) / (1024 ** 2)
        total_mb = (
            torch.cuda.get_device_properties(idx).total_memory / (1024 ** 2)
        )
        free_mb = total_mb - reserved_mb
        return (
            f"vram=alloc={alloc_mb:.0f}MB reserved={reserved_mb:.0f}MB "
            f"free={free_mb:.0f}MB/{total_mb:.0f}MB"
        )
    except Exception as e:  # never let a logging probe break inference
        return f"vram=error({e})"


def _preview(text: str, n: int = 60) -> str:
    """Compact one-line preview — collapses whitespace and truncates."""
    s = " ".join(text.split())
    return f"{s[:n]}…" if len(s) > n else s


class TtsRequest(BaseModel):
    text: str = Field(..., min_length=1)
    voice_mode: Literal["predefined", "clone"]
    voice_filename: str = Field(..., min_length=1)
    temperature: float = 0.8
    exaggeration: float = 0.5
    cfg_weight: float = 0.5
    # Forward-compat with /tts/batch's body shape. Ignored on /tts (single
    # chunk path always runs serially).
    workers: Optional[int] = None


class BatchRequest(BaseModel):
    chunks: list[str] = Field(..., min_length=1)
    voice_mode: Literal["predefined", "clone"]
    voice_filename: str = Field(..., min_length=1)
    temperature: float = 0.8
    exaggeration: float = 0.5
    cfg_weight: float = 0.5
    # Digital silence inserted at chunk joins to mask sentence-boundary
    # seams. Not added before the first chunk or after the last.
    silence_ms: int = Field(150, ge=0, le=1000)
    # Per-request — operator tunes parallelism without restarting the
    # sidecar. The pool grows on demand to match `workers`; the operator
    # owns VRAM headroom (each pooled model is ~2 GB static + ~2-3 GB
    # peak activations during generate()). The effective ceiling is the
    # HistForge-side Zod schema (`chatterbox_fast_workers`, currently
    # 1..4), so the sidecar deliberately imposes no upper bound here —
    # widening the client cap won't require a sidecar redeploy.
    workers: int = Field(2, ge=1)


class ModelPool:
    """Thread-safe pool of ChatterboxTTS instances.

    rsxdalv@fast caches per-call state on the model (KV cache, position
    embeddings); concurrent generate() calls on one instance crash or
    silently corrupt output. Lease one model per concurrent inference
    via a FIFO `queue.Queue`; the queue's get/put pair guarantees no
    model is in two concurrent generations at once.

    Pool grows monotonically — never shrinks, never swaps. The growth
    lock is held only during the size-check + load loop; never during
    inference (otherwise it would serialize generations and defeat the
    purpose of the pool).
    """

    def __init__(self, factory: Callable[[], ChatterboxTTS]) -> None:
        self._factory = factory
        self._free: queue.Queue[ChatterboxTTS] = queue.Queue()
        self._size = 0
        self._sr: Optional[int] = None
        self._growth_lock = threading.Lock()

    def ensure_size(self, n: int) -> None:
        """Load models until the pool has at least `n` instances.

        Each from_pretrained is ~2 GB VRAM and tens of seconds (longer
        on first run when weights download from HuggingFace; faster on
        cached weights). The per-model log line lets operators see why
        a request that bumps the pool size is unusually slow.
        """
        with self._growth_lock:
            while self._size < n:
                next_size = self._size + 1
                logger.info(
                    f"ModelPool: loading model #{next_size} "
                    f"(current size {self._size}, target {n}) {_vram_summary()}"
                )
                load_started = time.monotonic()
                model = self._factory()
                if self._sr is None:
                    self._sr = int(model.sr)
                self._free.put(model)
                self._size = next_size
                load_ms = int((time.monotonic() - load_started) * 1000)
                logger.info(
                    f"ModelPool: model #{next_size} loaded in {load_ms}ms "
                    f"{_vram_summary()}"
                )

    def acquire(self) -> ChatterboxTTS:
        return self._free.get()

    def release(self, model: ChatterboxTTS) -> None:
        self._free.put(model)

    @property
    def sample_rate(self) -> int:
        if self._sr is None:
            raise RuntimeError("ModelPool has no models loaded yet")
        return self._sr

    @property
    def size(self) -> int:
        return self._size


def _make_model() -> ChatterboxTTS:
    return ChatterboxTTS.from_pretrained(device=DEVICE)


def _device_name() -> str:
    """GPU name when on CUDA, "n/a" otherwise. Wrapped in try/except so
    a flaky driver query never blocks startup."""
    if not torch.cuda.is_available():
        return "n/a"
    try:
        return torch.cuda.get_device_name(torch.cuda.current_device())
    except Exception:
        return "unknown"


app = FastAPI(title="HistForge Chatterbox Fast")
_pool = ModelPool(_make_model)


@app.on_event("startup")
def _warm() -> None:
    # Eager-load one model so torch/cuda/checkpoint setup failures
    # surface at boot rather than on first request. Additional models
    # are loaded lazily inside _run_batch when a higher `workers`
    # value arrives.
    logger.info(
        f"Chatterbox Fast starting up: device={DEVICE} ({_device_name()}) "
        f"log_level={LOG_LEVEL} {_vram_summary()}"
    )
    _pool.ensure_size(1)


def resolve_audio_prompt(voice_mode: str, voice_filename: str) -> str:
    base = VOICES_DIR if voice_mode == "predefined" else REFERENCE_AUDIO_DIR
    candidate = base / voice_filename
    # Defensive: don't allow path traversal out of the voice dirs.
    try:
        candidate.relative_to(base)
    except ValueError as e:
        raise HTTPException(
            status_code=400,
            detail=f"voice_filename must live inside {base.name}/",
        ) from e
    if not candidate.is_file():
        raise HTTPException(
            status_code=400,
            detail=f"voice file not found: {base.name}/{voice_filename}",
        )
    return str(candidate)


def _generate_chunk_pcm(
    model: ChatterboxTTS,
    text: str,
    audio_prompt_path: str,
    temperature: float,
    exaggeration: float,
    cfg_weight: float,
    *,
    log_tag: str,
) -> np.ndarray:
    """Generate one chunk's audio as int16 PCM samples (mono).

    The fast fork's generate() is a streaming generator yielding tensor
    chunks of shape (1, samples). The fork's own example_tts.py shows
    the upstream API (single-tensor return) and is stale — see
    docs/setup-guides/setup-chatterbox-fast.md Section 1 for the validated pattern.

    The caller is responsible for leasing `model` from `_pool` and
    releasing it after the call returns or raises.

    `log_tag` is the opaque `[req=… chunk=…]` prefix the caller already
    uses for this chunk's lifecycle logs; we stamp it onto the yield
    heartbeat so live progress correlates with the START/END pair.
    """
    started = time.monotonic()
    last_log_at = started
    chunks_out: list[torch.Tensor] = []
    yield_count = 0
    for c in model.generate(
        text,
        audio_prompt_path=audio_prompt_path,
        temperature=temperature,
        exaggeration=exaggeration,
        cfg_weight=cfg_weight,
    ):
        chunks_out.append(c.cpu())
        yield_count += 1
        # Heartbeat every 5s so a stalled generate() is visible. Per-
        # yield logging would spam the console (the streaming fork
        # yields many small tensor slices per chunk); a time-gated
        # heartbeat shows whether yields are still arriving and how
        # the gap between them grows under contention. Yield gaps that
        # stretch from sub-second to many seconds are the canonical
        # OOM/thrash signal — pair with the VRAM trace below.
        now = time.monotonic()
        if now - last_log_at >= 5.0:
            elapsed_s = now - started
            logger.info(
                f"{log_tag} yield #{yield_count} "
                f"elapsed={elapsed_s:.1f}s {_vram_summary()}"
            )
            last_log_at = now
    wav = torch.cat(chunks_out, dim=-1)
    samples = wav.squeeze(0).numpy()
    pcm = np.clip(samples, -1.0, 1.0)
    return (pcm * 32767.0).astype(np.int16)


def _serialize_wav(
    pcm_chunks: list[np.ndarray], sr: int, silence_ms: int
) -> bytes:
    """Concatenate int16 PCM chunks with `silence_ms` of digital silence
    inserted at every chunk join (not at the edges), then write a single
    WAV (16-bit PCM, mono, `sr` Hz)."""
    silence = np.zeros(int(sr * silence_ms / 1000), dtype=np.int16)
    parts: list[np.ndarray] = []
    for i, chunk in enumerate(pcm_chunks):
        if i > 0 and silence.size > 0:
            parts.append(silence)
        parts.append(chunk)
    full = (
        np.concatenate(parts)
        if parts
        else np.zeros(0, dtype=np.int16)
    )
    buf = io.BytesIO()
    wavfile.write(buf, sr, full)
    return buf.getvalue()


def _run_batch(
    *,
    chunks: list[str],
    voice_mode: str,
    voice_filename: str,
    temperature: float,
    exaggeration: float,
    cfg_weight: float,
    silence_ms: int,
    workers: int,
) -> bytes:
    """Lease one model per concurrent worker from `_pool`, generate
    every chunk (in parallel when workers > 1), and return a single
    concatenated WAV.

    Models are reused across many chunks within a batch — a pool of 2
    serves 10 chunks by being acquired ten times by alternating
    threads. Reuse is fine; simultaneous use is not, and the FIFO
    queue enforces that.
    """
    rid = uuid.uuid4().hex[:8]
    overall_started = time.monotonic()
    audio_prompt_path = resolve_audio_prompt(voice_mode, voice_filename)
    clamped = max(1, workers)
    total_chars = sum(len(c) for c in chunks)
    logger.info(
        f"[req={rid}] /tts/batch START chunks={len(chunks)} "
        f"workers={clamped} voice_mode={voice_mode} "
        f"voice={voice_filename} silence_ms={silence_ms} "
        f"total_chars={total_chars} {_vram_summary()}"
    )
    # Grow the pool up-front (on the main thread) so any first-time
    # model loads happen here, not interleaved with inference attempts
    # inside the executor's worker threads. ensure_size already logs
    # per-load VRAM, so this line stays VRAM-free to avoid duplication.
    pool_before = _pool.size
    _pool.ensure_size(clamped)
    grew_note = "no growth" if _pool.size == pool_before else "grew"
    logger.info(
        f"[req={rid}] pool size {pool_before} → {_pool.size} ({grew_note})"
    )
    sr = _pool.sample_rate

    def gen_one(item: tuple[int, str]) -> np.ndarray:
        idx, text = item
        log_tag = f"[req={rid} chunk={idx + 1}/{len(chunks)}]"
        wait_started = time.monotonic()
        # acquire/release MUST be paired via try/finally — skipping
        # the finally on an inference exception strands the model and
        # eventually deadlocks future acquire() calls.
        model = _pool.acquire()
        wait_ms = int((time.monotonic() - wait_started) * 1000)
        gen_started = time.monotonic()
        logger.info(
            f"{log_tag} generate START chars={len(text)} "
            f"acquire_wait={wait_ms}ms preview='{_preview(text)}' "
            f"{_vram_summary()}"
        )
        try:
            pcm = _generate_chunk_pcm(
                model,
                text,
                audio_prompt_path,
                temperature,
                exaggeration,
                cfg_weight,
                log_tag=log_tag,
            )
            elapsed_ms = int((time.monotonic() - gen_started) * 1000)
            logger.info(
                f"{log_tag} generate END elapsed={elapsed_ms}ms "
                f"samples={pcm.shape[0]} {_vram_summary()}"
            )
            return pcm
        except Exception as e:
            elapsed_ms = int((time.monotonic() - gen_started) * 1000)
            logger.exception(
                f"{log_tag} generate FAILED elapsed={elapsed_ms}ms: {e}"
            )
            raise
        finally:
            _pool.release(model)

    indexed = list(enumerate(chunks))
    if clamped == 1 or len(chunks) == 1:
        pcm_chunks = [gen_one(it) for it in indexed]
    else:
        # executor.map preserves input order in its output iterator.
        with ThreadPoolExecutor(max_workers=clamped) as ex:
            pcm_chunks = list(ex.map(gen_one, indexed))

    serialize_started = time.monotonic()
    wav_bytes = _serialize_wav(pcm_chunks, sr, silence_ms)
    serialize_ms = int((time.monotonic() - serialize_started) * 1000)
    overall_ms = int((time.monotonic() - overall_started) * 1000)
    logger.info(
        f"[req={rid}] /tts/batch END elapsed={overall_ms}ms "
        f"serialize={serialize_ms}ms wav_bytes={len(wav_bytes)} "
        f"{_vram_summary()}"
    )
    return wav_bytes


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/tts")
def tts(req: TtsRequest) -> Response:
    wav_bytes = _run_batch(
        chunks=[req.text],
        voice_mode=req.voice_mode,
        voice_filename=req.voice_filename,
        temperature=req.temperature,
        exaggeration=req.exaggeration,
        cfg_weight=req.cfg_weight,
        silence_ms=0,
        workers=1,
    )
    return Response(content=wav_bytes, media_type="audio/wav")


@app.post("/tts/batch")
def tts_batch(req: BatchRequest) -> Response:
    wav_bytes = _run_batch(
        chunks=req.chunks,
        voice_mode=req.voice_mode,
        voice_filename=req.voice_filename,
        temperature=req.temperature,
        exaggeration=req.exaggeration,
        cfg_weight=req.cfg_weight,
        silence_ms=req.silence_ms,
        workers=req.workers,
    )
    return Response(content=wav_bytes, media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("CHATTERBOX_FAST_PORT", "8005"))
    uvicorn.run(app, host="127.0.0.1", port=port)
