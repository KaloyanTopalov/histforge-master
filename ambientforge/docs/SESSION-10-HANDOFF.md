# Session 10 Handoff

Written end-of-session 2026-04-28. Read this first tomorrow.

> **Numbering note.** This "Session 10" is **not** the PLAN.md Session 10 (which is YT Data API OAuth + handle resolver — still pending). The operator opted to take a multi-workflow refactor first, ahead of the canonical 13-session build order. PLAN.md sessions 9 (scheduler) and 10/11/12 (YT-OAuth + stats fetcher + analytics) and 13 (live-mode flip) all still need their own future sessions.

## 1. Where we are right now

- **Sessions 1-8 + 4.5 + 4.6 + 4.7 + this Session 10** all committed. Recent commit hashes:
  - `e43e5f7` **session 10: multi-workflow architecture + per-channel config + dashboard form refactor + rap-compilation workflow** (today)
  - `c35e4ea docs: session 4.8 handoff for tomorrow`
  - `4e3d6da session 4.7: wire distrokid extension handlers for real`
  - `e70eb46 docs: session 4.7 handoff for tomorrow`
  - `df05178 docs: flow extension setup runbook`
  - `006da42 session 4.6 follow-up: openrouter fence-stripping + tracks_per_album_override for testing`
  - `50e5f90 session 4.6: vendor + rewrite browser captcha solver for current suno ui`
- **Schema bumped v4 → v5.** 17 new `channels` columns + 1 new `albums.workflow` column. All defaults are backwards-compatible — existing channel `01KQ7HRA4SJ9GX6JMC4Q3CNWR1` (sad-ambient-01) auto-migrates to `workflow='ambient'` via column `DEFAULT`. No backfill required.
- **Two workflows ship:** `ambient` (existing pipeline preserved bit-for-bit) and `rap-compilation` (new — concat-only audio + B-roll video mux). Adding a third workflow now means a registry entry + a few step variants, not a fork of the orchestrator.

## 2. What works real end-to-end (validated 2026-04-28)

| Capability | Evidence |
|---|---|
| Schema migration v4 → v5 with 17 new channel cols + 1 album col | `npm test` passes 250 tests; existing channel `01KQ7HRA…` reads back fine via `channels` repo |
| Workflow registry: `getWorkflow('ambient')` + `getWorkflow('rap-compilation')` | `src/worker/__tests__/workflows.test.ts` 5 tests green |
| `resolveChannelPrompt` resolution order: channel-db → channel-file → workflow-default | `src/lib/__tests__/resolve-channel-prompt.test.ts` 6 tests green |
| Pipeline orchestrator: workflow log on start, preflight checks before step 01 | `src/worker/pipeline.ts` + workflow injection from runner |
| Runner: per-album workflow resolution + workflow-specific `branchB` injected into deps | `src/worker/runner.ts` |
| Rap pipeline end-to-end (07-rap → 09-rap): 5 fixture WAVs + 12 generated B-roll clips → `final.mp4` (h264+aac, duration ≈ Σtracks ±3s) | `src/worker/__tests__/rap-pipeline-e2e.test.ts` passes in ~5s |
| API: rap workflow validation (POST without brollFolderPath → 400; POST with <10 clips → 400) | `src/app/api/__tests__/channels-rap-validation.test.ts` 5 tests green |
| API: `GET /api/channels/validate-broll?path=…` runs preflight | same file |
| API: `POST /api/channels/preview-prompt` with mock-mode returns parsed mock JSON + schema check | `src/app/api/__tests__/preview-prompt-api.test.ts` 4 tests green |
| Dashboard form: 7 collapsible sections, workflow-aware show/hide, Test Prompt + Validate Folder buttons | `src/app/channels/_components/ChannelFormBody.tsx` (~470 lines) |
| Channel detail page: workflow badge, B-roll info card (rap only), prompt-source indicators, workflow column on albums table | `src/app/channels/[id]/page.tsx` + `edit-form.tsx` |

**Tests:** 215 → 250 (+35 new, all green). Lint clean. `tsc --noEmit` clean.

