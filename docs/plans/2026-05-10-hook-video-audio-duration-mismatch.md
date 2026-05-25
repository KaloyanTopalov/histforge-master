# Hook video / audio duration mismatch fix

## Overview

The chunker budgets hook chunks by audio time (~120 s split into 12 ~10 s groups), but Google Flow returns fixed-length 8 s clips per chunk — so the rendered hook video is 96 s while Stage D crossfades against a 119.6 s offset, truncating ~119 s of narration off the end of the final video. Fix by aligning the chunker to the provider's clip length (new `hook_video_clip_seconds` setting) and bumping the hook chunk count (new `hook_chunk_count` setting, default 15 → 15 × 8 s = 120 s preserves the editorial 2-minute hook). Add a defensive ffprobe of `hook_final.mp4` so Stage D's xfade offset always tracks the real concat duration regardless of upstream sentence-boundary jitter.

Source: `docs/research/2026-05-09-hook-video-audio-duration-mismatch.md` — direction chosen 2026-05-10.

## Current State

- **Chunker constants**: `src/worker/steps/08-chunk.ts:6-8` — `HOOK_TARGET_SECONDS = 120`, `HOOK_CHUNK_COUNT = 12`, `MAIN_TARGET_SECONDS = 30`.
- **Hook-chunk algorithm** (the part to rewrite): `src/worker/steps/08-chunk.ts:46-110` — walks until cumulative end ≥ 120 s, then splits the resulting span into 12 near-equal-duration sentence groups.
- **Main-chunk algorithm** (the pattern to mirror): `src/worker/steps/08-chunk.ts:118-146` — walks sentences accumulating ~30 s, cuts at nearest sentence boundary.
- **Step entry**: `src/worker/steps/08-chunk.ts:174-176` — `Step.run` calls `runChunk(videoId, { projectsDir })` from `ctx`. No DB read today; the chunker reads settings only after this change.
- **Stage D xfade**: `src/lib/render.ts:368-394` — `hookDuration = hookChunks[last].end - hookChunks[0].start` (audio-timeline value), used as `xfade ... offset=${hookDuration}`. Comment at `:369-371` admits drift, assumed "±a few seconds".
- **No hook chunks**: `src/lib/render.ts:395-398` — Stage D copies `main_concat` to `video_only`. ffprobe path is unused in this branch.
- **Renderer wiring**: `src/worker/steps/14-render.ts:34-63` — `buildFfmpegExec(signal)` spawns ffmpeg with `-y`, signal-aware via Node's spawn `signal` option, stderr buffered + tail-included on rejection.
- **RenderDeps**: `src/lib/render.ts:203-216` — `exec`, `log`. No `probe` today; new dep gets added the same way `exec` is — production builds it from `signal` in `14-render.ts`, tests mock it.
- **Settings infrastructure**: `src/lib/db.ts:11-59` (`DEFAULT_SETTINGS`), `src/lib/settings.ts:13-127` (`SETTING_SCHEMAS`), `src/lib/settings-tabs.ts:68-76` (`render` tab field list), `src/app/settings/render-tab.tsx` (Render-tab UI fields).
- **Existing chunker tests**: `__tests__/unit/worker/steps/chunk.test.ts:54-229` — three tests, all hard-code "12 hook chunks" and the 120 s budget.
- **Existing render tests**: `__tests__/unit/lib/render.test.ts:257-308` — exercises Stages A–E with a 4-chunk fixture; the Stage D test at `:299-302` asserts `offset=20` (i.e. chunk-derived hookDuration).
- **Settings tests**: `__tests__/unit/lib/settings.test.ts` — type-coercion + getAllSettings smoke; new keys need entries.
- **Spec authority**: `docs/histforge-spec.md:578-595` (chunking §10), `:823-849` (render §13), `:253-286` (settings table §4).
- **No new tooling**: ffprobe ships alongside ffmpeg per `README.md:131-153`; no dependency change.

## Scope

**Doing**:

