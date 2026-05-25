# Research: Chatterbox TTS Provider Integration

**Date**: 2026-05-05
**Branch**: chatterbox-tts
**Commit**: 7fbcaf50b34ff2ba6858d28eb23544f6601d2789
**Topic**: How TTS providers are implemented in HistForge today, the full edit surface for adding a third, and what Chatterbox is on the wire (installation, API shape, output format, voice cloning).

> Descriptive documentation of what exists. No gap analysis or recommendations.

## Research Question

The user wants to add Chatterbox as another TTS provider. Document:
1. How TTS providers are implemented in the HistForge codebase today.
2. Every touchpoint that must be edited for a new provider to be selectable end-to-end.
3. What Chatterbox actually exposes on the wire (Python lib vs HTTP server, request/response shape, output format, voice cloning, hardware needs).

## Summary

The TTS layer in HistForge is a **two-provider registry** behind a tiny `TtsProvider` interface (one method: `synthesize(text, outMp3Path, opts)`). Provider selection is **per-workflow**, not per-video — the `workflows.tts_provider` column (`"ai33" | "genaipro" | null`) is frozen into `videos.workflow_snapshot` at queue time and read by `resolveDeps` in the pipeline orchestrator. Both existing providers (`ai33`, `genaipro`) target ElevenLabs-compatible remote HTTP APIs that return MP3 over a submit-then-poll task model with a sidecar resume token, plus optional SRT/JSON transcripts. The voiceover step (`06-voiceover.ts`) is a thin glue that hands a script file to whichever provider was resolved upstream; voice tuning settings are global (in the `settings` table) and read inside each provider, never on the workflow row.

Chatterbox itself is a **Python library** from Resemble AI (`pip install chatterbox-tts`) — there is **no first-party HTTP server**. Generation is `model.generate(text, audio_prompt_path=...)` returning a PyTorch tensor, written to disk via `torchaudio.save(...)` as **WAV** at `model.sr`. Voice cloning is supplied via a reference audio file (~10 seconds). Chatterbox is GPU-accelerated (CUDA, ROCm, MPS, CPU fallback). It does **not return SRT or word-level timestamps**, and every output is watermarked by Resemble AI's Perth watermarker. Two community FastAPI wrappers expose a REST contract (synchronous, OpenAI-compatible `/v1/audio/speech` returning `audio/wav`): `devnen/Chatterbox-TTS-Server` (default port 8004) and `travisvn/chatterbox-tts-api` (default port 4123). Neither wrapper exposes transcripts/SRT. Step 07 (`align`) already produces `alignment/alignment.json` from the MP3 + script via aeneas, independent of any provider-supplied transcripts.

## Detailed Findings

### 1. The `TtsProvider` Contract

The interface every provider implements is the entire contract:

`src/lib/tts/types.ts:10-26`:
```typescript
export interface TtsProvider {
  synthesize(
    text: string,
    outMp3Path: string,
    opts: {
      db?: DatabaseType;
      log?: (message: string) => void;
      signal?: AbortSignal;
    }
  ): Promise<TtsResult>;
}
```

`TtsResult` (`src/lib/tts/types.ts:3-8`):
```typescript
export interface TtsResult {
  transcripts?: {
    srtPath?: string;
    jsonPath?: string;
  };
}
```

The provider's job: receive text + an output MP3 path (and a cancellation signal), write the audio to disk at exactly that path, and optionally write SRT and/or JSON transcripts to sibling paths and return their locations. Settings are read by the provider via `getSetting(key, opts.db ?? getDb())` — the contract does not pass any voice-config dictionary; providers reach into the DB themselves.

### 2. Provider Registry

`src/lib/tts/index.ts:7-18`:
```typescript
export const ttsProviders: Record<string, TtsProvider> = {
  ai33: ai33Provider,
  genaipro: genaiproProvider,
};

export function getTtsProvider(name: string): TtsProvider {
  const provider = ttsProviders[name];
  if (!provider) {
    throw new Error(`Unknown TTS provider: "${name}"`);
  }
  return provider;
}
```

`src/lib/tts/meta.ts:24-37` — operator-facing metadata (label, env-var name, endpoint string), client-safe (no `node:` imports), and the source of `TtsProviderId`:
```typescript
export const TTS_PROVIDER_META = {
  genaipro: { label: "GenAIPro", envKey: "GENAIPRO_API_KEY", endpoint: "genaipro.vn/api/v1" },
  ai33:     { label: "AI33",     envKey: "AI33_API_KEY",     endpoint: "api.ai33.pro/v1" },
} as const satisfies Record<string, TtsProviderMeta>;
export type TtsProviderId = keyof typeof TTS_PROVIDER_META;
```

