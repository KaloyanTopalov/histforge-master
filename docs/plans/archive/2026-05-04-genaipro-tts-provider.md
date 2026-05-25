# GenAIPro TTS Provider

## Overview

Add `genaipro` as a second TTS provider alongside `ai33`. Talks to GenAIPro Voice AI / Labs (`https://genaipro.vn/api`) with Bearer-token auth, async submit + poll + download, and an opt-in subtitle export endpoint. Reuses the existing voice-tuning settings (`voice_id`, `voice_stability`, `voice_similarity`, `voice_style`, `voice_speed`, `voice_use_speaker_boost`, `voiceover_model_id`) — the API documents the same four ElevenLabs `model_id` slugs and the same numeric tuning ranges as AI33.

## Current State

TTS is the small subsystem documented in `docs/research/2026-05-04-tts-providers.md`. Adding a provider requires touching exactly the surface the research doc lists — no new step file, no new orchestration. The path traced there is canonical and should be re-read before starting.

Key constraints:
- **Generic-step dispatch**: `src/worker/steps/06-voiceover.ts:62-90` is the only TTS step. It calls `ctx.ttsProvider.synthesize(...)`. Provider object is resolved at pipeline startup from the global `tts_provider` setting (`src/worker/pipeline.ts:297`).
- **Provider contract**: `TtsProvider.synthesize(text, outMp3Path, opts)` (`src/lib/tts/types.ts:10-26`). Must write the MP3 at `outMp3Path`, may return optional SRT/JSON transcript paths.
- **Cancellation**: `opts.signal` is the per-pipeline `AbortSignal` from `StepContext.signal`. Long-running providers must thread it through `fetch` and call `throwIfAborted(signal)` before each poll — see the `project_long_running_step_cancellation` memory and the cancellation utility at `src/worker/cancellation.ts:113-123`.
- **Restart-safe sidecar**: AI33 writes `.tts_task_id` next to `narration.mp3` after a successful submit so a worker restart can resume polling without paying twice (`src/lib/tts/ai33.ts:256-296`). The sidecar is in `step.outputs` (cleanup) but not `step.produces` (`src/worker/steps/06-voiceover.ts:68-82`). Same pattern applies to GenAIPro since the submit is a paid call.
- **Two hardcoded provider lists in UI**: `src/app/settings/settings-form.tsx:469-477` and `src/app/workflows/[id]/edit/edit-form.tsx:389-400`. Neither is registry-driven; both must be edited.
- **Two Zod enums**: `src/lib/settings.ts:70` (`tts_provider`) and `src/lib/workflows-schema.ts:27` (workflow validation). Both must be extended. The workflow import/clone paths in `src/lib/workflows-import.ts` (lines 89, 115) pass `tts_provider` through pre-validated data, so extending the workflow schema is sufficient — no separate change needed there.

GenAIPro API differences from AI33 (per `docs/tts/genaipro/genaipro_api.md`):
- Auth header `Authorization: Bearer ${token}`, not `xi-api-key`.
- Submit: `POST /v1/labs/task` with flat JSON body (`input`, `model_id`, `voice_id`, `similarity`, `speed`, `stability`, `style`, `use_speaker_boost`) — not nested under `voice_settings`.
- Submit response: `{ "task_id": "..." }` (no `success`/`ec_remain_credits` wrapper).
- Poll: `GET /v1/labs/task/{task_id}`, status flips `processing` → `completed`, audio URL appears on the `result` field once complete.
- Transcripts: only the `subtitle` field is documented (SRT-style). No JSON transcript appears on the documented `LabTask` shape. Subtitles are opt-in: `POST /v1/labs/task/subtitle/{task_id}` with body params for line/cue limits, then the SRT URL appears on the task's `subtitle` field on the next poll.
- Audio host is `media.genaipro.vn`.

## Scope