- Two new settings: `hook_video_clip_seconds` (number, default 8) and `hook_chunk_count` (int, default 15). Rendered on the Render tab.
- Rewrite hook-chunk grouping to walk sentences by `hook_video_clip_seconds`, mirroring the main-chunk loop, capped at `hook_chunk_count` chunks (or sentences-out, whichever first).
- Add an ffprobe wrapper in `14-render.ts` (signal-aware, mirrors `buildFfmpegExec`); thread it through `RenderDeps` as `probe`. Stage D uses `await probe(hookFinalPath)` for the xfade offset.
- Update the chunker + render tests to match the new behavior; add boundary-case tests (sentences shorter than clip target, sentences longer than clip target, sentences run out before count, custom settings).
- Update `docs/histforge-spec.md` §4 settings table, §10 chunking, §13.1 inputs, §13.2 crossfade math, and §13.3 Stage D to reflect configurability and the ffprobe-derived offset.

**Not doing**:

- **Per-provider clip-length settings.** Single global setting; operators retune between runs if mixing providers.
- **Auto-detecting ComfyUI clip duration** from workflow JSON. Manual setting first.
- **Per-chunk fallback for outlier chunks** whose audio span doesn't fit `clipSeconds` cleanly (time-stretch, hold-fill). Sentence-boundary snapping should keep this rare; revisit if it surfaces in real videos.
- **Backfill on existing in-flight DBs** is automatic via the existing `INSERT OR IGNORE` pattern in `createDb` (mirrors how `chapter_target_words` was retrofitted at `db.ts:450-455`).
- **Provider-side clip-duration parameterization** (e.g. plumbing a duration arg through `lib/video/google-flow.ts`). Treated as orthogonal — clip length is HistForge-side configuration, not a Flow API negotiation.

## Tasks

### Phase 1: Provider-aware hook chunking

End-to-end vertical slice: settings → chunker → tests → spec. Delivers the primary user-visible fix (chunk count = clip count, durations align modulo sentence-boundary jitter).

- [x] **Task 1.1: Seed defaults for `hook_video_clip_seconds` and `hook_chunk_count`**
  **Files**: `src/lib/db.ts`
  **What**: Add the two new keys to `DEFAULT_SETTINGS` (`"hook_video_clip_seconds": "8"`, `"hook_chunk_count": "15"`), in the same render-shape neighborhood as `aspect_ratio` / `long_edge_px` / `framerate`. Add two `INSERT OR IGNORE` migrations inside `createDb` so existing DBs that don't re-run `db:init` pick up the defaults — mirror the `chapter_target_words` retrofit pattern at `db.ts:450-455`.
  **Context**: `DEFAULT_SETTINGS` at `db.ts:11-59` defines the seeded values; `seedDefaultSettings` at `db.ts:61-71` walks the dict on `db:init`. The duplicate `INSERT OR IGNORE` in `createDb` is what catches DBs that were created before the new keys existed — without it, `getSetting` throws "Setting not seeded" against the chunker. Comment the migrations the same way `chapter_target_words` is at `db.ts:450-455`: "added after initial schema; seed for upgraded DBs that don't re-run db:init. Keep in sync with DEFAULT_SETTINGS".

- [x] **Task 1.2: Add Zod schemas + tests for the two new settings**
  **Files**: `src/lib/settings.ts`, `__tests__/unit/lib/settings.test.ts`
  **What**: Add to `SETTING_SCHEMAS`:
  - `hook_video_clip_seconds`: `z.coerce.number().min(1).max(60)` — fractional allowed (ComfyUI workflows can produce non-integer clip lengths).
  - `hook_chunk_count`: `z.coerce.number().int().min(1).max(50)` — integer.

  Add tests asserting type coercion (number, integer where applicable), default values (`8` and `15`), and out-of-range writes are rejected (`setSetting('hook_chunk_count', 0, db)` throws; same for `100`).
  **Context**: Schema pattern at `settings.ts:46-64` (`long_edge_px`, `framerate`, `chapter_count`). Existing coercion-test pattern at `__tests__/unit/lib/settings.test.ts` covers the `chapter_count` / `long_edge_px` shape — lift it. The bounds (60 s max clip, 50 max chunks) are sanity rails: a single hook clip longer than a minute is non-sensical, and 50 × 8 s = 400 s of hook is well past any editorial intent. No cross-field validation needed (unlike `act_distribution` ↔ `chapter_count`).

