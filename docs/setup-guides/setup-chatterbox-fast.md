# Chatterbox Fast Sidecar — Install Guide

> **Status**: Sections 1 (standalone smoke) and 2 (sidecar install) are runnable today. Section 3 (parallel-batch tuning) covers the live `/tts/batch` path; the operator-side end-to-end smoke (Task 2.5 in `docs/plans/2026-05-08-chatterbox-parallelism.md`) is still pending — numbers in the Tuning table will be revised once it runs.

This sidecar is **additive** to the existing `devnen/Chatterbox-TTS-Server` setup. You can run both at once — devnen on port 8004, the fast sidecar on port 8005 — and switch between them per-workflow via the `tts_provider` setting (`chatterbox` vs `chatterbox-fast`).

The fast sidecar uses [`rsxdalv/chatterbox@fast`](https://github.com/rsxdalv/chatterbox/tree/fast), a fork that adds engine-level inference optimizations (KV-cache rework, static-embedding caching, hot-loop branch elimination) on top of upstream Resemble AI Chatterbox. API-compatible with upstream — same `ChatterboxTTS.from_pretrained()`, same `model.generate(text, audio_prompt_path=…)`.

## Hardware

- NVIDIA GPU strongly recommended. RTX 4070 / 12 GB VRAM is the reference target.
  - 2 concurrent workers fit comfortably on 12 GB; 3 may fit depending on chunk length.
  - **Check**: `nvidia-smi`. CUDA driver version ≥12.1 for RTX 20/30/40, ≥12.8 for RTX 50.
- ~8 GB free disk for Python deps and the model cache (weights are ~2 GB, downloaded from Hugging Face on first generation).
- 16 GB system RAM minimum; 32 GB recommended (you'll have HistForge + worker + sidecar running together).

## Prerequisites

Same as `docs/setup-guides/setup-chatterbox.md`. Skip whichever you already have.

- **Python 3.10, 3.11, or 3.12.** Python 3.13/3.14 don't yet have wheels for all of Chatterbox's deps. If you only have 3.13+ on PATH, install 3.11 or 3.12 from python.org and use `py -3.11` / `py -3.12` explicitly when creating the venv.
  - **Check**: `py -0` lists every interpreter the Python launcher knows about.
- `git` on PATH — `git --version`.
- `ffmpeg` on PATH — `ffmpeg -version`. Used by HistForge for the WAV→MP3 transcode.

## 1. Standalone smoke test (Phase 0 — runnable today)

Use this to confirm the fast fork works on your machine before building the sidecar around it. Throwaway venv, no HistForge changes.

> **No `git clone` needed.** The fast fork is pip-installed as a Python library directly from GitHub later in this script (the `pip install ... git+https://github.com/rsxdalv/chatterbox.git@fast` line). Devnen's guide clones because you run its `server.py` locally; here we just import the fork. To inspect the source after install, look in `venv\Lib\site-packages\chatterbox\`.

> **No running Chatterbox server needed.** The Python smoke at the end of this section loads the model directly into the Python process via `ChatterboxTTS.from_pretrained(...)` and calls `m.generate(...)` in-memory. No HTTP, no port, no separate process. (Devnen's `python server.py` is a different mental model — that's a client/server setup. Here we use the fork as a library.) Stop the devnen server if you have it running; you don't need it.

```powershell
# Pick a scratch directory outside the histforge repo
mkdir C:\scratch\chatterbox-fast-spike
cd C:\scratch\chatterbox-fast-spike

# Create venv with Python 3.11 (or 3.12). Adjust if you only have one.
py -3.12 -m venv venv
.\venv\Scripts\activate

# Pin setuptools <81 BEFORE anything else — resemble-perth (a transitive
# dep) imports pkg_resources, which setuptools 81+ ships without. Without
# this, the watermarker silently becomes None and model load crashes.
pip install --upgrade pip
pip install "setuptools<81"

# Install torch matching your CUDA. RTX 20/30/40 → cu121:
pip install torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cu121

# Install the fast fork. --no-deps so it doesn't override your torch.
pip install --no-deps git+https://github.com/rsxdalv/chatterbox.git@fast

# Install the rest of chatterbox's deps manually (it's a small list).
# transformers, diffusers, s3tokenizer pinned to known-good versions —
# the fast fork's pyproject.toml leaves them unpinned, so without these
# pins pip pulls latest, which breaks model load (transformers 5.x has
# restructured LlamaConfig — see Troubleshooting at the bottom).
pip install numpy resampy==0.4.3 librosa s3tokenizer==0.3.0 transformers==4.46.3 diffusers==0.29.0 resemble-perth==1.0.1 omegaconf conformer safetensors

# Force-reinstall protobuf into the onnx-compatible range. Matches the
# devnen install for the same reason — descript-audiotools tries to
# demote protobuf<3.20, which breaks onnx's `builder` import.
pip install --no-deps --force-reinstall "protobuf>=4.25.0"
```

GPU sanity check:

```powershell
python -c "import torch; print(torch.__version__, 'cuda=', torch.cuda.is_available())"
# Expect: 2.5.1+cu121 cuda= True
```

Generate one WAV. Write a `smoke_test.py` file (paste-robust — `python -c "..."` with newlines is fragile in PowerShell because pasted multiline strings often pick up indentation), then run it:

```powershell
@'
import torch
import torchaudio as ta
from chatterbox.tts import ChatterboxTTS
m = ChatterboxTTS.from_pretrained(device='cuda')
# Note: generate() in the fast fork is a streaming generator that yields
# tensor chunks of shape (1, samples) — not a single tensor like upstream
# Chatterbox. We materialize and concatenate along the time axis. The
# fork's own example_tts.py is stale and shows the upstream (broken) API.
chunks = list(m.generate('Hello from the fast Chatterbox fork. This is a smoke test.'))
wav = torch.cat([c.cpu() for c in chunks], dim=-1)
ta.save('smoke.wav', wav, m.sr)
print('OK - wrote smoke.wav at', m.sr, 'Hz')
'@ | Out-File -FilePath smoke_test.py -Encoding utf8

python smoke_test.py
```

The closing `'@` of the here-string must be at column 0 (no leading whitespace) — that's a PowerShell parser rule. `-Encoding utf8` is required because PowerShell's default `Out-File` encoding is UTF-16 LE with BOM, which Python won't read.

You should hear narration in `smoke.wav`. Note the wall-clock for this generation — compare against the same text on your existing devnen install. The fast fork should be perceptibly quicker on the second-and-later runs (first run downloads ~2 GB of weights).

While generating, run `nvidia-smi` in another terminal — capture peak VRAM. This sets your worker-count ceiling for the parallel `/tts/batch` path (typical: ~3 GB per concurrent generation on a 4070).

If anything fails here, fix it before Phase 1 — the sidecar reuses this exact dependency stack.

### Common Phase 0 pitfalls (same as devnen, same fixes)

- **`TypeError: 'NoneType' object is not callable` on model load** → you skipped `pip install "setuptools<81"`. Fix: re-run that command in the venv, retry.
- **`ImportError: cannot import name 'builder' from 'google.protobuf.internal'`** → you skipped the protobuf force-reinstall. Re-run the last `pip install` command above.
- **`torch.cuda.is_available() == False`** → wrong torch wheel for your driver, or driver too old. Run `nvidia-smi`, check the CUDA version in the top-right, install the matching torch wheel (cu121 for RTX 20/30/40, cu128 for RTX 50).
- **`AttributeError: 'LlamaConfig' object has no attribute 'rope_theta'`** (or similar `LlamaConfig` attribute errors during `ChatterboxTTS.from_pretrained`) → the installed `transformers` is too new (5.x restructured `LlamaConfig`). The fast fork was validated against transformers 4.4x. Fix: `pip install --force-reinstall "transformers==4.46.3"`. If you installed before this guide pinned the version, also force-reinstall `diffusers==0.29.0` and `s3tokenizer==0.3.0` for the same reason.
- **`AttributeError: 'generator' object has no attribute 'ndim'`** at `ta.save(...)` → you used the upstream Chatterbox call pattern (`wav = m.generate(text); ta.save(...)`). The fast fork's `generate()` is a streaming generator — yields chunks instead of returning a single tensor. The smoke snippet above shows the correct pattern (materialize the chunks into a list, then `torch.cat(..., dim=-1)`). The fork's own `example_tts.py` shows the broken pattern; ignore it.
- **`IndentationError: unexpected indent` at `import torch` (line 2) when running `python -c "..."`** → PowerShell or your terminal injected leading spaces when you pasted the multiline string. Use the file-based approach above (`@'...'@ | Out-File -FilePath smoke_test.py -Encoding utf8`) or collapse the script to one line with semicolons: `python -c "import torch; import torchaudio as ta; from chatterbox.tts import ChatterboxTTS; m = ChatterboxTTS.from_pretrained(device='cuda'); chunks = list(m.generate('Hello.')); wav = torch.cat([c.cpu() for c in chunks], dim=-1); ta.save('smoke.wav', wav, m.sr); print('OK')"`.

## 2. Sidecar install

The sidecar lives at `chatterbox-fast-server/` inside the histforge repo as a **self-contained folder**: `server.py`, the operator-local `venv/`, and the `voices/` / `reference_audio/` directories all live together. Don't put the venv elsewhere — `server.py` resolves voice files relative to its own location, and the repo's `.gitignore` is already configured for `venv/` to sit next to it.

### 2.1. Install

From a fresh PowerShell, inside the repo:

```powershell
cd C:\path\to\histforge\chatterbox-fast-server

# Create the venv right next to server.py (gitignored)
py -3.12 -m venv venv
.\venv\Scripts\activate

# Pre-step pins (same gotchas as Section 1 — keep this order)
pip install --upgrade pip
pip install "setuptools<81"

# torch + torchaudio matching CUDA. RTX 20/30/40 → cu121:
pip install torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cu121

# Fast fork as a library, no deps so it can't downgrade your torch
pip install --no-deps git+https://github.com/rsxdalv/chatterbox.git@fast

# Sidecar runtime (FastAPI/uvicorn/pydantic/scipy) + pinned chatterbox deps
pip install -r requirements.txt

# Protobuf into the onnx-compatible range (matches devnen for the same reason)
pip install --no-deps --force-reinstall "protobuf>=4.25.0"
```

If you already did Section 1's standalone smoke in a different venv, do **not** try to reuse it — the FastAPI/uvicorn/pydantic/scipy stack the sidecar needs is not in that venv, and pointing the sidecar at the wrong venv was a real source of confusion during 1.5 smoke. Build a fresh venv inside `chatterbox-fast-server/` per above.

### 2.2. Voice library

Drop voice files into one of two directories under `chatterbox-fast-server/`:

- `voices/` — for `voice_mode = "predefined"` (HistForge's default Chatterbox flow).
- `reference_audio/` — for `voice_mode = "clone"` (zero-shot voice cloning from a sample).

Filenames are passed verbatim from HistForge's `chatterbox_voice_filename` setting. The sidecar uses the *same convention* as devnen, so the easiest path is to copy from your existing devnen install:

```powershell
Copy-Item -Recurse C:\path\to\devnen\voices\* C:\path\to\histforge\chatterbox-fast-server\voices\
```

### 2.3. Run the sidecar

From an activated venv:

```powershell
cd C:\path\to\histforge\chatterbox-fast-server
python server.py
```

Listens on `127.0.0.1:8005`. The **first** request after process start triggers a one-time HuggingFace download of ~2 GB of weights into your user cache; subsequent process boots are instant.

For day-to-day, drop a Windows batch script outside the repo (don't commit it — it's operator-local):

```bat
@echo off
cd /d "C:\path\to\histforge\chatterbox-fast-server"
call .\venv\Scripts\activate.bat
python server.py
pause
```

The `pause` keeps the window open if the server errors out so you can read the traceback.

### 2.4. Verify

Health probe:

```powershell
Invoke-RestMethod http://127.0.0.1:8005/health
# @{status=ok}
```

Synthesize a short test phrase directly (bypasses HistForge — useful for diagnosing voice file or model issues without the worker in the loop). Use PowerShell splatting so long URLs/paths don't break on paste — pasting one long line into PowerShell's terminal can split it at the wrap and produce confusing argument-parsing errors:

```powershell
$params = @{
  Uri = "http://127.0.0.1:8005/tts"
  Method = "Post"
  ContentType = "application/json"
  Body = '{"text":"Hello from the fast sidecar.","voice_mode":"predefined","voice_filename":"YOUR_VOICE.wav"}'
  OutFile = "smoke.wav"
}
Invoke-RestMethod @params
```

`smoke.wav` lands in your current PowerShell directory. `(Resolve-Path .\smoke.wav).Path` shows the absolute path; `Start-Process (Resolve-Path .\smoke.wav).Path` opens it in your default audio player.

Direct `/tts` calls send the full payload through one `model.generate()` — the chunker only runs on HistForge-side calls. Keep diagnostic test payloads under ~1500 chars to avoid the t3 text-encoder overflow described under "Long-script handling" below.

### 2.5. Point HistForge at it

In the dashboard:

1. **Settings → TTS** → confirm `chatterbox_fast_base_url` is `http://127.0.0.1:8005` (the default).
2. **Workflows → edit a workflow → TTS provider** → select **"Chatterbox (fast)"** → save.

Per-workflow selection is **snapshot-pinned**: each video carries a workflow snapshot containing the `tts_provider` value at the time it was queued. Toggling a workflow's TTS provider after a video has been queued does *not* redirect that in-flight video — only newly-queued videos use the new provider.

### 2.6. Running side-by-side with devnen

Both sidecars can listen at the same time — devnen on `8004`, fast on `8005`, no port conflict. Devnen holds one ~2 GB model copy; the fast sidecar holds a pool of `N` models (one per concurrent worker, where `N` is the largest `workers` value seen so far in the process's lifetime). Just having both up costs roughly `2 × (N + 1)` GB of static model weight in VRAM before any active generation. A single active generation on either is fine on a 12 GB 4070; **concurrent** generations across both will likely OOM the GPU.

The HistForge worker only runs one step 06 at a time, so you can leave both up for A/B comparison as long as you're not separately driving the unused one with `curl` / `Invoke-RestMethod` while a video is generating.

## Long-script handling

The sidecar exposes two endpoints:

- `POST /tts` — single chunk in, WAV out. Use it for diagnostics. HistForge no longer calls this path.
- `POST /tts/batch` — chunk array in, single concatenated WAV out. Body: `{ chunks: [str], voice_mode, voice_filename, ...tuning..., silence_ms, workers }`. The sidecar fans the chunks across `workers` threads over a pool of `ChatterboxTTS` models (one per concurrent worker, lazy-loaded on demand and persistent for the sidecar's process lifetime) and inserts `silence_ms` of digital silence at every chunk join.

HistForge always calls `/tts/batch`. The chunker (`src/lib/tts/chunker.ts`) splits the script into sentence-grouped chunks ≤ `chatterbox_fast_max_chunk_chars` with an abbreviation guard, falling back to punctuation and word-boundary splits for over-budget single sentences.

**Why the chunker matters.** Past ~1500 chars in a single `model.generate()` call, the fast fork's t3 text-encoder triggers a CUDA device-side assert (position-embedding overflow). The crash poisons the sidecar's GPU context: every subsequent request fails the same way until you stop and restart `server.py`. The trace surfaces inside `learned_pos_emb.py` but that's misleading — CUDA kernels are async, so the assert appears at the *next* CUDA op, not the failed one.

The chunker keeps every chunk well under that ceiling, so HistForge never trips it. Direct `/tts` calls (e.g. the `Invoke-RestMethod` diagnostics in §2.4) bypass the chunker — keep those payloads short.

**Recovery from a poisoned sidecar.** If you do hit the assert via a direct call with a long payload, `Ctrl+C` `python server.py` and restart it. There's no in-process recovery — the CUDA context for that PID is gone.

## 3. Tuning workers and chunks

The three `chatterbox_fast_*` settings tune the parallel batch path. Defaults are conservative — start there, then adjust based on your own smoke run.

| Setting | Default | Range | What it does |
|---|---|---|---|
| `chatterbox_fast_workers` | `2` | `1..4` | Concurrent `model.generate()` calls per request. The sidecar holds a pool of `ChatterboxTTS` models — one per concurrent worker, lazy-loaded on the first request that asks for that worker count, and persistent for the process lifetime. Each in-flight inference leases its own model, so concurrent generations never share an instance. The HistForge-side range (`1..4`) is the effective ceiling; the sidecar itself imposes no upper bound, so widening this setting later won't require a sidecar redeploy. |
| `chatterbox_fast_silence_ms` | `150` | `0..1000` | Digital silence inserted between chunks at concatenation. Masks sentence-boundary seams. |
| `chatterbox_fast_max_chunk_chars` | `300` | `100..2000` | Upper bound on per-chunk length. Smaller = more parallelism + more joins; larger = fewer joins + less parallelism. |

**Speed/quality tradeoff.** The model pool's static cost scales with `workers` (each pooled model is ~2 GB resident), and active generations add another ~2-3 GB peak each on top. Estimates pending the operator-side smoke (Task 2.5 in `docs/plans/2026-05-08-chatterbox-parallelism.md`): `workers=2` ≈ 8-10 GB peak (tight on a 12 GB 4070); `workers=3+` will likely OOM on a 4070. Validate at each new worker count by watching `nvidia-smi` during your first run at that level — the pool keeps the new model resident afterwards, so the headroom check matters most on the first request.

**Audible chunk seams.** If you hear a click or pause-glitch at sentence boundaries, raise `chatterbox_fast_silence_ms` to 200–300 ms. If voice or emotion drifts noticeably between chunks, raise `chatterbox_fast_max_chunk_chars` so each generation runs longer (fewer joins, fewer drift opportunities) — at the cost of less parallelism.

**Cancellation mid-batch.** Aborting the HistForge step interrupts the HTTP fetch; the sidecar's `ThreadPoolExecutor` keeps running until in-flight `model.generate()` calls finish their current chunks (CUDA generations can't be cleanly cancelled). The result is discarded. Same behavior as the devnen path.

**Both sidecars on one GPU.** Devnen on 8004 holds one ~2 GB model copy; the fast sidecar on 8005 holds a pool sized to its largest seen `workers` value. See §2.6 for the static-VRAM math. A single active generation on either is fine on a 12 GB 4070; concurrent generations across both will likely OOM. Keep one of them idle while the other is narrating.

## License and watermark

- `rsxdalv/chatterbox` is MIT (same as upstream Resemble AI Chatterbox).
- All output carries Resemble AI's Perth perceptual watermark — inaudible, survives MP3 transcoding, detectable by Resemble's tooling. Same as the devnen-backed path. Informational, no opt-out.
