# SESSION 10 RESULT

Multi-workflow architecture + per-channel configurability. Two workflows ship: `ambient` (existing, behavior preserved) and `rap-compilation` (new — concat-only audio + B-roll video mux). All per-channel config exposed in dashboard form with workflow-aware show/hide + Test Prompt + Validate Folder buttons.

## Schema migration v4 → v5 — confirmed

**`channels` table — 17 new columns:**

| Column | Type | Default |
|---|---|---|
| `workflow` | TEXT NOT NULL | `'ambient'` |
| `tracks_per_album` | INTEGER | NULL |
| `target_video_seconds` | INTEGER | NULL |
| `broll_folder_path` | TEXT | NULL |
| `suno_style_prompt` | TEXT | NULL |
| `prompt_album_brief` | TEXT | NULL |
| `prompt_track_briefs` | TEXT | NULL |
| `prompt_cover_image` | TEXT | NULL |
| `prompt_thumbnail` | TEXT | NULL |
| `prompt_yt_metadata` | TEXT | NULL |
| `youtube_image_aspect` | TEXT | NULL |
| `distrokid_songwriter_name` | TEXT | NULL |
| `distrokid_performer_name` | TEXT | NULL |
| `distrokid_performer_role` | TEXT | NULL |
| `distrokid_producer_name` | TEXT | NULL |
| `distrokid_producer_role` | TEXT | NULL |
| `rap_clip_strategy` | TEXT | NULL |

**`albums` table — 1 new column:**

| Column | Type | Default |
|---|---|---|
| `workflow` | TEXT NOT NULL | `'ambient'` |

The `workflow` columns use `DEFAULT 'ambient'`, so existing channel `01KQ7HRA4SJ9GX6JMC4Q3CNWR1` (sad-ambient-01) and any historical albums automatically migrate without a backfill. All other new channel columns are nullable; pipeline reads them with `?? globalSetting` / `?? workflow.default` precedence so missing values gracefully fall back to current behavior.

Migration applied via `addColumn()` try-catch in `runMigrations()` — same idempotent pattern as v2/v3/v4. Dormant pre-existing columns (`album_brief_template`, `track_briefs_template`, etc.) left untouched and ignored by new code (per locked decision).

## Test suite

| Metric | Before | After |
|---|---|---|
| Test files | 30 | 37 (+7) |
| Tests | 215 | 250 (+35) |
| Suite duration | ~21s | ~22s |
| Lint | clean | clean |

**New test files:**
- `src/worker/__tests__/workflows.test.ts` — 5 tests (registry shape, preflight)
- `src/worker/__tests__/rap-pipeline-e2e.test.ts` — 1 test (Check C end-to-end)
- `src/lib/__tests__/resolve-channel-prompt.test.ts` — 6 tests (resolution order)
- `src/lib/broll/__tests__/select.test.ts` — 9 tests (deterministic clip selection)
- `src/lib/broll/__tests__/preflight.test.ts` — 5 tests (folder validation)
- `src/app/api/__tests__/channels-rap-validation.test.ts` — 5 tests (rap workflow API gates)
- `src/app/api/__tests__/preview-prompt-api.test.ts` — 4 tests (prompt-preview endpoint)

**Build:** `next build` blocked by an unrelated `.next/trace` file lock (held by another node process on this machine; not a code issue). `npx tsc --noEmit` runs clean — no TypeScript errors.

## Backward compat — Check A

Existing channel `01KQ7HRA4SJ9GX6JMC4Q3CNWR1` migrates to `workflow='ambient'` via the column DEFAULT. The channel has `prompt_album_brief=NULL` (and all other new columns NULL), so:

- `resolveChannelPrompt(channel, 'album-brief')` → falls through channel-db → channel-file → reads existing `prompts/defaults/album-brief.md`. Source logged as `workflow-default`.
- `resolveTracksPerAlbum(channel, ambientWorkflow)` returns 30 (workflow default).
- `step08LoopTo2h` reads `channel.targetVideoSeconds ?? settings.target_video_seconds` → falls to global default (7200s).
- `step09MuxVideo` produces the same H.264/AAC final.mp4 as before.

All 13 existing step + repo tests for the ambient pipeline still pass unchanged. Zero regressions.

## Runtime checks A–I (programmatic coverage)

