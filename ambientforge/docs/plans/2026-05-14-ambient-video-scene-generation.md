# Ambient-video workflow + per-album scene generation

## Overview
Introduce a third workflow `ambient-video` that pairs a Suno music album with a Seedance-generated 10s motion clip used as the looped video bed (in place of a static cover image). Per-album scene generation calls OpenRouter to produce a Midjourney prompt, a Seedance motion prompt, and a YouTube title as one coherent set — keyed off a randomly-picked theme from `channel.scene_themes`. The operator generates `source.jpg` in Midjourney from the printed prompt, drops it in `projects/<channel_id>/source.jpg`, and the pipeline uses that same image as both the cover/thumbnail base AND as Seedance's first/last frame (so the clip loops seamlessly).

## Current State

### Workflow registry — extension point for the new workflow
- `WORKFLOWS = ['ambient', 'rap-compilation']` at `src/lib/channels/constants.ts:7` — add `'ambient-video'` here.
- Registry pattern at `src/worker/workflows/index.ts:13-16` — register the new `ambientVideoWorkflow`.
- `WorkflowDefinition` shape at `src/worker/workflows/types.ts:21-35` — currently has `branchB` as the only step-shape override. Needs an extension so the ambient-video workflow can also swap step 01 (to chain in the scene generator) and step 05a (source.jpg → cover, no Flow).
- Runner step injection at `src/worker/runner.ts:89-104` — currently hardcodes `step01AlbumBrief`, `step05aCoverImage` etc. Needs to honor optional workflow overrides for those slots (same pattern as `branchB: workflow.branchB`).
- Pipeline orchestrator at `src/worker/pipeline.ts:197-237` runs `step01..step05b` sequentially before the branchA/B fork. The slot count is fixed — adding "01b" cleanly means composing two steps into the workflow's `step01` slot, NOT adding a new PipelineDeps key.

### LLM call pattern
- `chatCompletionJSON({ rendered, schema })` at `src/lib/llm/openrouter.ts:53-91` — single-user-message POST to OpenRouter `/api/v1/chat/completions`, JSON-mode + Zod validation + 1 stricter-reminder retry on malformed + rate-limit backoff. The function reads `apiKey` from `getOpenRouterApiKey()` and the model from settings `model_name`.
- Step 01 reference call at `src/worker/steps/01-album-brief.ts:35-48` — `resolveChannelPrompt(channel, kind)` → `renderTemplate(content, vars)` → `chatCompletionJSON({ rendered, schema })`. The scene generator step follows the same shape.
- Note for scene-gen: the brief lists `temperature: 0.9 / max_tokens: 600 / response_format: { type: "json_object" }` as overrides. The current `chatCompletionJSON` body at `src/lib/llm/openrouter.ts:166-171` is hardcoded — does NOT pass `temperature` / `max_tokens` / `response_format`. Adding scene-gen needs either (a) a new variant of `chatCompletionJSON` that accepts extra body fields, or (b) the implementer accepts the helper's defaults and lives with whatever the model produces. The plan goes with (a) so scene variety is tunable.

### Prompt resolution
- `resolveChannelPrompt(channel, kind)` at `src/lib/prompts.ts:176-218` — 3-tier resolution (channel DB column → channel-templates file → workflow default file). `PromptKind` union at `src/lib/prompts.ts:22-27` is fixed to 5 values; the scene generator's prompt is not in that union — see Phase 4 task for the decision.
- `defaultPromptBasename(kind, workflow)` at `src/lib/prompts.ts:56-82` — workflow-aware default file basenames. Needs a branch for `ambient-video` (which can reuse ambient's defaults for the 5 standard kinds or author new ones — see Phase 6).
- Templates live in `prompts/defaults/` — `album-brief.md` etc. List confirmed by `Glob` of `prompts/defaults/*.md`.

### DB schema
- `DB_VERSION = 8` at `src/lib/db.ts:6` — bump to `9`.
- Migration pattern at `src/lib/db.ts:192-281` — `runMigrations(db)` uses `addColumn()` helper that swallows duplicate-column errors. Comment with version (e.g. `// v9: ambient-video scene + seedance ...`).
- Albums schema at `src/lib/db.ts:55-92`; `albumsRepo.Album` type at `src/lib/repos/albums.ts:23-60`, `fromRow` at `:114-159`, `COLS` at `:161-168`, `PATCHABLE` at `:262-294`.
- Channels schema at `src/lib/db.ts:9-53`; `channelsRepo.Channel` type at `src/lib/repos/channels.ts:23-67`, `fromRow` at `:194-240`, `COLS` at `:242-254`, `PATCHABLE` at `:363-404`. All four ALTER points need wiring through these layers.

### Branch B (video render) for ambient-video
- Existing ambient branchB at `src/worker/workflows/ambient.ts:9-13` — sequential `step07 → step08 → step09`.
- Step 07 (audio concat at native length) at `src/worker/steps/07-audio-concat.ts` — reusable as-is for ambient-video.
- Step 08 (loop concat.wav to `target_video_seconds`) at `src/worker/steps/08-loop-to-2h.ts` — partially reusable; ambient-video still needs to extend audio to match the looped video duration, but the new step 09 will own that.
- Step 09 (mux still image + loop.wav) at `src/worker/steps/09-mux-video.ts` + `src/lib/render/mux.ts` — pattern reference for the new ambient-video mux (which loops a 10s clip.mp4 instead of using `-loop 1` on a still image). `pickEncoder` + `runFfmpegStreaming` + progress parsing are reusable.
- Anti-pattern reference: `domain-workflows.md` § anti-patterns says `lib/render/mux.ts:muxVideo` assumes image+audio — don't reuse it for video+audio. The plan adds a new mux helper (similar to the rap branch's inline ffmpeg).

