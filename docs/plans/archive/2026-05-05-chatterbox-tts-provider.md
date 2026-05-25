# Chatterbox TTS Provider

## Overview

Add **Chatterbox** as a third TTS provider alongside `ai33` and `genaipro`. Chatterbox is Resemble AI's open-source TTS model with zero-shot voice cloning; it runs locally over HTTP via the `devnen/Chatterbox-TTS-Server` wrapper (FastAPI, MIT license, default port 8004, WAV/Opus output). Unlike the existing two SaaS providers, it has **no API key**, **no submit/poll task model**, and returns audio synchronously — but emits **WAV** rather than MP3 and offers no SRT/JSON transcripts. The provider transcodes WAV→MP3 inline via piped ffmpeg so the existing `synthesize(text, outMp3Path, opts)` contract is preserved.

The HistForge provider talks to the wrapper's custom **`POST /tts`** endpoint (not the OpenAI-compat `/v1/audio/speech`). `/tts` separates predefined-voice and clone-reference selection into distinct request fields (`voice_mode`, `predefined_voice_id`, `reference_audio_filename`), which makes the `chatterbox_voice_mode` setting load-bearing rather than hopeful. The speed parameter on `/tts` is named `speed_factor` (not `speed`); HistForge maps the existing `voice_speed` setting onto it.

A companion operator-facing install guide (`docs/setup-guides/setup-chatterbox.md`) walks the user through installing Python 3.10, NVIDIA CUDA, the devnen wrapper, and verifying the local server before HistForge points at it. The closest existing pattern in the repo is `docs/setup-guides/setup-google-flow.md` (the only other operator-facing local-service setup doc currently in `docs/`).

## Current State

- **Provider contract**: `TtsProvider.synthesize(text, outMp3Path, opts)` — `src/lib/tts/types.ts:10-26`. `TtsResult.transcripts` is optional (alignment is provider-independent — `src/worker/steps/07-align.ts:22-26`).
- **Registry**: `src/lib/tts/index.ts:7-18` — plain `Record<string, TtsProvider>` keyed by snapshot value. Throws `Unknown TTS provider: "<id>"` on miss.
- **Metadata**: `src/lib/tts/meta.ts:24-37` — `TTS_PROVIDER_META` is the single source of truth for label / envKey / endpoint and the type root for `TtsProviderId = keyof typeof TTS_PROVIDER_META`. The schema-route `/api/workflows/schema` derives `tts: Object.keys(ttsProviders)` (`src/app/api/workflows/schema/route.ts:34`); other consumers (workflow editor dropdown, `WorkflowRowSchema.tts_provider` enum) are hand-maintained narrow lists.
- **Provider patterns**: Both existing providers do submit + poll + sidecar resume against ElevenLabs-compatible APIs. Reference implementations: `src/lib/tts/ai33.ts:313-388` (nested `voice_settings` body), `src/lib/tts/genaipro.ts:408-474` (flat body, separate subtitle export). Chatterbox is **synchronous** — no submit/poll, no sidecar.
- **Snapshot-pinning**: `tts_provider` is selected per workflow row (`src/lib/workflows-schema.ts:27`), pinned into `videos.workflow_snapshot.tts_provider` at queue time, resolved by `resolveDeps` from the snapshot (`src/worker/pipeline.ts:282-345`). The 2026-05-05-tts-provider-snapshot-pin plan removed the global `tts_provider` setting; nothing else needs to change at the orchestrator level.
- **Step 06**: `src/worker/steps/06-voiceover.ts:61-89` — thin glue, only consumes `ctx.ttsProvider`. Its `outputs` lists `audio/.tts_task_id` for cleanup (used by ai33 / genaipro sidecars). Chatterbox doesn't write a sidecar; the entry stays harmless because `rmSync(..., { force: true })` no-ops on a missing file.
- **Settings system**: per-key Zod schemas in `src/lib/settings.ts:13-92`; defaults seeded by `src/lib/db.ts:11-48`; enum-typed keys catalogued in `src/lib/settings-enums.ts:22-45`; per-tab membership in `src/lib/settings-tabs.ts:48-56`.
- **Settings UI**: `src/app/settings/tts-settings.tsx` renders Voice & Model + Voice Tuning + Mix sections, no provider switcher. Speaker-boost copy at line 327-328 hardcodes "Both providers honour this flag" — needs updating with a third provider.
- **Workflow editor**: `src/app/workflows/[id]/edit/edit-form.tsx:389-401` — TTS provider `<SelectField>` with hand-maintained options.
- **Voice tuning settings**: `voice_id`, `voiceover_model_id`, `voice_stability`, `voice_similarity`, `voice_style`, `voice_speed`, `voice_use_speaker_boost` — global, ElevenLabs-shaped. Chatterbox cannot consume `voice_id`/`voiceover_model_id`/`voice_stability`/`voice_similarity`/`voice_style`/`voice_use_speaker_boost`. It **can** map `voice_speed` → its `speed_factor` parameter on `/tts`. The existing slider range (0.7–1.2 per `src/lib/settings.ts:74`) is treated as an assumption — the wrapper's `config.yaml` clamps `speed_factor` itself, and any out-of-range value will be coerced server-side, not rejected at this layer.
- **Existing research note**: `docs/research/2026-05-05-chatterbox-tts-provider.md` documents the wrapper API surface, request shape, license matrix, watermarking, and install issues. Treat it as the canonical reference for wire-format details.