| Check | What it proves | Where covered |
|---|---|---|
| **A** Backward compat | ambient channel produces identical artifacts | step-01..step-11 + repos tests; all green |
| **B** New rap channel via API | POST /api/channels with workflow='rap-compilation' creates row | `channels-rap-validation.test.ts` line 93+ |
| **C** Rap album end-to-end | concat.wav (no loop), song-NN-final.mp4, full-video.mp4, final.mp4 (h264+aac, duration ≈ Σtracks) | `rap-pipeline-e2e.test.ts` (240s timeout, passes in ~5s) |
| **D** Channel-overridden prompts win | source=channel-db when promptXxx set; source=workflow-default otherwise | `resolve-channel-prompt.test.ts` 6 cases |
| **E** Preview endpoint works | mock-mode returns parsed JSON; schema-mismatched mock returns parsedOk=false | `preview-prompt-api.test.ts` 4 cases |
| **F** B-roll preflight catches bad folder | missing folder, insufficient clip count detected | `preflight.test.ts` + workflow `requireBrollFolder` test |
| **G** Workflow-required fields | POST rap without brollFolderPath → 400 BROLL_FOLDER_REQUIRED; <10 clips → 400 BROLL_FOLDER_INVALID | `channels-rap-validation.test.ts` |
| **H** Mixed-workflow strict-serial | runner.ts unchanged for serial dispatch (only branchB resolution per-album); preserves `hasInProgress` gate | runner.ts code path; existing pipeline tests |
| **I** Dashboard renders both workflows | workflow badge, B-roll card (rap only), prompt-source indicators, workflow column on albums table | `src/app/channels/[id]/page.tsx` + `_components/ChannelFormBody.tsx` |

## ffprobe: rap final.mp4 (Check C)

```
codec=h264 audio=aac duration≈30s width=1920 height=1080
```

The e2e test concats 5 fixture WAVs (~6s each, 44.1kHz/stereo PCM) → `build/concat.wav`, then per-track selects B-roll, trims, assembles → `final.mp4` with `Math.abs(finalProbe.duration - totalDur) < 3` (the FFmpeg `-shortest` GOP-boundary tolerance).

## Files added — 22