**Doing**:
- New `src/lib/tts/genaipro.ts` provider implementation with submit/poll/download, subtitle export, sidecar-based restart-safe resume, cancellation.
- Registry entry in `src/lib/tts/index.ts`.
- Zod enum extensions in `src/lib/settings.ts` and `src/lib/workflows-schema.ts`.
- `GENAIPRO_API_KEY` declaration in `.env.example`.
- UI dropdown extensions in both Settings form and Workflow edit form.
- Unit tests under `__tests__/unit/lib/tts/genaipro.test.ts` mirroring the structure of `__tests__/unit/lib/tts/ai33.test.ts`.
- Spec note (`docs/histforge-spec.md`) to mention the second provider alongside AI33.

**Not doing**:
- Changing the default `tts_provider` setting (stays `ai33`).
- Changing built-in workflows (`BUILTIN_WORKFLOWS` in `src/lib/db.ts:83-118`) to default to `genaipro`. Operators select per-workflow.
- Per-workflow TTS provider resolution (the existing scope mismatch at `src/worker/pipeline.ts:297` — TTS is global-setting-driven, image/video are snapshot-pinned). Out of scope; flagged in the research doc.
- New voice-tuning settings keys. GenAIPro uses the same param ranges; reuse the existing keys.
- Settings for subtitle-export tunables (`max_characters_per_line` etc.). Use sensible hardcoded defaults inside the provider for v1.
- Renaming the existing `"ai33"` settings tab. Cosmetic — leave for a follow-up if it grows confusing.
- Webhook delivery (`call_back_url`). HistForge has no public webhook for this; poll-only is fine.

## Tasks

### Phase 1: Provider implementation

- [x] **Task 1: Implement `src/lib/tts/genaipro.ts`**
  **Files**: `src/lib/tts/genaipro.ts` (new)
  **What**: New provider exporting `genaiproProvider: TtsProvider`. Submits a task to `POST https://genaipro.vn/api/v1/labs/task` with Bearer-token auth and the GenAIPro flat-body shape; polls `GET /v1/labs/task/{task_id}` until `status === "completed"` and `result` is populated; downloads the MP3 to `outMp3Path`; calls the subtitle-export endpoint and re-polls until the `subtitle` URL is populated, then downloads the SRT to `audio/narration.srt`. `TtsResult.transcripts.jsonPath` stays `undefined` — the documented `LabTask` shape does not expose a JSON transcript.
  **Context**:
  - Mirror the structure of `src/lib/tts/ai33.ts:1-386`. Same `synthesize(text, outMp3Path, opts)` signature, same retry/poll/cancellation/sidecar patterns, same numeric tunables (`MAX_SUBMIT_ATTEMPTS = 3`, `DEFAULT_RETRY_DELAY_MS = 1000`, `DEFAULT_POLL_INTERVAL_MS = 30_000`, `MAX_CONSECUTIVE_POLL_FAILURES = 60`). Reuse `throwIfAborted` and `isAbortError` from `src/worker/cancellation.ts:95-123`.
  - Read settings via `getSetting(...)` exactly like AI33 (`src/lib/tts/ai33.ts:74-87`): `voice_id`, `voiceover_model_id`, `voice_stability`, `voice_similarity`, `voice_style`, `voice_speed`, `voice_use_speaker_boost`. The submit body shape is **flat** per `docs/tts/genaipro/genaipro_api.md:36-50` — do not nest under `voice_settings`.
  - Read API key from `process.env.GENAIPRO_API_KEY` at call time, throw a descriptive error if missing — same pattern as `src/lib/tts/ai33.ts:317-322`.
  - Validate poll responses with a Zod `LabTask` schema covering the fields in `docs/tts/genaipro/genaipro_api.md:118-134`. Use `passthrough()` on optional/extension fields (mirror `src/lib/tts/ai33.ts:45-57`). Allow nullable `result` and `subtitle` strings — they only populate after `completed` / after subtitle export.
  - Restart-safe sidecar: same `.tts_task_id` filename next to `narration.mp3`, same atomic-write + treat-whitespace-as-missing semantics as AI33 (`src/lib/tts/ai33.ts:256-296`). The helpers are currently module-private to `ai33.ts` — the implementer picks one of: (a) duplicate the four small functions in `genaipro.ts` (cheap, keeps providers self-contained), or (b) extract them to `src/lib/tts/sidecar.ts` and refactor AI33 to import from there. Default to (a) unless duplication offends; both providers must stay byte-compatible on the sidecar format because they share `step.outputs` (`src/worker/steps/06-voiceover.ts:75`) for failure cleanup.
  - Subtitle export: after the task is `completed` and the MP3 is downloaded, `POST /v1/labs/task/subtitle/{task_id}` with hardcoded sensible defaults (suggested: `max_characters_per_line: 42`, `max_lines_per_cue: 2`, `max_seconds_per_cue: 5` — the API doc lists the body fields without recommending values, so these are an editorial choice the implementer can adjust). Poll the task again with a finite cap (e.g. `MAX_SUBTITLE_POLL_ATTEMPTS = 10`) until the `subtitle` field is a non-empty URL, then download to `audio/narration.srt`. If subtitle export fails or the field never populates within the cap, log and return without an `srtPath` — alignment runs in a later step against the MP3 directly, so the SRT is optional.
  - Bound consecutive poll failures the same way AI33 does (`src/lib/tts/ai33.ts:37,160-167`). Same justification (permanent upstream outage → step error rather than forever-spin) applies. Counter resets on a schema-valid response.
  - Cancellation: `signal` flows into every `fetch`, plus `throwIfAborted(signal)` is called before each `await sleep(...)` and at the top of every poll iteration. Cancellation must beat retries — when `isAbortError(err)`, rethrow immediately (mirror `src/lib/tts/ai33.ts:127`).

