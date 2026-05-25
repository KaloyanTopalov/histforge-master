# chatterbox-fast-server

Standalone FastAPI sidecar around `rsxdalv/chatterbox@fast` for HistForge's
`chatterbox-fast` TTS provider.

Default port `8005` (devnen's `Chatterbox-TTS-Server` lives on `8004` — both
can run side-by-side).

## Endpoints

- `GET /health` → `{"status":"ok"}`.
- `POST /tts` — single chunk in, WAV out. Body: `{ text, voice_mode, voice_filename, temperature?, exaggeration?, cfg_weight?, workers? }`. `workers` is accepted for body-shape parity with `/tts/batch` but ignored — single-chunk calls always run serially. Use this for diagnostics; HistForge calls `/tts/batch` exclusively.
- `POST /tts/batch` — chunk array in, single concatenated WAV out. Body: `{ chunks: [str], voice_mode, voice_filename, temperature?, exaggeration?, cfg_weight?, silence_ms?, workers? }`. The sidecar runs each chunk on a `ThreadPoolExecutor(max_workers=workers)` over a pool of `ChatterboxTTS` models — one per concurrent worker, lazy-loaded on demand up to the request's `workers` value and persisting for the sidecar's process lifetime. Each in-flight inference leases its own model from the pool, so concurrent generations never share an instance. Then concatenates the PCM with `silence_ms` of digital silence at every chunk join (not at the edges) before serialising one WAV. The first request that bumps the pool size pays a one-time ~2 GB VRAM + tens-of-seconds load (e.g. moving from `workers=2` to `workers=3` loads a third model on first use); subsequent requests at the same level are fast.

Both endpoints delegate to the same internal `_run_batch` — `/tts` is a one-element-list shell so the upstream HistForge provider can keep one body shape on the wire.

## Cancellation semantics

Aborting the upstream fetch closes the HTTP connection but does **not** stop the in-flight `model.generate()` calls inside the sidecar's threadpool — CUDA generations can't be cleanly cancelled mid-stream. The workers run to completion and the discarded WAV is dropped on the floor when the response can't be written. Same behavior as devnen. Operator impact: a cancelled HistForge step still ties up the GPU until the active chunks finish.

## Speed handling

The sidecar emits unmodified-tempo WAV. `chatterbox_speed_factor` is applied on the HistForge side via `ffmpeg -filter:a atempo=...` inside the WAV→MP3 transcode — see `src/lib/tts/chatterbox-transcode.ts`. The fast fork's `model.generate()` exposes no speed parameter.

## Setup, run, troubleshooting

See [`docs/setup-guides/setup-chatterbox-fast.md`](../docs/setup-guides/setup-chatterbox-fast.md).