### Source-image convention
- Operator memory `project_no_flow_dk_setup.md` confirms Flow is not installed on this machine. The ambient-video workflow is the FIRST workflow that doesn't depend on Flow — `source.jpg` arrives via the operator pasting the Midjourney prompt by hand.
- Step 05a Flow path at `src/worker/steps/05a-cover-image.ts:35-219` is the pattern to replace. For ambient-video, step 05a verifies `projects/<channel_id>/source.jpg` exists, copies it to the album folder, runs the same FFmpeg post-processing (`cropAndScaleSquare` → cover.png, `resizeWithMode` → ytImage.png, optional `compressToJpeg` for DK) that 05a already does after Flow downloads. Step 05b (thumbnail) is reused unchanged — its `useCover: true` path already crops cover to 1920×1080 + drawtext overlay.

### Title resolution in metadata
- Step 10 at `src/worker/steps/10-youtube-metadata.ts:90-134` calls the LLM with `{ tracklist, hashtagsLine, spotifyLine, album, channel }` and persists `ytTitle`. For ambient-video, when `album.scene_title` is set, use it verbatim INSTEAD of asking the LLM for `title`. Two viable surgical points: (1) override after LLM returns (replace `result.title` with `album.scene_title`), or (2) skip the LLM title field entirely. Either keeps the description/tags LLM-generated. The plan picks (1) so the metadata pipeline still validates description-contains-tracklist via the existing retry loop.

### Dashboard
- Channel detail page at `src/app/channels/[id]/page.tsx`. The "Albums" table (`:325-378`) is the natural location for a Scene section. There's also a `Generated images` section at `:381-394` per latest album — a Scene section parallels it.
- Channel edit form at `src/app/channels/_components/ChannelFormBody.tsx` + `src/app/channels/[id]/edit-form.tsx` — needs new fields for `scene_themes` (JSON array textarea) + `seedance_motion_prompt` (textarea fallback). Channel API at `src/app/api/channels/route.ts` adds Zod validation.

### Tests
- Existing test surfaces (no new framework needed): `src/lib/__tests__/repos.test.ts` (Album / Channel row roundtrips), `src/app/api/__tests__/channels-api.test.ts` (Zod validation), `src/lib/llm/__tests__/openrouter.test.ts`, plus workflow tests under `src/worker/workflows/`. Need: a roundtrip test asserting the new columns survive a Channel/Album persist+fetch.

## Scope
**Doing**:
- New workflow `ambient-video` registered in registry; opt-in via `channel.workflow`.
- DB v9: `albums.scene_image_prompt`, `albums.scene_seedance_prompt`, `albums.scene_title`, `channels.scene_themes`, `channels.seedance_motion_prompt`.
- New step `01b-scene-generator.ts` composed into ambient-video's step 01 slot (no orchestrator change).
- New step `05a-ambient-video-cover.ts` (replaces Flow call for this workflow).
- New `src/lib/seedance/client.ts` calling OpenRouter `/api/v1/videos` with `bytedance/seedance-2.0`, `generate_audio: false`, `duration: 10`, `aspect_ratio: '16:9'`, `first_frame = last_frame = source.jpg` (seamless loop).
- New step `08-seedance-clip.ts` (replaces step 08 loop-to-2h for ambient-video).
- New step `09-ambient-video-mux.ts` (loops 10s clip + extends audio to `target_video_seconds` + final mux at 1920×1080).
- Step 10 honors `album.scene_title` for ambient-video.
- Channel CRUD: scene_themes JSON validation, seedance_motion_prompt input.
- Dashboard: Scene section on channel detail page with copy-to-clipboard for the Midjourney prompt.
- Default prompt template `prompts/defaults/ambient-video-scene.md` with the system prompt from `task.txt`.
- `scene.json` written to album folder for operator reference.