## Scope

**Doing**:
- Operator install guide (`docs/setup-guides/setup-chatterbox.md`) covering Windows + NVIDIA + Python 3.10 + devnen Chatterbox-TTS-Server setup.
- Three new settings keys (`chatterbox_base_url`, `chatterbox_voice_mode`, `chatterbox_voice_filename`) with schemas, defaults, and tab membership.
- New `lib/tts/chatterbox.ts` provider — synchronous HTTP, WAV→MP3 transcode via piped ffmpeg, AbortSignal threading.
- Registry registration + `TTS_PROVIDER_META` entry.
- `WorkflowRowSchema.tts_provider` enum widened to include `"chatterbox"`.
- Workflow editor dropdown adds the option.
- TTS settings panel gains a Chatterbox section; speaker-boost copy updated.
- Spec doc updates (`docs/histforge-spec.md`).
- Unit tests per task (RED→GREEN→REFACTOR via `/implement-plan-tdd`).

**Not doing**:
- Voice library management UI in HistForge (upload, list, delete reference clips). Operator manages voices via devnen's own web UI at `http://127.0.0.1:8004`.
- Exposing exaggeration / cfg_weight / temperature / seed as settings — defaults are sensible for narration. Surface later if requested.
- Supporting the multilingual model variant (`USE_MULTILINGUAL_MODEL`) — defaults to English. Document the env-var on the wrapper side; HistForge stays language-agnostic.
- Removing or hiding the ElevenLabs-only voice tuning sliders when Chatterbox is selected. Settings are global; the panel cannot know which provider a video will use. Sliders stay visible; copy clarifies which providers honour each one.
- Switching to the AGPL-licensed `travisvn/chatterbox-tts-api` wrapper.
- Adding MP3 endpoint detection or output-format negotiation. Always request WAV from the wrapper, always transcode locally.
- Migrating existing snapshots / videos. The new provider is opt-in per workflow.

## Tasks

### Phase 0: Operator install guide