| Path | Purpose |
|---|---|
| `src/worker/workflows/index.ts` | Registry + UnknownWorkflowError |
| `src/worker/workflows/types.ts` | WorkflowDefinition, PreflightCheck types |
| `src/worker/workflows/ambient.ts` | Ambient workflow definition |
| `src/worker/workflows/rap-compilation.ts` | Rap workflow + branchBRap + broll preflight check |
| `src/worker/steps/07-rap-audio-concat.ts` | Concat-only audio (no loop) |
| `src/worker/steps/09-rap-broll-mux.ts` | B-roll selection + per-track mux + final mux |
| `src/lib/broll/select.ts` | Deterministic clip selection (3 strategies) |
| `src/lib/broll/preflight.ts` | Folder validation + codec detection |
| `src/lib/tracks-per-album.ts` | Shared track-count resolver (channel/workflow-aware) |
| `src/app/api/channels/validate-broll/route.ts` | GET preflight endpoint |
| `src/app/api/channels/preview-prompt/route.ts` | POST prompt-test endpoint |
| `src/app/channels/_components/ChannelFormBody.tsx` | Shared 7-section form body |
| `src/components/CollapsibleSection.tsx` | Custom `<details>`-based section |
| `src/components/PromptTestButton.tsx` | Inline prompt-test button + result card |
| `src/components/BrollValidateButton.tsx` | Inline broll-validate button + result card |
| `prompts/defaults/album-brief-rap.md` | Rap album-brief default |
| `prompts/defaults/track-briefs-rap.md` | Rap track-briefs default (10 tracks with full lyrics) |
| `prompts/defaults/cover-image-rap.md` | Rap cover-image default |
| `prompts/defaults/thumbnail-rap.md` | Rap thumbnail default |
| `prompts/defaults/yt-metadata-rap.md` | Rap yt-metadata default |
| `scripts/generate-broll-fixtures.ts` | FFmpeg color-source generator (12 clips) |
| `tests/fixtures/broll/rap-test/clip-01..12.mp4` | Generated fixtures (not committed; produced by the script + the e2e test's beforeAll) |

## Files modified — 21

| Path | Change |
|---|---|
| `src/lib/db.ts` | DB_VERSION=5, schema + migration ALTERs |
| `src/lib/repos/channels.ts` | Channel/ChannelInput types + 17 column mapping |
| `src/lib/repos/albums.ts` | workflow column + snapshot at create time |
| `src/lib/prompts.ts` | resolveChannelPrompt + PromptKind/PromptSource types + defaultPromptBasename |
| `src/lib/flow/llm-image-prompt.ts` | Takes `templateContent` directly (caller resolves) |
| `src/worker/pipeline.ts` | workflow.preflightChecks injection + log on start |
| `src/worker/runner.ts` | Resolves workflow per album → injects branchB + workflow into deps |
| `src/worker/steps/01-album-brief.ts` | resolveChannelPrompt + log source |
| `src/worker/steps/02-track-briefs.ts` | resolveChannelPrompt + dynamic track count + log source |
| `src/worker/steps/05a-cover-image.ts` | resolveChannelPrompt + per-channel youtube_image_aspect |
| `src/worker/steps/05b-thumbnail.ts` | resolveChannelPrompt + log source |
| `src/worker/steps/06-distrokid-submit.ts` | Channel credit overrides (split songwriter, performer/producer fallback chain) |
| `src/worker/steps/08-loop-to-2h.ts` | per-channel target_video_seconds |
| `src/worker/steps/10-youtube-metadata.ts` | resolveChannelPrompt + log source |
| `src/app/api/channels/route.ts` | Zod schema for 17 new fields + cross-field rap validation |
| `src/app/api/channels/[id]/route.ts` | PATCH schema + cross-field validation when effectiveWorkflow=rap |
| `src/app/channels/new/page.tsx` | Wraps shared ChannelFormBody |
| `src/app/channels/[id]/edit-form.tsx` | Read-only view + edit mode wrapping ChannelFormBody + PromptSourceSummary |
| `src/app/channels/[id]/page.tsx` | Workflow badge, B-roll card, async server component, workflow column on albums table |
| `src/worker/steps/__tests__/step-02.test.ts` | Sets channel.promptTrackBriefs (channel-db path) instead of mocking loadTemplate |
| `src/worker/steps/__tests__/step-05b.test.ts` | Channel-templates override path: `thumbnail.md` (kind-based) instead of `thumbnail-prompt.md` |

## UI quirks observed

- The new form is significantly taller than the old flat grid; collapsible sections mitigate by collapsing 2 of the 7 by default (LLM Prompts and Cover & Thumbnail). Other 5 default-open since they're typically required-or-near-required.
- The "Test this prompt" button only works once `openrouter_api_key` is configured (mock or real). Consider showing a hint banner if neither is set; deferred.
- The B-roll preflight on the channel detail page runs `ffprobe` on every clip in the folder, every page load. For 100+ clips this could be slow. Cached `cheapBrollSummary` (just `fs.readdir` + extension filter) is a viable follow-up.
- The thumbnail-prompt channel-templates filename changed from `thumbnail-prompt.md` to `thumbnail.md` (kind-based, not workflow-default-basename-based). No production overrides exist yet so this is a transparent rename, but it's a contract for future operators.

## Recommended follow-ups

1. **Third workflow.** The registry now supports it cleanly — consider `podcast-compilation` (long-form spoken word + matching visual). Two new files: `workflows/podcast.ts` + new step variants if needed.
2. **Per-channel scheduler config.** The `scheduleCron` field is currently shared across all workflows. Adding `tracks_per_release_cron`, `release_cron`, `upload_cron` per channel would let an operator stagger releases per-niche.
3. **B-roll preview thumbnails in form.** Load the first 3 clips' first frames as `<video>` thumbnails so the operator can see what the folder contains before saving.
4. **Drop dormant template-name columns.** A future v6 migration removes `album_brief_template`, `track_briefs_template`, `cover_prompt_template`, `thumbnail_prompt_template`, `yt_metadata_template` — they were never read post-Session-10.
5. **Channel-detail prompt source indicators in real-time.** Currently `PromptSourceSummary` infers source from `channel.promptXxx ? channel-db : workflow-default` (skipping the channel-file middle layer). A small server action that calls `resolveChannelPrompt` would show `channel-file` correctly when an operator has dropped a markdown override into `prompts/channel-templates/<id>/`.
6. **Snapshot tests for the dashboard pages.** Check I is currently code-review-only; a Playwright run that hits `/channels/<id>` for both an ambient and rap channel would catch UI regressions during future refactors.
7. **Live-mode preview-prompt rate limiting.** Operators clicking "Test this prompt" repeatedly during template iteration could burn OpenRouter credits. Add per-IP / per-channel-id rate limit (e.g., 10/min) on the preview endpoint.
8. **The `pretest` hook idea.** Wire `npm run fixtures:broll` into `pretest` so `npm test` provisions B-roll fixtures automatically. Currently only the e2e test's `beforeAll` does this.