- [x] **Task 1.3: Surface the two settings on the Render tab**
  **Files**: `src/lib/settings-tabs.ts`, `src/app/settings/render-tab.tsx`
  **What**: Append `"hook_video_clip_seconds"` and `"hook_chunk_count"` to `TAB_FIELDS.render` (after `framerate`, before `chapter_count` so the visual grouping is "render-shape settings → script-shape settings"). Add two `NumberField`s to `RenderTab` in the same spot, with hints describing the semantics ("Provider's nominal clip length — 8 for Google Flow / Veo; set manually to match your ComfyUI workflow output." / "Number of hook clips to generate. Hook total ≈ count × clip seconds.").
  **Context**: Tab-fields pattern at `settings-tabs.ts:68-76`. UI pattern at `render-tab.tsx:39-58` — `NumberField` with `step` and `hint` props (existing primitive at `field-primitives.tsx:140-168`). Order matters because the tab renders fields in array order; render-shape group first reads cleaner.

- [x] **Task 1.4: Rewrite hook chunking to walk sentences by clip-length target**
  **Files**: `src/worker/steps/08-chunk.ts`
  **What**: Delete `HOOK_TARGET_SECONDS` and `HOOK_CHUNK_COUNT` constants. Add `db?: DatabaseType` to `ChunkDeps`; read `hook_video_clip_seconds` and `hook_chunk_count` from settings inside `runChunk`. Replace the entire hook-chunking block (`08-chunk.ts:44-110`) with a sentence-walking loop that mirrors the existing main-chunk loop (`08-chunk.ts:118-146`), parameterized by `clipSeconds` instead of `MAIN_TARGET_SECONDS`. Stop after `hookChunkCount` chunks OR when sentences run out (whichever first — accept short narrations gracefully; emit fewer hook chunks rather than empty ones). Update `Step.run` at `08-chunk.ts:174-176` to pass `db: ctx.db` alongside `projectsDir`.
  **Context**: The main-chunk loop at `08-chunk.ts:118-146` is the structural pattern: walk sentences, accumulate to target, cut at nearest sentence boundary, advance. The hook variant adds a count cap (`hookChunkCount`) and a kind/id flip (`"hook"` / `hook_NN`). Hook ends where the last accepted hook sentence ends; main starts at the next sentence (no gap, contiguous — preserves the existing `chunks[last].end == audio.end` invariant). Settings dep pattern mirrors `09-enrich-chunks.ts:11-19` and `:33` (optional `db` falls back to `getDb()`). Edge cases to handle: clipSeconds smaller than the smallest sentence (each chunk gets exactly one sentence — already correct under nearest-boundary logic); clipSeconds larger than total narration (chunk count caps at sentences-out, no empty groups). The old algorithm's "12 contiguous near-equal groups within a 120 s budget" invariant is intentionally gone — it was the source of the misalignment. Hook total is now `~hookChunkCount × clipSeconds ± sentence-jitter`, with no separate budget cap.

- [x] **Task 1.5: Update existing chunker tests + add boundary cases**
  **Files**: `__tests__/unit/worker/steps/chunk.test.ts`
  **What**: Update the three existing tests (`:54-141`, `:143-173`, `:175-229`) to use the new defaults: 15 hook chunks of ~8 s each instead of 12 of ~10 s. Use `freshDb()` from `step-fixtures.ts` to seed defaults; pass `{ projectsDir, db }` to `runChunk`. Assertions become `toHaveLength(15)` and `hookChunks[i].end - hookChunks[i].start ≈ 8` (within sentence-boundary tolerance). Drop the now-stale `expect(hookEnd).toBeLessThanOrEqual(120)` assertion at `:94` and `:217` — there is no fixed 120 s budget anymore; replace with a per-chunk duration assertion.

  Add three new tests:
  1. **Custom settings**: `setSetting("hook_chunk_count", 5, db); setSetting("hook_video_clip_seconds", 10, db)` → expect 5 hook chunks of ~10 s.
  2. **Sentences shorter than clipSeconds**: 1 s sentences + clipSeconds = 8 → each chunk ≈ 8 sentences; count = 15.
  3. **Sentences run out before count**: 30 sentences × 1 s = 30 s narration with clipSeconds = 8 and chunkCount = 15 → fewer than 15 hook chunks emitted, no empty groups, all sentences absorbed (zero main chunks is acceptable).
  **Context**: Existing test scaffolding (`buildAlignment`, `tempDir`) at `chunk.test.ts:14-51` is reusable. `freshDb` + `seedDefaultSettings` pattern at `step-fixtures.ts:25-30`; `setSetting` import from `@/lib/settings`. The "all sentences absorbed, no gaps, sum = audio length" invariants from the existing tests (`:132-140`) must keep passing — they're the regression net.