- [x] **Task 0.1: Author `docs/setup-guides/setup-chatterbox.md`**
  **Files**: `docs/setup-guides/setup-chatterbox.md` (new)
  **What**: Self-contained Windows setup guide so the operator can get the Chatterbox server running before any HistForge code change is even merged. Mirror the structure of `docs/setup-guides/setup-google-flow.md` (the only operator-facing local-service setup doc currently in `docs/` — `setup-comfyui.md` is referenced from CLAUDE.md/README.md but does not exist on disk). Cover:
  - **Hardware**: NVIDIA GPU strongly recommended (CUDA 12.1+); ~10 GB disk for deps + model cache; ~8 GB RAM minimum.
  - **Prerequisites**: Python **3.10** strictly (devnen wrapper README requires 3.10 and rejects 3.11+); current NVIDIA driver; git; ffmpeg already on PATH (HistForge uses it for the WAV→MP3 transcode and for step 14 render).
  - **Install**: clone `https://github.com/devnen/Chatterbox-TTS-Server`, run `start.bat` on Windows (auto-creates venv, installs `requirements-nvidia.txt`, downloads weights from Hugging Face on first generation). Document the alternative manual path (create venv, `pip install -r requirements-nvidia.txt`, `python server.py`) for users who want to inspect what `start.bat` does.
  - **Verify**: server listens on `http://127.0.0.1:8004`; Swagger docs at `/docs`; web UI at `/`. Test a minimal `POST /tts` with a curl example using the predefined-voice path (the same endpoint HistForge calls — keeps the smoke test on the same wire format).
  - **Voice supply**: predefined voices live in `voices/` (filename like `Abigail.wav`), reference clones in `reference_audio/`. Operator uses the web UI's upload buttons or drops files directly into either directory. Reference clips ~10 s, mono WAV preferred.
  - **HistForge integration**: Settings → TTS → set `chatterbox_base_url` (default `http://127.0.0.1:8004`), `chatterbox_voice_mode` (`predefined` or `clone`), `chatterbox_voice_filename` (e.g. `Abigail.wav`). Workflow editor → set the workflow's TTS provider to "Chatterbox".
  - **Troubleshooting** (devnen-wrapper-specific failure modes — do **not** copy `pkuseg` notes from research §17; that issue is for direct `pip install chatterbox-tts` against the upstream library, not the devnen wrapper which pins its deps in `requirements-nvidia.txt`):
    - GPU not detected: check `nvidia-smi`, CUDA driver vs PyTorch CUDA build, `tts_engine.device` in `config.yaml`.
    - Port 8004 already in use: change `server.port` in `config.yaml` and update `chatterbox_base_url` in HistForge to match.
    - First-generation latency: model weights download from Hugging Face on the first call (~2 GB). Subsequent calls are fast.
    - Python version conflicts: the wrapper hard-requires 3.10; create a dedicated venv to avoid colliding with system Python.
    - `start.bat` exits silently: most often a missing Python 3.10 launcher; verify `py -3.10 --version` first.
  - **License & watermark caveat**: MIT for the wrapper, MIT for the model; every output carries Resemble AI's Perth perceptual watermark per `docs/research/2026-05-05-chatterbox-tts-provider.md` §14. Note this in a short callout — operators should know the rendered narration carries an inaudible watermark.
  **Context**: Pattern to mirror — `docs/setup-guides/setup-google-flow.md`. Source material — `docs/research/2026-05-05-chatterbox-tts-provider.md` §16a (devnen wrapper API surface). Don't duplicate the research doc; the guide is operator-facing (commands, screenshots-style steps), the research doc is internal reference.

### Phase 1: Provider end-to-end (vertical slice — runs on a SQL-edited workflow)

- [x] **Task 1.1: Add three Chatterbox settings keys**
  **Files**: `src/lib/settings.ts`, `src/lib/db.ts`, `src/lib/settings-enums.ts`, `src/lib/settings-tabs.ts`, `__tests__/unit/lib/settings.test.ts`
  **What**: Three new keys, all on the `"tts"` settings tab:
  - `chatterbox_base_url`: plain `z.string()` schema; default `"http://127.0.0.1:8004"` (mirrors `comfyui_base_url` at `db.ts:15`).
  - `chatterbox_voice_mode`: `z.enum(ENUM_VALUES.chatterbox_voice_mode)`; values `["predefined", "clone"]`; default `"predefined"`. Add the entry to `ENUM_VALUES` at `settings-enums.ts:22-45`. Add a matching `SETTING_OPTION_LABELS.chatterbox_voice_mode` block (`"predefined": "Predefined voice"`, `"clone": "Clone reference"`) so the Select renders human-readable labels — required, not optional, to match the friendly-label pattern of `enrich_chunks_llm_provider` and `google_flow_image_model` at `settings-enums.ts:70-87`.
  - `chatterbox_voice_filename`: `z.string()`; default `""` (operator must fill in via Settings).
  Append the three keys to `TAB_FIELDS["tts"]` at `settings-tabs.ts:48-56` so they render on the TTS tab. Update `__tests__/unit/lib/settings.test.ts` assertions about seed/default counts and key presence.
  **Context**: Settings naming pattern mirrors `comfyui_base_url` / `comfyui_workflow_path` (provider-prefixed keys). Schema docs — `src/lib/settings.ts:13-92` (per-key schemas with `z.coerce` / `z.enum`). Enum-array source of truth — `src/lib/settings-enums.ts:22-45`. The TAB_FIELDS membership drives which tab renders the unsaved-change indicator (`src/lib/settings-tabs.ts:18`). Edge case: `chatterbox_voice_filename` defaults to empty string per the existing pattern for required-but-unset keys (`voice_id`, `model_name` — `db.ts:9, 12, 37`).