- [x] **Task 2: Register provider in `src/lib/tts/index.ts`**
  **Files**: `src/lib/tts/index.ts`
  **What**: Add the `genaipro` entry to the `ttsProviders` map.
  **Context**: Static map, no async loading (`src/lib/tts/index.ts:6-8`). One-line addition next to the `ai33` entry.

### Phase 2: Validation surface

- [x] **Task 3: Extend `tts_provider` Zod enum in settings**
  **Files**: `src/lib/settings.ts`
  **What**: Add `"genaipro"` to the `tts_provider: z.enum([...])` at line 70.
  **Context**: Settings are stored as TEXT and parsed via this schema on read (`src/lib/settings.ts:116-128`). Without this change, writing `"genaipro"` will succeed but reading will throw. No new keys — voice-tuning settings (lines 75-88) are reused as-is.

- [x] **Task 4: Extend `tts_provider` Zod enum in workflow validation**
  **Files**: `src/lib/workflows-schema.ts`
  **What**: Add `"genaipro"` to the nullable `tts_provider: z.enum(["ai33"]).nullable()` at line 27.
  **Context**: This is a **separate** Zod enum from the settings one, used by the `/api/workflows` validate / draft / import / clone routes. Forgetting it means saving a workflow with `tts_provider: "genaipro"` returns a 400 from the workflow API even though the setting accepts it.

- [x] **Task 5: Declare API key env var**
  **Files**: `.env.example`
  **What**: Add `GENAIPRO_API_KEY=` line beside the existing `AI33_API_KEY=` (`.env.example:2`).
  **Context**: Convention — `.env.example` is the operator-facing list of credentials to fill. The provider reads `process.env.GENAIPRO_API_KEY` at call time and throws if absent (Task 1).

### Phase 3: UI

- [x] **Task 6: Add `genaipro` to Settings form provider dropdown**
  **Files**: `src/app/settings/settings-form.tsx`
  **What**: Extend the hardcoded `options={["ai33"]}` array on the `tts_provider` `SelectField` to include `"genaipro"`.
  **Context**: Located inside the `<TabsContent value="ai33">` block at lines 468-477. The dropdown is a literal JSX array — not registry-driven. The `TAB_FIELDS["ai33"]` map (lines 76-85) already covers the shared voice-tuning keys; no further tab changes are needed since both providers use the same settings. (Renaming the tab from "AI33" to a provider-neutral label is a follow-up — out of scope.)