The comment block at lines 1-16 explicitly notes that the workflow Zod enum (`lib/workflows-schema.ts`) and the workflow editor's inline option list (`app/workflows/[id]/edit/edit-form.tsx`) are kept narrow and updated by hand, not derived from `TTS_PROVIDER_META`.

### 3. Provider Resolution End-to-End

The data flow from queue tick to provider invocation:

| Step | File:line | What happens |
|------|-----------|--------------|
| 0 | `src/worker/index.ts:52` | `runLoop` wires `runPipeline` into the queue tick. |
| 1 | `src/worker/runner.ts:96-118` | `tickOnce` picks a video and `await runPipeline(picked.id)` (line 111). |
| 2 | `src/worker/pipeline.ts:282-345` | `resolveDeps(videoId)` reads the frozen `workflow_snapshot`. |
| 3 | `src/worker/pipeline.ts:242-258` | `readSnapshot` runs `SELECT workflow_snapshot FROM videos WHERE id = ?` and `JSON.parse`s the result. |
| 4 | `src/worker/pipeline.ts:302-306` | When `snapshot.tts_provider` is non-null, `getTtsProvider(snapshot.tts_provider)` resolves the singleton; null is cast to `TtsProvider` (slot is unused because step 06 is omitted from the materialized step list). |
| 5 | `src/lib/tts/index.ts:7-18` | Registry lookup; throws `Unknown TTS provider: "<id>"` for non-null unknown IDs. |
| 6 | `src/worker/pipeline.ts:179-197` | `buildStepContext` builds a fresh `StepContext` per step, reusing the same `deps.ttsProvider` reference (line 192) — only `stepName` and `signal` vary. |
| 7 | `src/worker/steps/06-voiceover.ts:82-88` | Step 06's `run` hands `ctx.ttsProvider` to `runVoiceover`. |
| 8 | `src/worker/steps/06-voiceover.ts:40-43` | `provider.synthesize(text, outPath, { log, signal })` invoked. |

Snapshot is **frozen** — once a video is created/queued, its `tts_provider` is fixed. Editing the live workflow row does not retroactively change in-flight videos (`src/lib/workflows.ts:42-60`, `src/worker/pipeline.ts:268-281`).

`materializeStepList` (`src/lib/workflows.ts:88-109`) inspects `snapshot.tts_provider !== null` to decide whether `"voiceover"` is in the step slug list at all. A workflow with `tts_provider: null` skips step 06 entirely.

### 4. Voice Configuration Settings (Global, Not Per-Workflow)

The voice-tuning controls live in the global `settings` table, not on the workflow row. Defaults come from `src/lib/db.ts:11-48`:

| Key | Default | Purpose |
|-----|---------|---------|
| `voice_id` | `""` | ElevenLabs voice identifier (operator must set) |
| `voiceover_model_id` | `"eleven_multilingual_v2"` | Model name |
| `voice_stability` | `"0.75"` | 0–1 |
| `voice_similarity` | `"0.5"` | 0–1 |
| `voice_style` | `"0.0"` | 0–1 |
| `voice_speed` | `"1.0"` | 0.7–1.2 |
| `voice_use_speaker_boost` | `"true"` | boolean |

All values are stored as TEXT and Zod-coerced at read (`src/lib/settings.ts:13-92`). The settings tab assignment (`src/lib/settings-tabs.ts:48-56`) places all 7 keys on the `"tts"` tab. The `voiceover_model_id` enum values are listed in `src/lib/settings-enums.ts:33-38`: `["eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_flash_v2_5", "eleven_v3"]`.

Both providers consume the same set of keys but build different request bodies:

**AI33 (`src/lib/tts/ai33.ts:75-88`)** — ElevenLabs-compatible nested `voice_settings`:
```typescript
{
  text,
  model_id: getSetting("voiceover_model_id", db),
  with_transcript: true,
  voice_settings: {
    stability:        getSetting("voice_stability", db),
    similarity_boost: getSetting("voice_similarity", db),
    style:            getSetting("voice_style", db),
    use_speaker_boost: getSetting("voice_use_speaker_boost", db),
    speed:            getSetting("voice_speed", db),
  },
}
```

`voice_id` is read separately and placed in the URL (`src/lib/tts/ai33.ts:329`): `/text-to-speech/${voiceId}?output_format=mp3_44100_128`.

**GenAIPro (`src/lib/tts/genaipro.ts:76-87`)** — flat body:
```typescript
{
  input: text,
  model_id:           getSetting("voiceover_model_id", db),
  voice_id:           getSetting("voice_id", db),
  similarity:         getSetting("voice_similarity", db),
  speed:              getSetting("voice_speed", db),
  stability:          getSetting("voice_stability", db),
  style:              getSetting("voice_style", db),
  use_speaker_boost:  getSetting("voice_use_speaker_boost", db),
}
```