- [x] **Task 1.6: Update spec doc — chunking and settings table**
  **Files**: `docs/histforge-spec.md`
  **What**: Rewrite §10 (chunking, currently `:578-595`) to describe the clip-length-driven hook algorithm: "walk sentences accumulating ~`hook_video_clip_seconds` per group, cut at nearest sentence boundary; emit up to `hook_chunk_count` hook chunks; main chunks pick up where hook ended." Update the example JSON if needed (12 → 15 in any prose count). Add `hook_video_clip_seconds` and `hook_chunk_count` rows to the §4 settings table (`:253-286`), in the render-shape neighborhood (after `framerate`).
  **Context**: Spec is the source of truth (CLAUDE.md). Numbers that appear elsewhere in the spec (e.g. §13.1 `:829` "hook_01.mp4 ... hook_12.mp4 (~10s each)") are touched in Phase 2; this task only owns §4 + §10. Keep the prose general — no need to enumerate provider-specific defaults in the spec, just describe the contract.

### Phase 2: Defensive Stage D ffprobe + render spec update

Defense in depth — even with Phase 1 aligning chunker to provider, sentence-boundary snapping leaves ±1–2 s of residual drift accumulated across 15 chunks. ffprobe of the actual concat output makes Stage D's offset structurally correct regardless of upstream behavior.

- [x] **Task 2.1: Add a signal-aware ffprobe wrapper alongside `buildFfmpegExec`**
  **Files**: `src/worker/steps/14-render.ts`
  **What**: Add `buildFfprobeExec(signal?: AbortSignal): (path: string) => Promise<number>` — spawns `ffprobe` with `["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path]`, parses stdout as `parseFloat`, rejects on non-zero exit (with a stderr-tail message in the same shape as `buildFfmpegExec`). Signal threads through Node's spawn `signal` option for mid-render cancellation.
  **Context**: Pattern mirror of `buildFfmpegExec` at `14-render.ts:34-63`. ffprobe ships alongside ffmpeg (README.md:131-153) — relies on PATH the same way ffmpeg does. The `-of default=noprint_wrappers=1:nokey=1` formatter prints just the duration value, no wrapping; `-v error` silences progress noise so stdout is parseable. Reject if `parseFloat` returns NaN — ffprobe should always emit a number for valid media, NaN means the file is corrupted or zero-length and the renderer should fail loudly rather than treating it as offset=NaN.

- [x] **Task 2.2: Thread `probe` through `RenderDeps` / `RenderStepDeps` and use it in Stage D**
  **Files**: `src/lib/render.ts`, `src/worker/steps/14-render.ts`
  **What**: Add `probe: (path: string) => Promise<number>` to `RenderDeps` at `render.ts:203-216` (required, like `exec`). Add the optional override `probe?: (path: string) => Promise<number>` to `RenderStepDeps` at `14-render.ts:9-24` (mirroring the optional `exec?` shape). In `runRender` at `14-render.ts:69-91`, build the production probe via `deps.probe ?? buildFfprobeExec(deps.signal)` — same fallback shape as `exec` at `:81`. In `lib/render.ts` Stage D (`:368-394`), replace the chunk-derived `hookDuration` with `const hookDuration = await deps.probe(hookFinalPath);`. Drop the now-stale "spec :580 ±a few seconds" comment block at `:369-371`; replace with a short note explaining why the probe is structurally needed (chunker target + sentence-boundary snapping = real duration only knowable post-concat).
  **Context**: `RenderDeps` shape at `render.ts:203-216` is the dep-injection surface tests already use. The "no hook chunks" branch at `:395-398` skips Stage D's xfade entirely (just a copy) — leave that branch untouched, ffprobe runs only inside `hookChunks.length > 0`. Probe is awaited; the surrounding `render` is already async. Tests pass `vi.fn().mockResolvedValue(...)` instead of doing real spawns, identical to how they mock `exec`.