- [x] **Task 7: Add `genaipro` to Workflow edit form provider dropdown**
  **Files**: `src/app/workflows/[id]/edit/edit-form.tsx`
  **What**: Extend the `tts_provider` `SelectField` options array (lines 393-396) with `{ value: "genaipro", label: "GenAIPro" }`.
  **Context**: Second hardcoded provider list — independent of the Settings one. The `NONE` sentinel at line 62 is the existing `null` ↔ select-value bridge; do not disturb it.

### Phase 4: Tests

- [x] **Task 8: Unit tests for the GenAIPro provider**
  **Files**: `__tests__/unit/lib/tts/genaipro.test.ts` (new)
  **What**: Vitest suite covering: happy path (submit → poll until completed → download MP3 → subtitle export → re-poll → download SRT), missing `GENAIPRO_API_KEY`, transient submit retries up to the configured `MAX_SUBMIT_ATTEMPTS`, exhausted submit retries throws, transient poll failures swallowed and bounded at `MAX_CONSECUTIVE_POLL_FAILURES`, cancellation via `AbortSignal` mid-poll, sidecar write/read/resume (write after submit, resume from existing sidecar skips submit, whitespace-only sidecar treated as missing, sidecar deleted after success), subtitle export failure / never-populates path handled gracefully (MP3 still downloads, `TtsResult` reflects no transcripts).
  **Context**:
  - Mirror `__tests__/unit/lib/tts/ai33.test.ts:1-950` structure: mock `global.fetch` only (system boundary), run real settings/db/filesystem against in-memory SQLite + tmpdir. Reuse the `freshDb` / `tempDir` helpers' shape from lines 35-46.
  - Set `process.env.GENAIPRO_API_KEY` in `beforeEach`, restore in `afterEach`.
  - Pass `retryDelayMs: 0` and `pollIntervalMs: 0` to keep tests fast — same options the AI33 tests use.
  - Submit body assertion is the main shape difference vs. AI33: flat fields per `docs/tts/genaipro/genaipro_api.md:36-50`, not `voice_settings`-nested.
  - Subtitle export coverage is GenAIPro-specific: assert that after the MP3 lands, a `POST` to `/v1/labs/task/subtitle/{task_id}` is made, and the next poll's `subtitle` URL is downloaded to `audio/narration.srt`. Cover the "subtitle export never populates" path — provider must not block synth on it indefinitely.

### Phase 5: Spec & docs

- [x] **Task 9: Update spec to reference both providers**
  **Files**: `docs/histforge-spec.md`
  **What**: Update the lines that hardcode "AI33" / "currently only `ai33`" to acknowledge `genaipro` as a second option. Targets (line numbers indicative — find by content, the spec drifts): the goals/architecture intro that names AI33 as the TTS dependency, the settings-table row for `tts_provider` (enum description), the provider-registry "currently only" note, the `lib/tts/` description in the architecture / extension-points section. Section 8 (`## 8. Voiceover (voiceover) — AI33`) can stay AI33-specific, but a one-line cross-reference to GenAIPro in the section intro keeps the spec honest.
  **Context**: The spec is the project's source-of-truth document (see CLAUDE.md "Spec is the source of truth"). Architecture descriptions and the settings table need to match the implementation.

## References

- `docs/research/2026-05-04-tts-providers.md` — full research on what a new TTS provider must cover.
- `docs/tts/genaipro/genaipro_api.md` — GenAIPro API contract.
- `docs/tts/ai33/ai33_api.md` — AI33 API contract for comparison.
- `src/lib/tts/ai33.ts` — reference implementation to mirror (submit/poll/download/sidecar/cancellation).
- `src/lib/tts/types.ts:10-26` — provider interface contract.
- `src/lib/tts/index.ts` — registry.
- `src/worker/steps/06-voiceover.ts` — the generic step that dispatches to the provider.
- `src/worker/cancellation.ts:95-123` — `isAbortError`, `throwIfAborted` utilities.
- `__tests__/unit/lib/tts/ai33.test.ts` — test structure to mirror.
- Memory: `project_long_running_step_cancellation` — `StepContext.signal` propagation pattern.