### 5. Provider Implementation Patterns (Submit + Poll + Sidecar)

Both existing providers share an identical operational shape because they both target async remote tasks:

1. **Auth**: Read `process.env[TTS_PROVIDER_META.<id>.envKey]`. AI33 uses header `xi-api-key`; GenAIPro uses `Authorization: Bearer ...`.
2. **Submit**: POST the body, get back `{ task_id }`. Wrapped in `MAX_SUBMIT_ATTEMPTS = 3` with exponential backoff (`DEFAULT_RETRY_DELAY_MS = 1000`).
3. **Sidecar resume token**: After a successful submit, write `task_id` to `audio/.tts_task_id` so a worker restart resumes polling instead of re-paying for a duplicate task. `06-voiceover.ts:72-75` registers `audio/.tts_task_id` in `step.outputs` so the orchestrator wipes it on terminal step failure.
4. **Poll**: GET task status every `DEFAULT_POLL_INTERVAL_MS = 30_000`. Validated with Zod schemas (`PollResponseSchema` for AI33, `LabTaskSchema` for GenAIPro) — non-conforming bodies count toward `MAX_CONSECUTIVE_POLL_FAILURES = 60` and surface as a step error rather than a silent spin.
5. **Download**: Fetch the audio URL and write to `outMp3Path`. Optional SRT/JSON transcripts written to sibling paths under `audio/`.
6. **Cancellation**: `signal` is passed to every `fetch` call and `throwIfAborted(signal)` is checked before each poll; cancellation is terminal (does not consume retries) — see helpers in `src/worker/cancellation.ts`.
7. **Cleanup on success**: `rmSync(sidecarPath, { force: true })`.

GenAIPro additionally polls a separate **subtitle export** endpoint (`POST /v1/labs/task/subtitle/<id>` → poll `task.subtitle`), bounded by `MAX_SUBTITLE_POLL_ATTEMPTS = 10` (`src/lib/tts/genaipro.ts:267-337`). Subtitle export is best-effort; missing SRT is not fatal because step 07 produces alignment from the MP3 directly.

### 6. Step 06 (`voiceover`) Inputs/Outputs

`src/worker/steps/06-voiceover.ts:61-89`:

| Field | Value |
|-------|-------|
| `name` | `"voiceover"` |
| `module` | `"tts"` |
| `inputs` | `["script/full_script.md"]` |
| `outputs` | `["audio/narration.mp3", "audio/narration.srt", "audio/narration.json", "audio/.tts_task_id"]` |
| `produces` | `["audio/narration.mp3", "audio/narration.srt", "audio/narration.json"]` |