**Not doing**:
- Seedance bridge / Chrome / CDP (it's a direct OpenRouter REST call — no bridge needed; same auth as the existing LLM calls).
- Mock client for Seedance in tests (mark step 08 as integration-only for now; OpenRouter calls in tests already short-circuit via `apiKey === 'mock'` — the seedance client should honor the same sentinel by returning a fixture or skipping).
- Automatic Midjourney image generation (operator-driven; pipeline only generates the prompt + writes it prominently).
- Migrating existing `ambient` channels — adding the new columns is non-destructive; existing channels stay on `ambient`.
- Refactoring the 5 prompt kinds union to include "scene" (the scene-gen step loads its template directly via `fs.readFileSync` of `prompts/defaults/ambient-video-scene.md`, honoring an optional channel-templates override path; this avoids surgery on `PromptKind` and the rigid `resolveChannelPrompt` 3-tier).
- YouTube upload automation.

## Tasks

### Phase 1: Schema + repos + constants

- [x] **Task 1.1: Add `ambient-video` to WORKFLOWS constant**
  **Files**: `src/lib/channels/constants.ts`
  **What**: Extend `WORKFLOWS` tuple to `['ambient', 'rap-compilation', 'ambient-video']`. The derived `Workflow` type updates automatically.
  **Context**: Single-line change at `src/lib/channels/constants.ts:7`. After this, repo coercion (`coerceWorkflow` at `src/lib/repos/channels.ts:177-180`) and API Zod (`workflow: z.enum(WORKFLOWS ...)` at `src/app/api/channels/route.ts:59`) accept the new value transparently.

- [x] **Task 1.2: DB v9 migration — bump version + add 5 columns**
  **Files**: `src/lib/db.ts`
  **What**: Bump `DB_VERSION` from `8` to `9`. Add columns via `addColumn()`:
    - `albums.scene_image_prompt TEXT` (nullable)
    - `albums.scene_seedance_prompt TEXT` (nullable)
    - `albums.scene_title TEXT` (nullable)
    - `channels.scene_themes TEXT` (nullable — JSON array as a string)
    - `channels.seedance_motion_prompt TEXT` (nullable — channel-level fallback)
  Also append the columns to the `CREATE TABLE` `SCHEMA_SQL` blocks so fresh DBs match the migrated shape.
  **Context**: `DB_VERSION` at `src/lib/db.ts:6`, `SCHEMA_SQL` at `:8-145`, `runMigrations` at `:192-281`. The v7/v8 comments at `:239-280` are the structural pattern. SQLite has no `ADD COLUMN IF NOT EXISTS` — `addColumn` swallows duplicate-column errors at `:196-202`.

- [x] **Task 1.3: Surface new columns on `albumsRepo.Album`**
  **Files**: `src/lib/repos/albums.ts`
  **What**: Add `sceneImagePrompt: string | null`, `sceneSeedancePrompt: string | null`, `sceneTitle: string | null` to the `Album` type. Update `Row` type, `fromRow` mapper, `COLS` SELECT list, and `PATCHABLE` map so the columns participate in reads + patches.
  **Context**: Mirrors the v7 wiring of `sunoPromptId` / `sunoPromptResolvedText` at `src/lib/repos/albums.ts:56-57, :108-109, :154-155, :167-168, :292-293`. Same five touchpoints per column.

- [x] **Task 1.4: Surface new columns on `channelsRepo.Channel`**
  **Files**: `src/lib/repos/channels.ts`
  **What**: Add `sceneThemes: string | null` and `seedanceMotionPrompt: string | null` to the `Channel` type. Wire through `Row`, `fromRow`, `COLS`, `INSERT VALUES`, the `ChannelInput` `Partial<Pick<...>>` block, and `PATCHABLE`.
  **Context**: Mirrors how `sunoStylePrompt` is wired at `src/lib/repos/channels.ts:52, :155, :224, :249, :324, :391`. Six touchpoints per column (one extra vs Album because channels.ts has an explicit INSERT param list).

- [x] **Task 1.5: Roundtrip tests for new columns**
  **Files**: `src/lib/__tests__/repos.test.ts`
  **What**: Add (or extend) tests that create an Album + Channel with the new fields set, read them back, and assert exact match. Cover NULL + non-NULL cases.
  **Context**: Existing pattern in the same file; mirrors how `sunoPromptId` roundtrip is tested.
  **Note (done)**: Absorbed into Tasks 1.3 + 1.4 as TDD seams. The Album scene-fields round-trip (null defaults + non-null patch + back-to-null) is at `src/lib/__tests__/repos.test.ts:123-162`; the Channel sceneThemes / seedanceMotionPrompt round-trip (null defaults + create with non-null + patch set+clear) is at `:84-131`.

### Phase 2: Workflow registration + ambient-video definition

- [x] **Task 2.1: Extend `WorkflowDefinition` with optional step overrides**
  **Files**: `src/worker/workflows/types.ts`
  **What**: Add optional fields `step01?: PipelineStep`, `step05a?: PipelineStep` to `WorkflowDefinition`. (Don't add the others yet — YAGNI; revisit when a workflow needs them.)
  **Context**: Current shape at `src/worker/workflows/types.ts:21-35` only allows `branchB` to be overridden. The runner needs the new slots to swap step 01 (chain in scene generator) and step 05a (replace Flow with source.jpg) for ambient-video.

- [x] **Task 2.2: Runner honors workflow.step01 / step05a overrides**
  **Files**: `src/worker/runner.ts`
  **What**: In the `pipelineDeps` construction at `src/worker/runner.ts:89-104`, change `step01: step01AlbumBrief` to `step01: workflow.step01 ?? step01AlbumBrief` (same for `step05a`). Production behavior for ambient + rap is unchanged (overrides are undefined).
  **Context**: Two-line tweak. Mirrors how `branchB: workflow.branchB` already works.

- [x] **Task 2.3: Create `ambient-video.ts` workflow definition**
  **Files**: `src/worker/workflows/ambient-video.ts` (new), `src/worker/workflows/index.ts`
  **What**: Define `ambientVideoWorkflow: WorkflowDefinition` with:
    - `name: 'ambient-video'`
    - `defaultTracksPerAlbum: 30` (same as ambient)
    - `step01`: composed step — runs `step01AlbumBrief` then `step01bSceneGenerator` sequentially. Inline `async (album, log) => { await step01AlbumBrief(album, log); await step01bSceneGenerator(album, log); }`.
    - `step05a`: `step05aAmbientVideoCover` (Phase 4).
    - `branchB`: sequential `step07AudioConcat → step08SeedanceClip → step09AmbientVideoMux` (Phase 5).
    - `preflightChecks`: `[requireSunoStylePromptSource, requireSourceJpg, requireSceneThemesValidOrNull]` (Phase 3 defines the new checks).
    - `requiredChannelFields: []` (scene_themes is optional with fallback).
  Register in `src/worker/workflows/index.ts:13-16` REGISTRY.
  **Context**: Pattern at `src/worker/workflows/ambient.ts` and `rap-compilation.ts`.

### Phase 3: Preflight checks for ambient-video

- [x] **Task 3.1: `requireSourceJpg` preflight**
  **Files**: `src/worker/workflows/checks.ts`
  **What**: Add a new `PreflightCheck` that resolves to ok iff `projects/<channel_id>/source.jpg` exists AND size > 50KB. Failure code `SOURCE_JPG_MISSING` with a message naming the expected path so the dashboard banner is actionable.
  **Context**: Existing `requireSunoStylePromptSource` at `src/worker/workflows/checks.ts:11-29` is the pattern. The check receives `{ album, channel, settings }` — derive path from `channel.id` + `process.cwd() + '/projects'`.

- [x] **Task 3.2: `requireSceneThemesValidOrNull` preflight**
  **Files**: `src/worker/workflows/checks.ts`
  **What**: When `channel.scene_themes` is non-null, parse it as JSON; require it to be `string[]` with ≥1 element. Null is OK (step 01b falls back to a hardcoded default theme). Failure code `SCENE_THEMES_INVALID`.
  **Context**: This is a structural validation — keeps the step 01b code simple by guaranteeing only "null or valid array" reaches it.

### Phase 4: Scene generator step (01b) + prompt template

- [x] **Task 4.1: Extend `chatCompletionJSON` to accept temperature / max_tokens / response_format**
  **Files**: `src/lib/llm/openrouter.ts`
  **What**: Add three optional fields to `ChatCompletionJSONOpts<T>` (`temperature?: number`, `maxTokens?: number`, `responseFormat?: { type: 'json_object' } | undefined`). Splice them into the body at `src/lib/llm/openrouter.ts:166-171` when set.
  **Context**: The current options at `:26-33` only allow `model` / `apiKey` / retry counts. Scene-gen needs `temperature: 0.9` for variety. Keep the existing call sites unchanged (new fields are optional). One test in `src/lib/llm/__tests__/openrouter.test.ts` should cover the body containing the new fields.

- [x] **Task 4.2: Create the scene prompt template**
  **Files**: `prompts/defaults/ambient-video-scene.md`
  **What**: Write the file with the exact system prompt from `task.txt` lines 39-62 (medieval-knight creative director, Ghibli-meets-graphic-novel style, JSON-only output with `scene` / `imagePrompt` / `seedancePrompt` / `title`, Gates-formula title constraints). No `<!-- mock-response: ... -->` because this template is used as a system prompt, not a Mustache-rendered user prompt.
  **Context**: Existing default templates use Mustache `{{channel.displayName}}` interpolation — the scene-gen step skips that for the system message and passes the picked theme as the user message instead, so no interpolation is needed.

- [x] **Task 4.3: Create step `01b-scene-generator.ts`**
  **Files**: `src/worker/steps/01b-scene-generator.ts` (new)
  **What**: Step contract — `PipelineStep` shape, idempotent (skip when all three `album.scene_*` fields are already set).
    1. Refetch album + channel.
    2. Parse `channel.sceneThemes` (already validated as JSON `string[]` by preflight). If null/empty, use hardcoded fallback `"medieval knight in a peaceful fantasy environment"`.
    3. Pick one theme via `Math.random` (non-deterministic by design — variety per run). Log the pick.
    4. Read `prompts/defaults/ambient-video-scene.md` from disk. (Honor `prompts/channel-templates/<channelId>/ambient-video-scene.md` as an override, mirroring `resolveChannelPrompt`'s tier 2 — see Phase 6 note on why this step bypasses `resolveChannelPrompt`.)
    5. Build two-message LLM input: system = template content, user = picked theme. NOTE: `chatCompletionJSON` currently sends a single user message at `src/lib/llm/openrouter.ts:166-171`. Either (a) inline a system+user variant just for this step, or (b) extend `chatCompletionJSON` to accept a `system?: string`. **Decision**: extend `chatCompletionJSON` with optional `system` field as part of Task 4.1.
    6. Schema: Zod object `{ scene, imagePrompt, seedancePrompt, title }` all `string().min(1)`.
    7. `temperature: 0.9`, `maxTokens: 600`, `responseFormat: { type: 'json_object' }`.
    8. Patch album with `sceneImagePrompt`, `sceneSeedancePrompt`, `sceneTitle`.
    9. Log the Midjourney prompt prominently (six `=`-separators around it, exact format from `task.txt:114-119`).
    10. Write `projects/<channelId>/<albumId>/scene.json` with all 4 fields pretty-printed.
  **Context**: Step 01 at `src/worker/steps/01-album-brief.ts` is the structural template (`PipelineStep` shape, idempotency check, log signature, `albumsRepo.patch`). The prominent-log convention is local to this step — no other step does it; CLAUDE.md does not forbid it.

- [x] **Task 4.4: Pipeline integration test for ambient-video step 01 + 01b chain**
  **Files**: `src/worker/__tests__/` (new test file if none exists yet for workflow chains; otherwise extend an existing one)
  **What**: Test that the composed `step01` in ambient-video runs step 01 first (album title populated), THEN step 01b (scene fields populated, `scene.json` on disk). Use `apiKey === 'mock'` path + `<!-- mock-response: ... -->` directives in templates.
  **Context**: Mock-directive pattern at `src/lib/prompts.ts:146-157`. Since the scene template doesn't go through `renderTemplate`, mock injection happens via `apiKey === 'mock'` returning the directive — this requires the scene template to carry a `<!-- mock-response: ... -->` directive after all, OR the step uses a different mock seam. **Decision**: add a `<!-- mock-response: {...} -->` line to `ambient-video-scene.md` (the `stripMockDirective` call in `chatCompletionJSON` strips it on the real path, so it's invisible to the production model).

### Phase 5: Seedance client + step 08 + step 05a + step 09 + branch B

- [x] **Task 5.1: Seedance client via OpenRouter `/api/v1/videos`**
  **Files**: `src/lib/seedance/client.ts` (new)
  **What**: Client exposes `submit({ prompt, sourceImagePath, duration, aspectRatio }) → jobId`, `poll(jobId) → 'pending' | 'ready' | 'failed'`, `download(jobId, destPath) → void`. Auth: reuses `getOpenRouterApiKey()` from `src/lib/settings.ts`. Submit body: `{ model: 'bytedance/seedance-2.0', input: { prompt, first_frame: <base64-source.jpg or URL>, last_frame: <same>, duration: 10, aspect_ratio: '16:9', generate_audio: false } }` (exact field names per OpenRouter videos endpoint — implementer to verify against the live API on first integration run; the plan deliberately doesn't lock in field names that may differ slightly). Error class `SeedanceError` with codes mirroring `FlowError` (`SEEDANCE_AUTH`, `SEEDANCE_RATE_LIMIT`, `SEEDANCE_NETWORK`, `SEEDANCE_TASK_FAILED`).
  **Context**: Pattern reference: `src/lib/flow/client.ts` for the `submitPrompt/poll/download` shape + error class. Pattern reference for OpenRouter auth + error semantics: `src/lib/llm/openrouter.ts:53-218`. Mock path: when `apiKey === 'mock'`, return a fixture `tests/fixtures/seedance/clip-fixture.mp4` (operator can drop a small placeholder there; not committed).

- [x] **Task 5.2: Step `05a-ambient-video-cover.ts`**
  **Files**: `src/worker/steps/05a-ambient-video-cover.ts` (new)
  **What**: For ambient-video, replaces the Flow call. Steps:
    1. Verify `projects/<channelId>/source.jpg` exists + size > 50KB (defense in depth; preflight should have caught missing). Throw `SOURCE_JPG_MISSING` otherwise.
    2. Skip if `album.coverImagePath` + `album.ytImagePath` already valid (idempotency, same pattern as existing 05a at `src/worker/steps/05a-cover-image.ts:70-78`).
    3. Copy `source.jpg` → `_raw-cover.png` (ffmpeg or `fs.copyFile` then probe — pick whichever is simpler).
    4. Run existing helpers `cropAndScaleSquare` → `cover.png` (3000×3000) and `resizeWithMode` → `ytImage.png` (1920×1080, mode per `channel.youtubeImageAspect ?? settings.youtube_image_aspect`).
    5. Apply `compressToJpeg` cover.jpg fallback for DK if cover.png > `cover_resample_threshold_mb` (same as existing 05a at `:152-191`).
    6. Patch `albumsRepo` with `coverImagePath`, `ytImagePath`. Step 05b runs unchanged afterwards (its `useCover: true` branch handles the thumbnail).
  **Context**: Existing step 05a at `src/worker/steps/05a-cover-image.ts:131-219` post-Flow block is the template. The new step is essentially that post-processing block + a `fs.copyFile` replacing the Flow `submit/poll/download`.

- [x] **Task 5.3: Step `08-seedance-clip.ts`**
  **Files**: `src/worker/steps/08-seedance-clip.ts` (new)
  **What**: For ambient-video, replaces step 08 loop-to-2h. Steps:
    1. Resolve motion prompt: `album.sceneSeedancePrompt || channel.seedanceMotionPrompt`. If both null/empty, throw `SEEDANCE_PROMPT_MISSING`. Log which source was used (`[seedance] Using album-generated motion prompt` vs `[seedance] Using channel fallback motion prompt`).
    2. Idempotency: skip if `projects/<channelId>/<albumId>/build/clip.mp4` exists AND ffprobe shows it's a valid h264 video ≥9s.
    3. Verify source.jpg path (`projects/<channelId>/source.jpg`).
    4. Submit Seedance job (prompt, sourceImagePath, duration=10, aspect_ratio='16:9').
    5. Poll loop: 15s interval, 10min timeout — same constants as Flow step 05a at `src/worker/steps/05a-cover-image.ts:20-21`.
    6. Download to `build/clip.mp4`.
    7. ffprobe validate: h264 / no audio / duration ≈10s / dims 16:9.
  **Context**: Flow polling pattern at `src/worker/steps/05a-cover-image.ts:222-259` is the template. Note: this step has NO bridge-disruption branch (unlike Suno) — OpenRouter is a stateless HTTP API; on transient failure throw and let the runner mark `videoStatus='failed'`.

- [x] **Task 5.4: Step `09-ambient-video-mux.ts`**
  **Files**: `src/worker/steps/09-ambient-video-mux.ts` (new), `src/lib/render/mux.ts` (extend)
  **What**: Final mux step for ambient-video. Inputs: `build/concat.wav` (from step 07), `build/clip.mp4` (from step 08), `channel.targetVideoSeconds ?? settings.target_video_seconds`. Steps:
    1. Idempotency: skip if `final.mp4` exists with h264 + aac + dims=1920×1080 + duration ≈ target ±3s.
    2. Extend audio: stream-copy-loop `concat.wav` until ≥ target, then stream-copy trim to exact target → `build/loop.wav`. Reuse `loopToTarget` from `src/lib/audio/loop.ts:18`.
    3. Mux: FFmpeg `-stream_loop -1 -i build/clip.mp4 -i build/loop.wav -map 0:v:0 -map 1:a:0 -c:v <encoder> -c:a aac -b:a 192k -shortest -pix_fmt yuv420p -movflags +faststart -r 30 -t <target> -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1" final.mp4`. Encoder via `pickEncoder` (NVENC vs libx264) from `src/lib/render/mux.ts:69-77`.
    4. Patch album: `videoStatus='rendered'`, `finalVideoPath`, `videoProgressPct=100`.
  **Context**: Pattern reference for `-stream_loop` + `-map` + final encode: rap branch step 09 at `src/worker/steps/09-rap-broll-mux.ts` (especially the `-map 0:v:0 -map 1:a:0` mandate from `domain-workflows.md`). Pattern reference for progress reporting via `runFfmpegStreaming` + `time=` parsing: `src/lib/render/mux.ts:79-157` + `09-rap-broll-mux.ts`. Either extend `muxVideo` with a "video bed" mode OR (cleaner) extract a new `muxVideoBedAndAudio(clip, audio, out, opts)` helper into `mux.ts` — the plan picks the helper to avoid making `muxVideo` polymorphic.

- [x] **Task 5.5: Wire branch B into ambient-video workflow**
  **Files**: `src/worker/workflows/ambient-video.ts`
  **What**: Implement `branchBAmbientVideo` as sequential `step07AudioConcat → step08SeedanceClip → step09AmbientVideoMux`. Already declared in Task 2.3; this task fills in the implementation now that the steps exist.
  **Context**: Pattern at `src/worker/workflows/ambient.ts:8-13`.

### Phase 6: Default prompt templates + workflow basename routing

- [x] **Task 6.1: Decide ambient-video default prompts (alias vs new)**
  **Files**: `src/lib/prompts.ts`, possibly `prompts/defaults/*-ambient-video.md`
  **What**: For the 5 standard `PromptKind`s (album-brief, track-briefs, cover-image, thumbnail, yt-metadata), the ambient-video workflow can either (a) reuse ambient's existing defaults verbatim, or (b) author its own. **Decision**: reuse ambient's defaults for now (matches the "ambient music + visual bed" framing — copy/title/genre/tracks are still ambient). Update `defaultPromptBasename` at `src/lib/prompts.ts:56-82` to return the same basenames as ambient when `workflow === 'ambient-video'`.
  **Context**: If a per-workflow basename diverges later, add a new branch + author the rap-style suffixed file.

- [x] **Task 6.2: Step 10 honors `album.scene_title`**
  **Files**: `src/worker/steps/10-youtube-metadata.ts`
  **What**: After `chatCompletionJSON` returns (around `src/worker/steps/10-youtube-metadata.ts:113-120`), if `fresh.workflow === 'ambient-video'` AND `fresh.sceneTitle` is non-empty, replace `result.title = fresh.sceneTitle` BEFORE the description-contains-tracklist validation + final patch.
  **Context**: This is the one step that intentionally branches on workflow (allowed because the step's external contract — emit valid yt-metadata — doesn't change; the workflow conditional is a single-line title overwrite, not a structural fork). Domain-workflows anti-pattern note: hard branches on workflow in step code are discouraged, but the alternative (a workflow-supplied `titleResolver` hook) is over-engineering for a single override.

### Phase 7: API + dashboard

- [x] **Task 7.1: Channel API Zod schema additions**
  **Files**: `src/app/api/channels/route.ts`, `src/app/api/channels/[id]/route.ts`
  **What**: Add to `ChannelCreateSchema` (and the PATCH schema):
    - `sceneThemes: z.string().nullable().default(null)` — stored as a TEXT JSON string. When non-null AND `workflow === 'ambient-video'`, refine with `.refine(s => parseJsonStringArray(s).length >= 1, { message: '...' })`. Don't deep-validate when workflow is not ambient-video (let it pass through as-is).
    - `seedanceMotionPrompt: z.string().nullable().default(null)`.
  Make sure `create()` and `patch()` in `channelsRepo` actually persist these (verified by the Phase 1 Task 1.4 wiring).
  **Context**: Zod pattern at `src/app/api/channels/route.ts:32-` for `ChannelCreateSchema`. `.refine` is the right escape hatch for workflow-conditional validation (don't lock the column to ambient-video — operators may want to set themes on an ambient channel as a no-op).

- [x] **Task 7.2: Album API surfaces scene fields**
  **Files**: `src/app/api/albums/[id]/route.ts` (find the file via `Glob src/app/api/albums/**/*.ts`)
  **What**: The album GET response already returns the full row; verify the new fields appear (since `fromRow` in Phase 1 includes them). If the response is filtered, add the three scene fields to the projection.
  **Context**: Existing test at `src/app/api/__tests__/get-album-api.test.ts` is the regression guard; extend or add a case asserting scene fields appear.

- [x] **Task 7.3: Channel form UI — scene_themes + seedance_motion_prompt inputs**
  **Files**: `src/app/channels/_components/ChannelFormBody.tsx`, `src/app/channels/[id]/edit-form.tsx`, `src/app/channels/new/page.tsx`
  **What**: Add a collapsible "Ambient-video" section (visible only when `workflow === 'ambient-video'`) containing:
    - `scene_themes` textarea (JSON array, helper text shows expected shape `["theme 1", "theme 2"]`).
    - `seedance_motion_prompt` textarea (channel-level fallback motion prompt).
  Submission flows through the existing form state → API PATCH plumbing.
  **Context**: Form state shape at `src/app/channels/_components/ChannelFormBody.tsx:26-` (`ChannelFormState`). Workflow-conditional sections pattern: existing rap-only B-roll section.

- [x] **Task 7.4: Channel detail page — Scene section with copy button**
  **Files**: `src/app/channels/[id]/page.tsx`, possibly a new client component `src/app/channels/[id]/scene-section.tsx`
  **What**: For the latest non-`new` album when `latestNonNew.workflow === 'ambient-video'`, render a "Scene" section showing:
    - `scene_title` (large, prominent — this is the YouTube title operator will see)
    - `scene_image_prompt` in a `<pre>` block with a **Copy** button (client component — this is the most important UI per the task brief; operator clicks and pastes into Midjourney)
    - `scene_seedance_prompt` in a `<pre>` block (read-only, smaller — operator usually doesn't touch it)
  **Context**: Page is currently a server component at `src/app/channels/[id]/page.tsx:79`. The copy button needs a client island — see how `TriggerButton` (`./trigger-button`) is imported and rendered. Place the Scene section after `Generated images` (`:381-394`).

### Phase 8: Spec + skill docs

- [x] **Task 8.1: Update `docs/ambientforge-spec.md`**
  **Files**: `docs/ambientforge-spec.md`
  **What**: Add a section for the ambient-video workflow: branch B sequence, source.jpg convention, scene-generator step, Seedance integration. CLAUDE.md § "Spec is source of truth" mandates this on every contract change.
  **Context**: Find the existing "Workflow types" section and append `ambient-video` alongside ambient + rap-compilation.

- [x] **Task 8.2: Update CLAUDE.md + relevant `.claude/rules/domain-*.md`**
  **Files**: `CLAUDE.md`, `.claude/rules/domain-workflows.md`
  **What**: Add `ambient-video` to the workflow list in CLAUDE.md § "Project Overview" + § Conventions ("Workflow-aware branch B"). In `domain-workflows.md`, document the source.jpg + scene-generator contract + Seedance step. Add a new domain skill file if Seedance grows: `.claude/rules/domain-seedance.md` (optional — defer until step 08 is exercised live).
  **Context**: CLAUDE.md project overview at the top of the file enumerates workflows; the rules under `.claude/rules/` cover each domain.

### Phase 9: Done-criteria validation

- [ ] **Task 9.1: `npm run build` clean**
  **Files**: n/a — verification only.
  **What**: TypeScript builds without errors.
  **Context**: Done-criteria from `task.txt:202`.

- [ ] **Task 9.2: `npm run db:init` runs the v9 migration**
  **Files**: n/a — verification only.
  **What**: On an existing v8 dev DB, `npm run db:init` adds the 5 new columns without error; on a fresh DB, the CREATE TABLE matches. Verify with `sqlite3 data/ambientforge.db '.schema albums'` and `.schema channels`.
  **Context**: Done-criteria from `task.txt:203`. Confirms `addColumn` migration ran.

- [ ] **Task 9.3: End-to-end mock run for an ambient-video channel**
  **Files**: n/a — verification only.
  **What**: Create an ambient-video channel with `scene_themes = ["knight by campfire at night"]` and a `seedance_motion_prompt` fallback. Drop a fixture `source.jpg`. Run with `apiKey === 'mock'` + `SUNO_MODE === 'mock'`. Verify:
    - Step 01 + 01b run; `album.scene_*` fields persist; `scene.json` written; Midjourney prompt visible in pipeline.log with the prominent `=`-banner.
    - Step 05a copies source.jpg into the album folder (no Flow call).
    - Step 08 produces `clip.mp4` from the mock seedance fixture.
    - Step 09 produces `final.mp4` (1920×1080, h264, aac, duration ≈ `target_video_seconds`).
    - Step 10 yt_title equals `album.scene_title`.
    - Dashboard Scene section shows the Midjourney prompt with working copy button.
  **Context**: Done-criteria from `task.txt:204-211`.

- [ ] **Task 9.4: `npm run lint` + existing test suite**
  **Files**: n/a — verification only.
  **What**: `npm run lint` clean. `npm run test` passes — including all existing ambient + rap-compilation tests (no regression).
  **Context**: Done-criteria from `task.txt:212-213`.

## References

- Task brief: `task.txt:1-226`
- Workflow registry: `src/worker/workflows/index.ts:13-16`, `src/worker/workflows/types.ts:21-35`
- DB schema + migrations: `src/lib/db.ts:6, :8-145, :192-281`
- Albums repo: `src/lib/repos/albums.ts:23-60, :114-159, :262-294`
- Channels repo: `src/lib/repos/channels.ts:23-67, :194-240, :363-404`
- LLM client: `src/lib/llm/openrouter.ts:53-91, :158-218`
- Prompt resolution: `src/lib/prompts.ts:56-82, :176-218`
- Step 01 reference pattern: `src/worker/steps/01-album-brief.ts:13-63`
- Step 05a Flow reference: `src/worker/steps/05a-cover-image.ts:35-219`
- Step 09 mux reference: `src/worker/steps/09-mux-video.ts`, `src/lib/render/mux.ts:41-67`
- Rap branch step 09 (video mux pattern): `src/worker/steps/09-rap-broll-mux.ts:25-50`
- Preflight check pattern: `src/worker/workflows/checks.ts:11-29`
- Channel detail page: `src/app/channels/[id]/page.tsx:79-431`
- Channel form: `src/app/channels/_components/ChannelFormBody.tsx`
- OpenRouter videos endpoint: `bytedance/seedance-2.0`, POST `/api/v1/videos`, async + poll, same `OPENROUTER_API_KEY`
- CLAUDE.md anti-patterns: forbids re-encoding concat audio, forbids `if (channel.workflow === '...')` in step code (Task 6.2 documents the single permitted exception)