- [x] **Task 2.3: Update render tests for the ffprobe-driven offset**
  **Files**: `__tests__/unit/lib/render.test.ts`, `__tests__/unit/worker/steps/render.test.ts`
  **What**: All existing tests in `__tests__/unit/lib/render.test.ts:203-479` (the entire `render() orchestration` describe block, 10 tests touching `render(...)`) must now pass a `probe` mock — add `probe: vi.fn().mockResolvedValue(<duration>)` to every `render(...)` call site. Update the Stage D assertion at `:299-302`: instead of `offset=20` (chunk-derived from a 0–20 s hook fixture), set `probe` to return e.g. `15.5` and assert `offset=15.5` — proves the renderer trusts ffprobe over chunk timestamps. Add a new test: "Stage D offset = ffprobe-reported duration regardless of chunk timestamps" — set chunks with hook span 0–20, mock probe to return 17.3, assert the xfade arg contains `offset=17.3`. Update both step-level tests at `__tests__/unit/worker/steps/render.test.ts:67-121` (the two `it` blocks under `render step (step 14)`) similarly: mock `probe` alongside `exec` on each `runRender` call.
  **Context**: Existing test fixtures at `render.test.ts:204-232` produce a 0–20 s hook span. The "no hook chunks" test at `:388-430` doesn't enter the ffprobe branch — pass a `probe` mock anyway for type compliance, but expect `probe` not to be called (`expect(probe).not.toHaveBeenCalled()`). The step-level tests inject `probe` via `RenderStepDeps` (the new optional dep added in Task 2.2).

- [x] **Task 2.4: Update spec doc — render section**
  **Files**: `docs/histforge-spec.md`
  **What**: Update §13.1 inputs (`:828-829`) to say `hook_NN.mp4` (clip count is variable, not "01..12"). Update §13.2 (`:837-848`) where the hook→main math says "hook_concat is rendered to `120 s + CF`" — replace the literal 120 s with a description that the hook duration is whatever the concat produces, measured at render time. Update §13.3 Stage D (`:878-879`) to mention the ffprobe-derived offset. No need to over-specify ffprobe args in the spec — "the renderer ffprobes `hook_final.mp4` to get the xfade offset" is sufficient.
  **Context**: Spec touches must be additive/clarifying, not prescriptive about implementation details (which belong in code comments). Keep the spec language general enough that swapping ffprobe for an alternate duration source later doesn't require a doc edit.

## References

- Research doc: `docs/research/2026-05-09-hook-video-audio-duration-mismatch.md`
- Chunker: `src/worker/steps/08-chunk.ts:6-178`
- Render Stage D: `src/lib/render.ts:368-398`
- Render step entry: `src/worker/steps/14-render.ts:34-115`
- Settings infrastructure: `src/lib/db.ts:11-59`, `src/lib/settings.ts:13-127`, `src/lib/settings-tabs.ts:68-76`, `src/app/settings/render-tab.tsx`
- Existing tests: `__tests__/unit/worker/steps/chunk.test.ts`, `__tests__/unit/lib/render.test.ts`, `__tests__/unit/worker/steps/render.test.ts`, `__tests__/unit/lib/settings.test.ts`
- Spec sections to update: `docs/histforge-spec.md:253-286` (settings table — Phase 1), `:578-595` (§10 chunking — Phase 1), `:828-829` (§13.1 inputs — Phase 2), `:837-848` (§13.2 crossfade math — Phase 2), `:878-879` (§13.3 Stage D — Phase 2)