`outputs` is the failure-cleanup list; `produces` is what downstream steps consume. The sidecar `.tts_task_id` is in `outputs` (so it gets wiped on terminal failure) but excluded from `produces` (downstream steps don't read it).

### 7. Alignment Is Independent of TTS

`src/worker/steps/07-align.ts:22-26`:
```typescript
const audioPath = join(projectDir, "audio", "narration.mp3");
const scriptPath = join(projectDir, "script", "full_script.md");
const outPath = join(projectDir, "alignment", "alignment.json");
await align(audioPath, scriptPath, outPath, deps);
```

Step 07 reads `audio/narration.mp3` + `script/full_script.md` and writes `alignment/alignment.json` via aeneas (`lib/align.ts`). It does **not** consume the SRT/JSON transcripts that ai33/genaipro return. A provider that returns no `transcripts` produces an empty `TtsResult`, and step 07 still produces full alignment from the MP3 alone.

### 8. The Settings Page (`tts-settings.tsx`)

`src/app/settings/tts-settings.tsx` renders the seven shared voice-tuning controls under a `"tts"` tab inside `src/app/settings/settings-form.tsx:161-163`. Comment at line 25 of `tts-settings.tsx`:

> The active provider is selected per workflow (`workflows.tts_provider` → `snapshot.tts_provider`); this panel only carries the voice-configuration controls shared by every provider — identity, tuning sliders, speaker boost.

**There is no TTS-provider picker on the settings page.** The provider choice lives entirely in the workflow editor.

| Section | Setting Key | Input |
|---------|-------------|-------|
| Voice & Model | `voice_id` | text input |
| Voice & Model | `voiceover_model_id` | `<Select>` (4 options from `settings-enums.ts`) |
| Voice Tuning | `voice_stability` | range slider 0–1, step 0.01 |
| Voice Tuning | `voice_similarity` | range slider 0–1, step 0.01 |
| Voice Tuning | `voice_style` | range slider 0–1, step 0.01 |
| Voice Tuning | `voice_speed` | range slider 0.7–1.2, step 0.01 |
| Mix | `voice_use_speaker_boost` | checkbox |

### 9. The Workflow Editor TTS Picker

`src/app/workflows/[id]/edit/edit-form.tsx:389-401`:
```tsx
<SelectField
  id="tts_provider"
  label="TTS provider"
  value={values.tts_provider ?? NONE}
  options={[
    { value: "ai33",    label: "AI33" },
    { value: "genaipro", label: "GenAIPro" },
    { value: NONE,       label: "(none)" },
  ]}
  onChange={(v) => update("tts_provider", v === NONE ? null : v)}
/>
```

`NONE = "__none__"` is a UI sentinel for `null` (line 62). This option array is hardcoded and not derived from `TTS_PROVIDER_META`.

`src/app/workflows/workflows-table.tsx:351-356` displays the value as a "Voice" provider cell, rendering the raw string (`"ai33"`, `"genaipro"`, `"—"` for null) — no label mapping in the list view.

### 10. Schema-Endpoint Provider List (Derived)

`src/app/api/workflows/schema/route.ts:34` returns `tts: Object.keys(ttsProviders)` — the only place the provider list is **derived** from the registry rather than hardcoded. This route is used by the AI-skill workflow drafts importer (`domain-workflow-drafts`) for round-trip JSON validation.

### 11. Complete Hardcoded Edit Surface for `"ai33"` / `"genaipro"`

Every functional literal occurrence (excluding comments and prose):

| File | Line(s) | Content |
|------|---------|---------|
| `src/lib/workflows-schema.ts` | 27 | `tts_provider: z.enum(["ai33", "genaipro"]).nullable()` |
| `src/lib/tts/index.ts` | 8-9 | `{ ai33: ai33Provider, genaipro: genaiproProvider }` |
| `src/lib/tts/meta.ts` | 24-37 | `TTS_PROVIDER_META` keys with label / envKey / endpoint (and `TtsProviderId` derived at line 37) |
| `src/lib/tts/ai33.ts` | 318 | `TTS_PROVIDER_META.ai33.envKey` |
| `src/lib/tts/genaipro.ts` | 413 | `TTS_PROVIDER_META.genaipro.envKey` |
| `src/lib/db.ts` | 76 | `SeedWorkflow` type union: `"ai33" \| null` |
| `src/lib/db.ts` | 90, 107 | Built-in workflow seeds: `tts_provider: "ai33"` |
| `src/app/workflows/[id]/edit/edit-form.tsx` | 394-395 | Inline `<SelectField>` options |
| `.env.example` | 2-3 | `AI33_API_KEY=` and `GENAIPRO_API_KEY=` |
| `src/app/settings/tts-settings.tsx` | 327-328 | Speaker-boost copy: *"Both providers honour this flag"* — hardcoded count of two |

Auto-derived (no edit needed):
- `src/lib/tts/meta.ts:37` — `TtsProviderId = keyof typeof TTS_PROVIDER_META`.
- `src/app/api/workflows/schema/route.ts:34` — `tts: Object.keys(ttsProviders)`.

### 12. Tests Covering TTS

| File | Subject |
|------|---------|
| `__tests__/unit/lib/tts/meta.test.ts` | `TTS_PROVIDER_META` shape + `TtsProviderId` |
| `__tests__/unit/lib/tts/index.test.ts` | Registry + `getTtsProvider` throw on unknown |
| `__tests__/unit/lib/tts/ai33.test.ts` | AI33 submit/poll/download/cancel paths |
| `__tests__/unit/lib/tts/genaipro.test.ts` | GenAIPro submit/poll/subtitle/cancel paths |
| `__tests__/unit/worker/steps/voiceover.test.ts` | Step 06 glue |

### 13. Documentation Already in the Spec

`docs/histforge-spec.md` lines 11, 44, 123, 139-143, 275-281, 308, 350, 441-486, 983, 1044, 1082, 1129, 1165, 1178, 1191 cover TTS. Notable:

- **Line 1129** — workflow JSON example: `"tts_provider": "ai33",  // "ai33" | "genaipro" | null`
- **Line 1165** — modularity claim: *"`lib/tts/` — `TtsProvider` interface with `synthesize(text, outPath, opts)`. Provider registry selects by `snapshot.tts_provider` (snapshot-pinned per workflow). Currently: AI33, GenAIPro. Adding a provider = one new file + one registry entry."*

---

## Chatterbox Findings (Web Research)

### 14. What Chatterbox Is

Chatterbox is an open-source TTS model from **Resemble AI**, distributed primarily as a **Python library** on PyPI (`chatterbox-tts`) and on Hugging Face (`ResembleAI/chatterbox`). Three model variants exist:

- **ChatterboxTTS** (English, ~500M params, creative controls: `exaggeration`, `cfg_weight`).
- **ChatterboxMultilingualTTS** (23 languages with `language_id`).
- **ChatterboxTurboTTS** (~350M params, English only, low-latency, supports paralinguistic tags `[cough]`, `[laugh]`, `[chuckle]`).

Every output is watermarked by Resemble AI's **Perth** (Perceptual Threshold) Watermarker — imperceptible, survives MP3 compression and editing, ~100% detection accuracy. Watermark detection: `perth.PerthImplicitWatermarker().get_watermark(audio, sr)` returns `0.0` or `1.0`.

### 15. Python API (Official, First-Party)

```python
from chatterbox.tts import ChatterboxTTS
import torchaudio as ta

model = ChatterboxTTS.from_pretrained(device="cuda")  # or "cpu", "mps"
wav = model.generate(
    text="Your text here",
    audio_prompt_path="path/to/reference.wav",  # optional, ~10s reference for voice cloning
    exaggeration=0.5,   # 0.25–2.0, emotion intensity
    cfg_weight=0.5,     # 0.0–1.0, pace control
)
ta.save("output.wav", wav, model.sr)
```

Multilingual variant adds `language_id="fr"`, `language_id="zh"`, etc. across 23 codes (ar, da, de, el, en, es, fi, fr, he, hi, it, ja, ko, ms, nl, no, pl, pt, ru, sv, sw, tr, zh).

**Output**: PyTorch tensor; sample rate exposed as `model.sr`. Format on disk after `torchaudio.save` is **WAV**. The README does not state a fixed sample rate value.

**Voice cloning**: a single reference audio file path. Examples use `your_10s_ref_clip.wav` (a ~10-second clip). Format: any audio file `torchaudio` can load (WAV implied by examples). Language must match the synthesis language to avoid accent transfer.

### 16. No First-Party HTTP Server

The official `resemble-ai/chatterbox` repo ships only the Python library plus optional Gradio demo scripts (`gradio_tts_app.py`, `gradio_tts_turbo_app.py`) for a local web UI. **There is no first-party FastAPI / REST server.** Two community-maintained wrappers are widely used:

#### 16a. `devnen/Chatterbox-TTS-Server`

Default port **8004**. FastAPI with Swagger at `/docs`. Endpoints:

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/tts` | `CustomTTSRequest` JSON: `text`, `voice_mode` (`"predefined"` \| `"clone"`), `predefined_voice_id`, `reference_audio_filename`, `output_format` (`"wav"` \| `"opus"`), `split_text`, `chunk_size`, `temperature`, `exaggeration`, `cfg_weight`, `seed`, `speed_factor`, `language` | streaming `audio/wav` or `audio/opus` |
| POST | `/v1/audio/speech` | OpenAI-compat: `input`, `voice` (filename or `'S1'`/`'S2'`/`'dialogue'`), `response_format` (`"opus"` \| `"wav"`), `speed`, `seed` | streaming `audio/wav` or `audio/opus` |
| GET  | `/api/ui/initial-data` | — | config + file lists + presets |
| POST | `/save_settings` | settings | writes `config.yaml` |
| POST | `/reset_settings` | — | reset to defaults |
| GET  | `/get_reference_files` | — | lists `reference_audio/` dir |
| GET  | `/get_predefined_voices` | — | lists `voices/` dir |
| POST | `/upload_reference` | multipart | upload reference audio (.wav/.mp3) |
| POST | `/upload_predefined_voice` | multipart | upload predefined voice |

- **Synchronous**: response is the audio bytes (server can stream chunks but no submit/poll model).
- **Voice supply**: predefined voice (filename in `./voices/`) OR cloning reference (filename in `./reference_audio/`). Files are uploaded ahead of time, then referenced by filename in subsequent calls.
- **Output formats**: WAV or Opus. Sample rate configurable in `config.yaml` under `audio_output.sample_rate`.
- **No SRT or word-level timestamp output** anywhere in the documented surface.
- Python: requires **3.10** (3.11+ unsupported per the README).
- Hardware: NVIDIA CUDA 12.1 (RTX 20/30/40) or 12.8 (RTX 5090/Blackwell), AMD ROCm 6.4+ (Linux), Apple Silicon M1–M4 (macOS 12.3+), CPU fallback. ~10 GB disk recommended.
- Configuration: `config.yaml`, key `tts_engine.device` (`auto`/`cuda`/`mps`/`cpu`), `predefined_voices_path`, `reference_audio_path`, `default_voice_id`. Most config changes require restart.

#### 16b. `travisvn/chatterbox-tts-api`

Default port **4123**. FastAPI, OpenAI-compat. Endpoints:

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/v1/audio/speech` | JSON: `input`, `voice` (library name), `exaggeration` (0.25–2.0, default 0.5), `cfg_weight` (0.0–1.0, default 0.5), `temperature` (0.05–5.0, default 0.8), `stream_format` (`"audio"` \| `"sse"`) | binary `audio/wav` |
| POST | `/v1/audio/speech/upload` | multipart: `input`, `voice_file` (mp3/wav/flac/m4a/ogg, ≤10 MB), tuning params | binary `audio/wav` |
| POST | `/v1/audio/speech/stream` | JSON (same as `/speech`) | chunked `audio/wav` |
| POST | `/v1/audio/speech/stream/upload` | multipart (same as `/upload`) | chunked `audio/wav` |
| POST | `/voices` | multipart: `voice_file`, `voice_name`, `language` | success JSON |
| GET  | `/voices` | — | `[{ name, language? }]` |
| GET  | `/languages` | — | list of supported codes (22 entries listed) |
| GET  | `/health`, `/config`, `/status`, `/status/progress`, `/status/statistics`, `/status/history`, `/v1/models`, `/memory` | — | metadata / observability |
| GET  | `/docs`, `/redoc` | — | Swagger / ReDoc |

- **Synchronous** for non-stream endpoints: response body is the WAV bytes immediately. No submit/poll.
- **Voice cloning**: three modes — built-in default voice (`VOICE_SAMPLE_PATH` env), direct upload via multipart `voice_file`, or library by name (upload to `/voices` first, then pass `"voice"` in subsequent JSON calls).
- **Output**: WAV (RIFF/PCM, 16-bit). Sample rate not stated in the README.
- **No alignment, SRT, or word-level timestamp endpoint** documented.
- **Env vars**: `PORT=4123`, `USE_MULTILINGUAL_MODEL=true`, `VOICE_SAMPLE_PATH=./voice-sample.mp3`, `DEVICE=auto`, `MEMORY_CLEANUP_INTERVAL=5`, `CUDA_CACHE_CLEAR_INTERVAL=3`, `MAX_CHUNK_LENGTH`.
- **Hardware**: minimum 4 GB RAM; recommended 8 GB+ with NVIDIA CUDA. CPU-only supported but slower.
- Deployment: Docker Compose (standard, uv, GPU, CPU variants) or `uv run main.py` / `python main.py`.

### 17. Known Installation Issues

GitHub issue `resemble-ai/chatterbox#367` documents that `pip install chatterbox-tts` can fail due to a `pkuseg==0.0.25` dependency conflict; multiple users in `#243` reported the README install steps not working unmodified. Installing from source (`git clone … && pip install -e .`) is reported as more reliable. The official `resemble-ai/chatterbox` `pyproject.toml` pins dependency versions; its README states the library was developed and tested on **Python 3.11 / Debian 11**. (Note: this is the official library's environment; the `devnen/Chatterbox-TTS-Server` README in §16a separately requires Python 3.10 with 3.11+ unsupported — the two projects pin different versions.)

### 18. Differences vs Existing HistForge Providers (Factual)

| Aspect | `ai33` / `genaipro` | Chatterbox (community wrapper, e.g. `travisvn`) |
|--------|--------|-------------|
| Auth | API key via `xi-api-key` / `Bearer` header | No API key — local URL |
| Hosting | Remote SaaS | Local server (Python + GPU) |
| Async model | Submit + poll task_id | Synchronous response (audio in body) |
| Resume sidecar | Required (paid task; restart-safe) | Not needed (synchronous) |
| Output | MP3 — AI33 pinned at 44.1 kHz / 128 kbps via URL `output_format=mp3_44100_128`; GenAIPro returns whatever the provider URL produces (bitrate not documented) | WAV (sample rate from `model.sr`, not a documented constant; devnen wrapper supports Opus too) |
| Voice cloning | No (selects ElevenLabs `voice_id`) | Yes (reference WAV, ~10 s) |
| Transcripts | Optional SRT + JSON URLs | None at all |
| Watermark | None documented | Always-on Perth neural watermark |
| Hardware | None local | GPU strongly recommended; Python environment required (version pinned by the wrapper, not the HistForge worker) |

### 19. Notes on the `outMp3Path` Contract

The provider contract is `synthesize(text, outMp3Path, opts)` (`src/lib/tts/types.ts:13`) and step 06 always passes `audio/narration.mp3` (`src/worker/steps/06-voiceover.ts:37`). Both existing providers fetch a remote MP3 URL and write it directly to that path, so the on-disk format actually matches the parameter name. Chatterbox's wrapper servers return `audio/wav` (no MP3 endpoint documented in either community wrapper). Step 07 (align) reads from `audio/narration.mp3` (`src/worker/steps/07-align.ts:22`); `lib/align.ts` is invoked with that exact path.

## Code References

**Provider contract & registry**
- `src/lib/tts/types.ts:3-26` — `TtsResult`, `TtsProvider` interface
- `src/lib/tts/index.ts:7-18` — `ttsProviders` registry, `getTtsProvider`
- `src/lib/tts/meta.ts:24-37` — `TTS_PROVIDER_META`, `TtsProviderId`

**Provider implementations**
- `src/lib/tts/ai33.ts:75-88` — submit body shape (nested `voice_settings`)
- `src/lib/tts/ai33.ts:90-136` — submit + retry/backoff
- `src/lib/tts/ai33.ts:138-246` — poll loop with Zod validation + failure-counter
- `src/lib/tts/ai33.ts:257-297` — sidecar resume token read/write
- `src/lib/tts/ai33.ts:313-388` — `synthesize` orchestration
- `src/lib/tts/genaipro.ts:76-87` — submit body shape (flat)
- `src/lib/tts/genaipro.ts:89-134` — submit + retry/backoff
- `src/lib/tts/genaipro.ts:163-209` — `pollOnce` shared helper
- `src/lib/tts/genaipro.ts:267-337` — subtitle export (best-effort)
- `src/lib/tts/genaipro.ts:408-474` — `synthesize` orchestration

**Pipeline wiring**
- `src/worker/runner.ts:96-118` — queue tick
- `src/worker/pipeline.ts:242-258` — `readSnapshot`
- `src/worker/pipeline.ts:282-345` — `resolveDeps`
- `src/worker/pipeline.ts:302-306` — TTS provider conditional resolve
- `src/worker/pipeline.ts:179-197` — `buildStepContext`
- `src/worker/pipeline.ts:417` — step loop `buildStepContext` call
- `src/worker/steps/06-voiceover.ts:27-58` — `runVoiceover`
- `src/worker/steps/06-voiceover.ts:61-89` — `step` definition
- `src/worker/steps/07-align.ts:14-27` — alignment from MP3

**Workflow registry & schema**
- `src/types.ts:123-137` — `WorkflowRow`
- `src/types.ts:157-165` — `WorkflowSnapshot`
- `src/lib/workflows.ts:42-60` — `resolveSnapshot`
- `src/lib/workflows.ts:88-109` — `materializeStepList` (null-tts guard)
- `src/lib/workflows-schema.ts:21-38` — `WorkflowRowSchema`, `tts_provider` enum at line 27
- `src/lib/workflows-schema.ts:49-51` — `WorkflowPatchSchema`
- `src/lib/workflows-schema.ts:60` — `WorkflowImportSchema`

**Settings system**
- `src/lib/db.ts:11-48` — `DEFAULT_SETTINGS` (voice keys at 37-43)
- `src/lib/db.ts:70-117` — `SeedWorkflow` type + built-in seeds
- `src/lib/settings.ts:13-92` — `SETTING_SCHEMAS`
- `src/lib/settings.ts:105-117` — `getSetting`
- `src/lib/settings.ts:141-155` — `setSetting`
- `src/lib/settings-tabs.ts:48-56` — `"tts"` tab membership
- `src/lib/settings-enums.ts:33-38` — `voiceover_model_id` enum

**UI & API**
- `src/app/settings/tts-settings.tsx` — TTS panel (no provider picker)
- `src/app/settings/settings-form.tsx:161-163` — TTS tab mount
- `src/app/workflows/[id]/edit/edit-form.tsx:62` — `NONE` sentinel
- `src/app/workflows/[id]/edit/edit-form.tsx:389-401` — TTS provider `<SelectField>`
- `src/app/workflows/workflows-table.tsx:351-356, 514-541` — `ProviderCell`
- `src/app/api/workflows/schema/route.ts:34` — derived `tts: Object.keys(ttsProviders)`
- `src/app/api/workflows/route.ts:28-87` — POST workflow (uses `WorkflowRowSchema`)
- `src/app/api/workflows/[id]/route.ts:26-107` — PATCH (uses `WorkflowPatchSchema`)
- `src/app/api/workflows/validate/route.ts:15-21` — validate (picks fields from `WorkflowRowSchema`)
- `src/lib/workflows-import.ts:48-127` — drafts importer (uses `WorkflowImportSchema`)

**Env / docs**
- `.env.example:2-3` — `AI33_API_KEY`, `GENAIPRO_API_KEY`
- `docs/histforge-spec.md:139-143, 275-281, 441-486, 983, 1129, 1165` — TTS spec sections

**Tests**
- `__tests__/unit/lib/tts/meta.test.ts`
- `__tests__/unit/lib/tts/index.test.ts`
- `__tests__/unit/lib/tts/ai33.test.ts`
- `__tests__/unit/lib/tts/genaipro.test.ts`
- `__tests__/unit/worker/steps/voiceover.test.ts`

## Architecture Patterns Found

1. **Provider registry by string key.** A plain `Record<string, TtsProvider>` keyed by the workflow column value. Lookup throws on miss with the offending key in the message.

2. **Per-workflow provider, frozen per-video.** `workflows.tts_provider` (string nullable) is copied into `videos.workflow_snapshot.tts_provider` at queue time. The pipeline reads the snapshot, never the live workflow row.

3. **Two-source-of-truth split for the provider list.** `TTS_PROVIDER_META` is the operator-facing roster (label/envKey/endpoint) and the type root. The workflow editor's `<SelectField>` and the Zod enum in `workflows-schema.ts` are kept narrow and edited by hand. The schema route (`/api/workflows/schema`) derives its tts list from `Object.keys(ttsProviders)` for the AI-skill drafts importer.

4. **Settings vs workflow split.** Voice tuning (id, model, sliders, boost) lives globally in `settings`. Provider choice lives per-workflow on `workflows.tts_provider`. Providers read settings inside `synthesize`, not from the StepContext.

5. **Submit + poll + sidecar resume.** Both existing providers target async remote tasks. The `audio/.tts_task_id` sidecar is the resume token; declared in `step.outputs` for failure-cleanup, excluded from `step.produces` because nothing downstream consumes it.

6. **Bounded poll-failure counters.** `MAX_CONSECUTIVE_POLL_FAILURES = 60` (~30 minutes at 30 s) for both providers. Schema validation via Zod on every poll body; mismatches count toward failure budget rather than aborting immediately.

7. **`AbortSignal` threading.** `opts.signal` is forwarded to every `fetch` call and checked at every `throwIfAborted(signal)` point in the loop. Cancellation is treated as terminal — does not consume retry budget.

8. **Step glue with no settings access.** `06-voiceover.ts` reads only the script path and calls `provider.synthesize`; no settings lookups happen at the step level. The orchestrator-resolved provider is the only abstraction the step sees.

9. **Alignment is provider-independent.** Step 07 produces `alignment/alignment.json` from MP3 + script via aeneas. Provider-supplied SRT/JSON transcripts are written to `audio/narration.srt` and `audio/narration.json` but not consumed by step 07.

10. **Auto-derived types from `as const` literals.** `TtsProviderId = keyof typeof TTS_PROVIDER_META`, `SCRIPT_STEP_NAMES` derived from `REAL_STEPS.filter(...)`, `tts: Object.keys(ttsProviders)` in the schema route. The Zod enum in `workflows-schema.ts:27` is the only manually-narrowed list.

## Sources

- [resemble-ai/chatterbox (GitHub)](https://github.com/resemble-ai/chatterbox) — official Python library
- [chatterbox-tts on PyPI](https://pypi.org/project/chatterbox-tts/) — pip distribution
- [ResembleAI/chatterbox (Hugging Face)](https://huggingface.co/ResembleAI/chatterbox) — model + API discussions
- [Chatterbox: Open Source Text-to-Speech | Resemble AI](https://www.resemble.ai/chatterbox/) — vendor overview
- [devnen/Chatterbox-TTS-Server (GitHub)](https://github.com/devnen/Chatterbox-TTS-Server) — community FastAPI wrapper, port 8004
- [travisvn/chatterbox-tts-api (GitHub)](https://github.com/travisvn/chatterbox-tts-api) — community OpenAI-compat FastAPI wrapper, port 4123
- [chatterbox-tts-api API_README.md](https://github.com/travisvn/chatterbox-tts-api/blob/main/docs/API_README.md) — API reference
- [TSavo/chatterbox-tts-api (GitHub)](https://github.com/TSavo/chatterbox-tts-api) — alternative FastAPI wrapper
- [Open WebUI integration docs](https://docs.openwebui.com/features/chat-conversations/audio/text-to-speech/chatterbox-tts-api-integration/) — integration guidance
- [resemble-ai/chatterbox#367](https://github.com/resemble-ai/chatterbox/issues/367) — `pkuseg` install issue
- [resemble-ai/chatterbox#243](https://github.com/resemble-ai/chatterbox/issues/243) — install repro report