- [x] **Task 1.2: Register Chatterbox in `TTS_PROVIDER_META`**
  **Files**: `src/lib/tts/meta.ts`, `__tests__/unit/lib/tts/meta.test.ts`
  **What**: Add `chatterbox` to the `TTS_PROVIDER_META` object (`meta.ts:24-37`):
  - `label: "Chatterbox"`
  - `envKey: ""` (no API key — the provider must NOT throw on a missing env-var; it reads `chatterbox_base_url` from settings instead). Document the empty-string convention in the source comment block at `meta.ts:1-16`.
  - `endpoint: "127.0.0.1:8004"` (operator-facing; reflects the default base URL).
  Mirror the existing `meta.test.ts` cases (`__tests__/unit/lib/tts/meta.test.ts:5-15`) with a `chatterbox` block asserting label/envKey/endpoint. The `TtsProviderId = keyof typeof TTS_PROVIDER_META` derivation (`meta.ts:37`) auto-includes the new key — confirm by checking that `Object.keys(TTS_PROVIDER_META).length === 3` in the test.
  **Context**: The `envKey` field is consumed by both providers as `process.env[TTS_PROVIDER_META.<id>.envKey]` (`ai33.ts:318`, `genaipro.ts:413`). The Chatterbox provider must NOT do that lookup at all; this is the deviation point from the SaaS pattern. The source comment block at `meta.ts:1-16` explains that the registry is the canonical roster — keep the explanatory comment current.

- [x] **Task 1.3: WAV→MP3 transcode helper**
  **Files**: `src/lib/tts/chatterbox-transcode.ts` (new), `__tests__/unit/lib/tts/chatterbox-transcode.test.ts` (new)
  **What**: A small standalone helper that takes a `Buffer` of WAV bytes plus an output MP3 path and runs ffmpeg via piped stdin, no temp file. Signature: `wavBytesToMp3(wavBytes: Buffer, outMp3Path: string, opts?: { signal?: AbortSignal; ffmpegPath?: string }): Promise<void>`.
  Behavior — mirror the canonical in-repo ffmpeg-spawn pattern at `src/worker/steps/14-render.ts:34-63` (`buildFfmpegExec`), differing only in the args (encoder flags) and the stdin pipe:
  - `throwIfAborted(opts.signal)` upfront (from `src/worker/cancellation.ts:113`).
  - `mkdirSync(dirname(outMp3Path), { recursive: true })` so the audio dir exists.
  - `spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-codec:a", "libmp3lame", "-q:a", "2", outMp3Path], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true, signal: opts.signal })`. **Pass `signal` directly to `spawn`** — Node's signal-aware spawn handles SIGTERM (POSIX) / kill (Windows) and surfaces an `AbortError` automatically. Do NOT wire a manual `signal.addEventListener("abort", ...)` listener; that duplicates what Node already does and diverges from the `14-render.ts:39-43` pattern.
  - Pipe `wavBytes` to `child.stdin`, then `child.stdin.end()`.
  - Capture stderr into a capped buffer (`64 * 1024` cap, last-3-lines tail) exactly as in `14-render.ts:44-58`. Reject with `ffmpeg WAV→MP3 exited with code=<n>: <tail>` on non-zero exit.
  - On `child.on("error", ...)` — propagate the error, then check `isAbortError(err)` (from `src/worker/cancellation.ts:95`) so the caller can distinguish cancellation from a real ffmpeg failure.
  Tests: mock `child_process.spawn` to construct a small EventEmitter-shaped fake stub. Cover: success, ffmpeg non-zero exit (assert tail is included in the rejection message), `signal.aborted` upfront, signal aborted mid-run (assert AbortError surfaces). A real-ffmpeg integration test is out of scope — `__tests__/unit/worker/steps/render.test.ts` exists but mocks the `exec` injection point rather than running ffmpeg itself, so there is no precedent for a real-ffmpeg unit test in this repo.
  **Context**: ffmpeg is a known dependency (used by `lib/render.ts` for video render). Helper kept deliberately tiny + isolated so the chatterbox provider's main logic stays focused on HTTP. Don't fold this into `lib/render.ts` — keep TTS concerns under `lib/tts/`.