**Build caveat:** `next build` couldn't complete because `.next/trace` was held by another node process during the session (probably from `npm run dev`). Lint + tsc + tests all pass — high confidence the code is correct. Tomorrow: `Ctrl+C` any running dev, then `npm run build` should green.

## 3. Locked decisions during planning (2026-04-28)

These were the four blocking questions answered before writing code. Recorded here so a future session doesn't re-litigate them:

1. **Schema version.** v4 → v5 (the source prompt's "v5 → v6" was a numbering slip; codebase was on v4 from Session 4.5).
2. **Dormant template-name columns** (`album_brief_template`, `track_briefs_template`, `cover_prompt_template`, `thumbnail_prompt_template`, `yt_metadata_template`). **Left in DB, ignored by new code.** They were never read by step modules even before Session 10. A future v6 cleanup can drop them. Don't reference them in new code.
3. **Workflow editability.** Editable when no album for that channel is `in_progress` (same rule as other channel fields, enforced via the existing `hasInProgress` PATCH guard). The API runs cross-field validation: switching to `workflow='rap-compilation'` on PATCH re-runs B-roll preflight inline.
4. **B-roll fixtures.** Generated at test-setup time via FFmpeg `lavfi color=…`, **NOT committed**. The rap e2e test has its own `beforeAll` that produces 12 fixtures under `tests/fixtures/broll/rap-test/`. Operator can also run `tsx scripts/generate-broll-fixtures.ts` manually.

## 4. The new architecture in 60 seconds

```
Channel row (workflow='ambient' | 'rap-compilation')
        │
        ▼
src/worker/workflows/index.ts (registry: getWorkflow, listWorkflows, UnknownWorkflowError)
        │  ┌── ambient.ts ── branchB = 07 → 08 → 09
        │  └── rap-compilation.ts ── branchB = 07-rap → 09-rap (no 08), preflight = broll folder valid
        ▼
src/worker/pipeline.ts (workflow-driven orchestrator)
        │
        ├── log workflow=name
        ├── run preflightChecks (any !ok throws PipelineError before step 01)
        ├── 01 → 02 → 03 → 04 → 05a → 05b   (sequential, unchanged)
        ├── PARALLEL FORK: branchA (06) || workflow.branchB
        └── 10 → 11   (sequential, post-join, unchanged)

src/lib/prompts.ts:resolveChannelPrompt(channel, kind)
        ├── 1. channel.prompt_<kind>            → 'channel-db'      (operator-edited via dashboard textarea)
        ├── 2. prompts/channel-templates/<id>/<kind>.md → 'channel-file' (legacy power-user override)
        └── 3. prompts/defaults/<workflow-basename>.md → 'workflow-default'
                where basename is workflow-aware:
                  ambient + cover-image  → cover-prompt.md (legacy name, preserved)
                  rap     + cover-image  → cover-image-rap.md
                  ambient + thumbnail    → thumbnail-prompt.md (legacy name)
                  rap     + thumbnail    → thumbnail-rap.md
                  …etc for album-brief, track-briefs, yt-metadata
```

**Key contract:** every step that loads a prompt logs `prompt loaded source=<src> kind=<kind> origin=<origin>`. `<src>` is one of `channel-db`, `channel-file`, `workflow-default`. Operators can grep pipeline.log to see exactly which prompts a channel is using.

## 5. Files added — 22 (committed in `e43e5f7`)

**Worker / pipeline:**
- `src/worker/workflows/index.ts` — registry + UnknownWorkflowError
- `src/worker/workflows/types.ts` — interfaces (no runtime imports — avoids cycles)
- `src/worker/workflows/ambient.ts` — ambient definition
- `src/worker/workflows/rap-compilation.ts` — rap definition + branchB composition + preflight check
- `src/worker/steps/07-rap-audio-concat.ts` — concat-only audio (no loop step)
- `src/worker/steps/09-rap-broll-mux.ts` — per-track B-roll selection + concat + trim + final mux

**Lib:**
- `src/lib/broll/select.ts` — deterministic clip selection (3 strategies: random-fill, sequential, seeded-by-album)
- `src/lib/broll/preflight.ts` — folder validation + codec detection (ffprobe-based)
- `src/lib/tracks-per-album.ts` — shared `resolveTracksPerAlbum(channel, workflow)` (override > channel > workflow default)

**API:**
- `src/app/api/channels/validate-broll/route.ts` — GET preflight endpoint
- `src/app/api/channels/preview-prompt/route.ts` — POST prompt-test endpoint (handles mock + live LLM)

**UI components:**
- `src/app/channels/_components/ChannelFormBody.tsx` — 7-section shared form body (470 lines, used by both new + edit pages)
- `src/components/CollapsibleSection.tsx` — `<details>`-based section
- `src/components/PromptTestButton.tsx` — inline test button + result card (mirrors VerifyArtistButton pattern)
- `src/components/BrollValidateButton.tsx` — inline broll-validate button + result card

**Default templates (rap):**
- `prompts/defaults/album-brief-rap.md`
- `prompts/defaults/track-briefs-rap.md` — 10-track full-lyrics mock
- `prompts/defaults/cover-image-rap.md`
- `prompts/defaults/thumbnail-rap.md`
- `prompts/defaults/yt-metadata-rap.md`

**Tooling:**
- `scripts/generate-broll-fixtures.ts` — FFmpeg color-source generator (12 clips)

**Tests:** 7 new test files (35 new tests).

## 6. Files modified — 21 (committed in `e43e5f7`)

| File | Change |
|---|---|
| `src/lib/db.ts` | DB_VERSION=5 + 18 ALTER TABLE statements (idempotent via existing `addColumn` try-catch) |
| `src/lib/repos/channels.ts` | Channel/ChannelInput types extended; PATCHABLE map + row mapper updated; new enum exports (WORKFLOWS, YOUTUBE_IMAGE_ASPECTS, RAP_CLIP_STRATEGIES) |
| `src/lib/repos/albums.ts` | `workflow` column read in row mapper; `create` reads `channel.workflow` and snapshots it onto the album |
| `src/lib/prompts.ts` | + `PromptKind`, `PromptSource`, `ResolvedPrompt`, `defaultPromptBasename`, `resolveChannelPrompt`. Kept legacy `loadTemplate` for back-compat (only `lib/flow/llm-image-prompt.ts` used to call it; that's now refactored too) |
| `src/lib/flow/llm-image-prompt.ts` | Now takes `templateContent` directly; caller resolves the prompt and passes content |
| `src/worker/pipeline.ts` | Optional `deps.workflow.preflightChecks` runs before step 01; logs `workflow=<name>` |
| `src/worker/runner.ts` | Resolves workflow per-album; injects workflow's `branchB` + workflow object into pipeline deps |
| `src/worker/steps/01-album-brief.ts` | resolveChannelPrompt + log source |
| `src/worker/steps/02-track-briefs.ts` | resolveChannelPrompt + dynamic track count from `resolveTracksPerAlbum(channel, workflow)` |
| `src/worker/steps/05a-cover-image.ts` | resolveChannelPrompt + per-channel `youtubeImageAspect` |
| `src/worker/steps/05b-thumbnail.ts` | resolveChannelPrompt + log source |
| `src/worker/steps/06-distrokid-submit.ts` | Channel credit overrides (`distrokidSongwriterName`, `distrokidPerformerName/Role`, `distrokidProducerName/Role`); unified-name string is split on whitespace into DK's first/middle/last form fields |
| `src/worker/steps/08-loop-to-2h.ts` | per-channel `targetVideoSeconds` overrides global setting |
| `src/worker/steps/10-youtube-metadata.ts` | resolveChannelPrompt + log source |
| `src/app/api/channels/route.ts` | Zod schema for 17 new fields; cross-field rap validation (POST) |
| `src/app/api/channels/[id]/route.ts` | PATCH schema + cross-field validation when effective workflow=rap |
| `src/app/channels/new/page.tsx` | Now wraps shared `ChannelFormBody` |
| `src/app/channels/[id]/edit-form.tsx` | Read-only view + edit mode wrapping `ChannelFormBody` + new `PromptSourceSummary` |
| `src/app/channels/[id]/page.tsx` | Workflow badge, B-roll card (rap only), async server component, workflow column on albums table |
| `src/worker/steps/__tests__/step-02.test.ts` | Sets `channel.promptTrackBriefs` (channel-db path) instead of mocking `loadTemplate` |
| `src/worker/steps/__tests__/step-05b.test.ts` | Channel-templates override path is now `thumbnail.md` (kind-based) instead of `thumbnail-prompt.md` (default-basename-based) |

## 7. Channel-templates filename change (small contract change)

**Before Session 10:** legacy power-user override file `prompts/channel-templates/<channelId>/thumbnail-prompt.md` (matching the default basename).

**After Session 10:** override file is `prompts/channel-templates/<channelId>/thumbnail.md` (matching `PromptKind`, not the default basename). Same for the other kinds:

| Kind | Channel-templates filename (Session 10+) | Old filename (NEVER USED IN PRODUCTION) |
|---|---|---|
| `album-brief` | `album-brief.md` | (same) |
| `track-briefs` | `track-briefs.md` | (same) |
| `cover-image` | `cover-image.md` | `cover-prompt.md` |
| `thumbnail` | `thumbnail.md` | `thumbnail-prompt.md` |
| `yt-metadata` | `yt-metadata.md` | (same) |

No production overrides exist yet, so this is a transparent rename. **The default-file basenames in `prompts/defaults/` are unchanged** (still `cover-prompt.md` and `thumbnail-prompt.md` for ambient) — this preserves backward compat for the existing default files. New rap defaults use `*-rap.md` suffix.

## 8. The 17 new channel columns (cheat sheet)

```
workflow                       TEXT NOT NULL DEFAULT 'ambient'   -- 'ambient' | 'rap-compilation'
tracks_per_album               INTEGER                           -- override workflow default (30 ambient, 10 rap)
target_video_seconds           INTEGER                           -- ambient only; null = use settings.target_video_seconds
broll_folder_path              TEXT                              -- rap only; absolute path to a folder of .mp4/.mov/.webm/.mkv
suno_style_prompt              TEXT                              -- "voice of channel" — interpolated into step 01's LLM template
prompt_album_brief             TEXT                              -- per-channel content (NOT a name) for step 01's prompt
prompt_track_briefs            TEXT                              -- step 02
prompt_cover_image             TEXT                              -- step 05a
prompt_thumbnail               TEXT                              -- step 05b
prompt_yt_metadata             TEXT                              -- step 10
youtube_image_aspect           TEXT                              -- 'letterbox' | 'crop'; null = use global setting
distrokid_songwriter_name      TEXT                              -- unified "First Last"; split on whitespace into DK form
distrokid_performer_name       TEXT                              -- channel override; null = use global setting
distrokid_performer_role       TEXT                              -- channel override; null = use global setting
distrokid_producer_name        TEXT                              -- channel override; null = use global setting
distrokid_producer_role        TEXT                              -- channel override; null = use global setting
rap_clip_strategy              TEXT                              -- 'random-fill' | 'sequential' | 'seeded-by-album'; null = random-fill default
```

Plus on `albums`:

```
workflow                       TEXT NOT NULL DEFAULT 'ambient'   -- snapshot at album creation time (immutable per album)
```

## 9. Open follow-ups (prioritized)

1. **PLAN.md Session 10 (YT Data API OAuth + handle resolver) is still pending** — that's the canonical "Session 10" per `docs/PLAN.md` § 2. Do this next if you want the daily stats fetcher running.
2. **PLAN.md Session 9 (channel scheduler — cron parsing, auto-enqueue)** — also still pending. Required to actually run weekly albums on schedule. The new `workflow` column on `albums` already gets snapshotted by `albums.create`, so the scheduler doesn't need any workflow-aware changes.
3. **`chrome.debugger`-based credits-toggle auto-click** in DistroKid extension. Same priority as before Session 10 (still operator gesture #2). Per `docs/SESSION-4.8-HANDOFF.md` §6 item 1.
4. **First production rap channel.** With the form UX in place, the operator can now create a rap-compilation channel via the dashboard. Workflow:
   1. Drop ~15-30 video clips into a folder (e.g., `C:\Projects\broll\rap-night-drive\`)
   2. POST /channels (or use form) with `workflow='rap-compilation'`, `brollFolderPath=…`, custom `sunoStylePrompt`
   3. (Optional) drop in custom `prompt_*` content via the form's LLM Prompts section
   4. Trigger an album. Step 06 still needs the same DK manual gestures (drag-drop + add-credits) as ambient.
5. **Rap track count default.** Currently `defaultTracksPerAlbum: 10` in `rap-compilation.ts`. If 10 feels too short, change to 12-15 — single-line edit, no schema impact.
6. **Drop dormant template-name columns in v6.** A small future migration removes 5 unused columns. Decision deferred.
7. **`pretest` hook to generate B-roll fixtures.** Currently the rap-pipeline-e2e test's `beforeAll` does this. Adding `"pretest": "tsx scripts/generate-broll-fixtures.ts"` to `package.json` would mean `npm test` always has fixtures available — but slows test cold-start. Decide based on how often you `npm test` from cold.
8. **Real-time prompt-source indicators.** The dashboard's `PromptSourceSummary` infers source from `channel.promptXxx ? channel-db : workflow-default`, skipping the `channel-file` middle layer. A small server action that calls `resolveChannelPrompt` would correctly show `channel-file` for power-user overrides.
9. **B-roll preview thumbnails in the form.** Today operator sees clip count + sample filenames. Loading the first 3 clips' first frames as `<video>` thumbnails would make folder selection less blind.
10. **Snapshot tests for the dashboard.** Check I (channel detail page) is currently code-review-only; a Playwright run that hits `/channels/<id>` for both an ambient and rap channel would catch regressions.

## 10. Known gotchas to remember

- **`deps.workflow` in `PipelineDeps` is OPTIONAL.** Tests that inject custom `branchA`/`branchB` typically don't inject `workflow`, so preflight is skipped — preserves the existing pipeline-test behavior. The runner ALWAYS injects it in production. If a future test needs preflight, pass `deps.workflow = { name: 'rap-compilation', preflightChecks: rapWorkflow.preflightChecks }`.
- **`workflows/index.ts` imports `rap-compilation.ts` which imports the 07-rap + 09-rap step modules at module load.** This means anything that imports `getWorkflow` at top level transitively pulls in those step modules. No circular dependency (verified) but worth knowing if you add a new workflow that imports anything weird.
- **`generateImagePrompt` signature changed.** It used to take `templateName`; now takes `templateContent`. Caller resolves via `resolveChannelPrompt` and passes `.content`. Step 05a does this.
- **`channelsRepo.get(input.channelId)` is now called inside `albumsRepo.create()`** to read the workflow snapshot. If a test creates an album with a channelId that doesn't exist in DB, create falls back to `'ambient'` rather than throwing. Same as the prior behavior of allowing pseudo-orphan albums in tests.
- **`step 02`'s Zod schema's `z.array(...).length(N)` validates the LLM response.** With `tracks_per_album_override=0` (prod) on a rap channel, N=10 (workflow default). The default rap `track-briefs-rap.md` ships with exactly 10 tracks. If you change rap's `defaultTracksPerAlbum`, also update the mock-response in `track-briefs-rap.md` to match — otherwise mock-mode rap albums fail.
- **DistroKid form expects first/middle/last songwriter, but the channel column is unified.** `splitSongwriter()` in step 06 splits on whitespace: "Kaloyan Topalov" → first="Kaloyan", last="Topalov". Single-word names get last="" which DK rejects — surface as `DISTROKID_*` error if it ever happens.
- **Build can't run while dev is running.** Same as `docs/SESSION-4.8-HANDOFF.md` §10 item 3. Stop dev with `Ctrl+C` before `npm run build`.

## 11. Disk artifacts from today's smoke test

The rap-pipeline-e2e test produces these in a tempdir, then cleans up. Equivalent to what a real rap album would produce under `projects/<channel_id>/<album_id>/`:

```
projects/<ch>/<alb>/
├── (no cover.png — step 05a not exercised by this test)
├── (no thumb.png — step 05b not exercised)
├── (no ytImage.png — step 05a not exercised)
├── final.mp4                          1920x1080  h264+aac, ~30s for 5 fixture WAVs
└── build/
    ├── concat.wav                     ~30s — sum of 5 fixture WAVs (no loop.wav)
    ├── song-01-final.mp4              h264 — 1 song's worth of B-roll, trimmed
    ├── song-02-final.mp4
    ├── song-03-final.mp4
    ├── song-04-final.mp4
    ├── song-05-final.mp4
    └── full-video.mp4                 stream-copy concat of song-NN-final.mp4
```

For a real production rap album the 30 .wav files in `songs/` would be present (from step 04), step 05a would produce cover.png + ytImage.png, step 05b → thumb.png. Steps 07-rap + 09-rap reference `songs/*.wav` via the tracks repo just like step 07 does.

## 12. Current process state at end of session

Process state at the START of this session was unchanged from `SESSION-4.8-HANDOFF.md` §8. During this session I touched only files (no service restarts, no DB writes outside vitest's `:memory:` instances). At end of session:

- **`npm run dev`** — operator's call, was running before session, still running after
- **Suno-login Chrome (port 9333)** — same as 4.8 handoff
- **Daily Chrome with extensions** — same as 4.8 handoff
- **Python sidecar** — same as 4.8 handoff
- **Database `data/ambientforge.db`** — schema still v4 on disk! Session 10 bumped DB_VERSION=5 in code; the actual `runMigrations()` ALTER TABLE statements will run on next `getDb()` call (e.g., next dashboard request or worker tick). The migrations are idempotent (`addColumn` try-catch) so this is safe.
- **Test runs touched only `:memory:` databases** — production `data/ambientforge.db` was NOT migrated by tests.

**Settings:** unchanged from 4.8 handoff.

## 13. Tomorrow's pickup steps

1. **Verify migrations on first DB hit.** Open the dashboard at `http://localhost:3003/channels` (or hit any API route). The `getDb()` singleton runs `initSchema` → `runMigrations` → seeds DEFAULT_SETTINGS. Confirm via:
   ```powershell
   sqlite3 data/ambientforge.db "SELECT value FROM settings WHERE key='db_version'"
   # expect: 5
   sqlite3 data/ambientforge.db "PRAGMA table_info(channels)" | findstr workflow
   # expect: workflow|TEXT|1||'ambient'
   ```
2. **Visit `/channels/01KQ7HRA4SJ9GX6JMC4Q3CNWR1`.** Confirm:
   - Workflow badge shows `ambient`
   - Albums table has the new `Workflow` column (all rows show `ambient`)
   - Edit Configuration shows the new collapsible sections
   - PromptSourceSummary shows all 5 prompts as `workflow-default`
3. **Decide what to pick up next.** The operator-stated highest-value items in priority order are:
   - **PLAN.md Session 9 (scheduler).** Required to run weekly albums on schedule. Is the natural next session.
   - **A real rap-compilation production channel.** Drop B-roll in a folder, POST a channel via the dashboard form, trigger an album. Smoke-test the full rap pipeline against real Suno + Flow + DistroKid. Burns ~10 Suno credits per album.
   - **PLAN.md Session 10 (YT OAuth).** Slightly out of order numerically because we used "Session 10" as the multi-workflow refactor name. Required to start daily stats fetching.
   - **Session 4.8 (chrome.debugger credits-toggle auto-click).** Lifts the second operator gesture in DK. ~1h.

## 14. End-of-session machine state recommendation

Same as `SESSION-4.8-HANDOFF.md` §12 — operator's call. Either stop dev cleanly to free `.next/trace` and confirm `npm run build` is green, or leave dev running for fast pickup tomorrow. The migrations are idempotent so DB state will catch up either way.