- [x] **Task 1.4: Implement `lib/tts/chatterbox.ts`**
  **Files**: `src/lib/tts/chatterbox.ts` (new), `__tests__/unit/lib/tts/chatterbox.test.ts` (new)
  **What**: A `TtsProvider` whose `synthesize(text, outMp3Path, opts)` does:
  1. Read settings: `chatterbox_base_url`, `chatterbox_voice_mode`, `chatterbox_voice_filename`, `voice_speed`. No API key, no env-var lookup.
  2. Validate `chatterbox_voice_filename` is non-empty — throw with a clear "set Chatterbox voice filename in Settings → TTS" message (paralleling the AI33 voice_id check pattern, `ai33.ts:329`).
  3. **POST to `${baseUrl}/tts`** (the wrapper's custom endpoint — chosen over `/v1/audio/speech` because the predefined-vs-clone selection is explicit on `/tts`, which makes `chatterbox_voice_mode` load-bearing rather than an unused setting). Body shape per `docs/research/2026-05-05-chatterbox-tts-provider.md` §16a:
     ```json
     {
       "text": "<text>",
       "voice_mode": "<chatterbox_voice_mode>",
       "predefined_voice_id": "<filename when voice_mode==='predefined'; else omit>",
       "reference_audio_filename": "<filename when voice_mode==='clone'; else omit>",
       "output_format": "wav",
       "speed_factor": <voice_speed as number>
     }
     ```
     **Do not send** `temperature`, `exaggeration`, `cfg_weight`, or `seed` — by omitting them the request inherits whatever defaults the wrapper has in `config.yaml`. This keeps HistForge from baking magic numbers it can't justify, and keeps the request body minimal.
  4. Pass `opts.signal` to `fetch`. Call `throwIfAborted(opts.signal)` (`src/worker/cancellation.ts:113`) before the call. Wrap the `fetch` in try/catch and re-throw via `isAbortError(err)` (`src/worker/cancellation.ts:95`) so an aborted request surfaces as `AbortError`, not a generic network error — same pattern as `genaipro.ts:175-178`.
  5. On non-2xx: throw `Chatterbox synthesize ${status}: ${body}`. No retry — the wrapper is local; transient HTTP errors usually mean the server is down, retrying won't help in the seconds the worker has.
  6. Read the response as `Buffer.from(await response.arrayBuffer())` (WAV bytes).
  7. Call `wavBytesToMp3(wavBytes, outMp3Path, { signal: opts.signal })` from Task 1.3.
  8. Return `{}` (no transcripts — Chatterbox has none, alignment runs in step 07 from the MP3).

  Tests (mock `fetch`, real settings + in-memory DB + tmp dir, mock the transcode helper from Task 1.3 since it's its own unit):
  - Predefined-mode happy path: assert request body has `voice_mode: "predefined"`, `predefined_voice_id: <filename>`, no `reference_audio_filename`. Assert transcode is called with the WAV bytes + outMp3Path.
  - Clone-mode happy path: assert request body has `voice_mode: "clone"`, `reference_audio_filename: <filename>`, no `predefined_voice_id`.
  - Body never includes `temperature` / `exaggeration` / `cfg_weight` / `seed` (assert keys are absent).
  - Empty `chatterbox_voice_filename` throws a clear error before any HTTP call.
  - HTTP error throws with status + body in the message.
  - AbortSignal aborted before fetch — throws AbortError, no transcode call.
  - AbortSignal aborted mid-fetch — `fetch` rejects with AbortError, no transcode call.

  **Context**: Provider patterns to mirror (only the `synthesize` shape, not the submit/poll/sidecar machinery — none of that applies):
  - Settings reads — `genaipro.ts:421-423` style (`getSetting` pulls inside synthesize).
  - AbortSignal threading — `genaipro.ts:175-178, 234-237` (passed to fetch + checked at boundaries + `isAbortError` to avoid swallowing aborts as generic errors).
  - Error messages — `<Provider> <verb> <status>: <body>` format mirrors `ai33.ts:117`, `genaipro.ts:114`.
  - File layout — `lib/tts/chatterbox.ts` exports `chatterboxProvider: TtsProvider = { synthesize }` (mirrors `ai33.ts:388`, `genaipro.ts:476`).
  Edge case: the wrapper streams long generations chunked. For the `/tts` endpoint with `output_format: "wav"` the body is a complete WAV — `arrayBuffer()` collects it fully. Don't try to stream-encode to MP3 incrementally; collect-then-transcode is fine for narration-length output (a 5-min chapter at 24 kHz mono WAV ≈ 14 MB, well within memory).

- [x] **Task 1.5: Register Chatterbox in the registry**
  **Files**: `src/lib/tts/index.ts`, `__tests__/unit/lib/tts/index.test.ts`
  **What**: Add `chatterbox: chatterboxProvider` to the `ttsProviders` record at `index.ts:7-10`. Update the registry test to assert `getTtsProvider("chatterbox")` returns a non-null provider with a `synthesize` function. Confirm the throw-on-unknown test still passes (it should — adding a key doesn't change miss behavior).
  **Context**: This is the atom that flips the schema route's `tts: Object.keys(ttsProviders)` (`src/app/api/workflows/schema/route.ts:34`) — the AI-skill drafts importer (`domain-workflow-drafts`) immediately recognizes `"chatterbox"` as a valid provider after this edit. The hand-maintained Zod enum (Task 1.6) and the workflow editor dropdown (Task 2.1) still need separate updates because they don't derive from the registry.

- [x] **Task 1.6: Widen `WorkflowRowSchema.tts_provider` enum**
  **Files**: `src/lib/workflows-schema.ts`, `__tests__/unit/lib/workflows-schema.test.ts`
  **What**: Change `tts_provider: z.enum(["ai33", "genaipro"]).nullable()` at `workflows-schema.ts:27` to `z.enum(["ai33", "genaipro", "chatterbox"]).nullable()`. This unblocks creating / patching / importing workflows with `tts_provider: "chatterbox"` via the API. Add a test case in the existing `__tests__/unit/lib/workflows-schema.test.ts` asserting the new value parses successfully.
  **Context**: The schema is consumed by `POST /api/workflows`, `PATCH /api/workflows/:id`, the validate route, and the drafts importer (`src/lib/workflows-import.ts:48-127`). After this edit, the drafts importer accepts `chatterbox` because the schema-route check (`Object.keys(ttsProviders)`) and the row schema both allow it.

- [x] **Task 1.7: Add Chatterbox to the workflow editor dropdown**
  **Files**: `src/app/workflows/[id]/edit/edit-form.tsx`, `__tests__/components/workflows/edit-form.test.tsx`
  **What**: Append `{ value: "chatterbox", label: "Chatterbox" }` to the inline `options` array of the TTS-provider `<SelectField>` at `edit-form.tsx:393-396`. Update the existing edit-form test to assert the option renders.
  **Context**: This option list is hand-maintained per the comment at `src/lib/tts/meta.ts:1-16`. Ordering: keep `ai33`, `genaipro`, then `chatterbox`, then the `(none)` sentinel. The list view (`src/app/workflows/workflows-table.tsx:351-356`) renders the raw provider string, so no edit needed there. **Folded into Phase 1** so end-of-phase is a true vertical slice: an operator can pick "Chatterbox" in the workflow editor, save the workflow, queue a video against it, and the pipeline runs without any SQL surgery or JSON-import workaround.

### Phase 2: Settings panel UI + spec docs

- [x] **Task 2.1: Add Chatterbox section to the TTS settings panel**
  **Files**: `src/app/settings/tts-settings.tsx`, `__tests__/components/settings/settings-form.test.tsx`
  **What**: Add a new section (using the existing `<Section>` primitive at `tts-settings.tsx:141-169`) titled "Chatterbox" with an appropriate `lucide-react` icon (e.g. `Server` or `Cpu`). Inside, render three controls in the same visual rhythm as the existing fields:
  - `chatterbox_base_url` — `<Input>` text field, monospace (mirror `voice_id` at lines 40-48).
  - `chatterbox_voice_mode` — `<Select>` driven by `enumOptions("chatterbox_voice_mode")` (mirror `voiceover_model_id` at lines 49-73).
  - `chatterbox_voice_filename` — `<Input>` with placeholder `"e.g. Abigail.wav"` and a small helper line below (`<p>` matching the existing field-shell convention) explaining "Filename in the Chatterbox server's `voices/` (predefined) or `reference_audio/` (clone) directory." The helper text is the only place the operator learns the on-disk semantics — keep it short.
  Update the Mix section's speaker-boost copy at `tts-settings.tsx:326-329` from "Both providers honour this flag" to a phrasing accurate with three providers (e.g. "Honoured by AI33 and GenAIPro; Chatterbox ignores it.").
  Update the field-rendering test at `__tests__/components/settings/settings-form.test.tsx:289-313` (currently "renders all seven TTS fields when the TTS tab is active"): rename to "renders all ten TTS fields…", assert the three new fields render, and add `chatterbox_base_url` / `chatterbox_voice_mode` / `chatterbox_voice_filename` to the `initialSettings` fixture.
  **Context**: User design taste (auto-memory) — favors simplistic, scannable layouts and "derive-don't-duplicate inputs". Keep the new section visually parallel to "Voice Tuning" and "Mix" so it feels native. The existing tuning sliders (stability/similarity/style) stay on-screen unconditionally — operators selecting Chatterbox simply don't fill them in. Avoid hiding fields based on which provider is "active" because Settings is global, not per-workflow; we can't know. A single-line note inside or above the existing "Voice Tuning" section ("Honoured by AI33 / GenAIPro; Chatterbox uses its own params.") is acceptable if it doesn't clutter the panel.

- [x] **Task 2.2: Spec doc updates**
  **Files**: `docs/histforge-spec.md`
  **What**: Widen every spec site that hard-codes `"ai33" | "genaipro"` (or names them in prose) to include Chatterbox. Verified sites from `grep -n 'tts_provider\|ai33\|genaipro\|AI33\|GenAIPro' docs/histforge-spec.md`:
  - **Line 44** — architecture diagram: `│ ├─► AI33 / GenAIPro API (TTS, ElevenLabs-compat) │`. Replace with phrasing that covers the two ElevenLabs-compat SaaS providers AND a local HTTP service. Chatterbox is **not** ElevenLabs-compat.
  - **Lines 142-143** — file tree under `lib/tts/` lists only `ai33.ts` / `genaipro.ts`. Add `chatterbox.ts` and the new `chatterbox-transcode.ts` from Task 1.3.
  - **Lines 311-312** — output tree comments call `narration.srt` / `narration.json` "AI33 transcript". Add a one-line caveat that Chatterbox produces neither (alignment falls back to step 07's aeneas pass).
  - **Lines 441-443** — section 8 header "## 8. Voiceover (`voiceover`) — AI33" and lede "AI33 is an ElevenLabs-compatible TTS cloud API." Both must widen. Suggested approach: keep the AI33 wire-protocol section (449-486) intact as the canonical AI33 reference, but split the section header to reflect that the step has multiple provider implementations, and add a short "Chatterbox" sibling sub-section that documents the `/tts` endpoint, the WAV→MP3 transcode, and the Perth watermark caveat.
  - **Line 983** — TTS settings list enumerates only the seven `voice_*` keys. Add `chatterbox_base_url`, `chatterbox_voice_mode`, `chatterbox_voice_filename`; note `voice_speed` is shared with Chatterbox (mapped to `speed_factor` on `/tts`).
  - **Line 1037** — `.env` key list. **No new entry needed** — Chatterbox has no env vars. Add a one-line comment such as `# Chatterbox runs locally — configure URL and voice in Settings → TTS, not env.`
  - **Line 1129** — workflow JSON example: `"tts_provider": "ai33",  // "ai33" | "genaipro" | null` → add `chatterbox` to the union.
  - **Line 1165** — modularity claim: *"`lib/tts/` — `TtsProvider` interface… Currently: AI33, GenAIPro."* → add Chatterbox; note local providers may have empty `envKey` (no API key).
  - **Line 1191** — pipeline summary "AI33 TTS step (voiceover via provider registry)" → widen (e.g. "TTS step (voiceover via provider registry — AI33 / GenAIPro / Chatterbox)").
  In the Chatterbox sub-section (or an inline bullet), add a one-line note that **every output carries Resemble AI's Perth perceptual watermark** so this fact appears in the canonical spec, not only in the operator install guide.
  Add a Troubleshooting / Setup bullet pointing operators at `docs/setup-guides/setup-chatterbox.md`.
  **Context**: Spec is the canonical reference per CLAUDE.md. Drift between code and spec on the provider list is the same class of bug the snapshot-pin plan called out (`docs/plans/2026-05-05-tts-provider-snapshot-pin.md` Task 3 rationale). Keep edits surgical — fact changes, not a rewrite.

## References

**Provider contract & registry**
- `src/lib/tts/types.ts:10-26` — `TtsProvider`, `TtsResult`
- `src/lib/tts/index.ts:7-18` — registry
- `src/lib/tts/meta.ts:24-37` — `TTS_PROVIDER_META`, `TtsProviderId`

**Reference implementations**
- `src/lib/tts/genaipro.ts:408-474` — closest analog for shape (synthesize entry, settings reads, AbortSignal threading)
- `src/lib/tts/ai33.ts:313-388` — submit/poll/sidecar (NOT the pattern Chatterbox uses; included as the divergence reference)

**Pipeline wiring (no changes needed — already snapshot-pinned)**
- `src/worker/pipeline.ts:282-345` — `resolveDeps` resolves provider from snapshot
- `src/worker/steps/06-voiceover.ts:61-89` — step 06 only consumes `ctx.ttsProvider`

**Settings system**
- `src/lib/settings.ts:13-92` — per-key Zod schemas
- `src/lib/db.ts:11-48` — DEFAULT_SETTINGS
- `src/lib/settings-enums.ts:22-45, 70-87` — `ENUM_VALUES`, `SETTING_OPTION_LABELS`, `enumOptions`
- `src/lib/settings-tabs.ts:48-56` — `TAB_FIELDS["tts"]`

**UI**
- `src/app/settings/tts-settings.tsx` — TTS panel
- `src/app/workflows/[id]/edit/edit-form.tsx:389-401` — workflow editor TTS dropdown
- `src/app/api/workflows/schema/route.ts:34` — derived `tts: Object.keys(ttsProviders)`

**Schema**
- `src/lib/workflows-schema.ts:27` — `tts_provider` enum (Task 1.6 widens this)

**Workflow seeds (no edit needed — leave at `tts_provider: "ai33"`)**
- `src/lib/db.ts:82-117` — `BUILTIN_WORKFLOWS`

**Research / prior plans**
- `docs/research/2026-05-05-chatterbox-tts-provider.md` — full wire-format reference
- `docs/research/2026-05-04-tts-providers.md` — earlier provider comparison
- `docs/plans/2026-05-05-tts-provider-snapshot-pin.md` — completed runtime cleanup that made adding a third provider cheap
- `docs/plans/archive/2026-05-04-genaipro-tts-provider.md` — closest precedent (adding a second provider end-to-end)

**Tests to mirror**
- `__tests__/unit/lib/tts/genaipro.test.ts` — fetch-mock + real settings + tmp dir layout
- `__tests__/unit/lib/tts/meta.test.ts` — metadata assertions
- `__tests__/unit/lib/tts/index.test.ts` — registry assertions
- `__tests__/components/settings/settings-form.test.tsx` — TTS-tab field rendering

**External**
- `https://github.com/devnen/Chatterbox-TTS-Server` — wrapper repo (MIT, port 8004)
- `https://github.com/resemble-ai/chatterbox` — official Resemble AI library (MIT)
- `docs/setup-guides/setup-google-flow.md` — pattern for the install guide produced in Task 0.1 (the only operator-facing local-service setup doc currently in `docs/`)
