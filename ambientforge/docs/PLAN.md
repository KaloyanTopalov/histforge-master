# AmbientForge — PLAN.md (v1)

> **Source of truth for build order, contracts, and risks. Read this at the start of every implementation session along with `CLAUDE.md` and `docs/ambientforge-spec.md`. Update on contract changes only.**

> **Numbering note (added 2026-04-28):** the operator named the multi-workflow refactor "Session 10" (commit `e43e5f7`, see `docs/SESSION-10-HANDOFF.md`). That work is **separate** from the canonical "Session 10" in § 2 below (YT Data API OAuth + handle resolver), which remains pending. Sessions 9, 10 (canonical), 11, 12, 13 in the table below are all still TBD. The 4.x sub-sessions (4.5, 4.6, 4.7) are also outside this table — they were retroactive refactors.

## 0. Context

AmbientForge is forked from HistForge to run 5–20 niche YouTube music channels from one Windows machine. Each channel produces ~1 album/week: 30 Suno songs → DistroKid release → 2-hour YouTube compilation video + thumbnail + metadata; operator uploads manually after a Content-ID hold expires. Daily YouTube Data API v3 stats feed an analytics dashboard.

This plan was produced in Session 0 (plan mode). Sections 1–6, 9, 10 of `docs/ambientforge-spec.md` are canonical; this document extends sections 7 (API contracts) and 8 (step contracts) and lays out the 13-session build order.

**HistForge availability:** the HistForge repo is **not** present on this machine (searched `E:\Projects\` — only `ambientforge/` exists). Patterns referenced from HistForge in `CLAUDE.md` (worker/runner, repos, `ensure-native-modules.js`, YouForge Flow extension scaffold) will be reconstructed from the spec + domain rules. Where HistForge would have been a verbatim copy, Session 1 builds the equivalent from scratch.

**Plan-mode answers folded in:**
- Suno (steps 03/04) resume **per-track** on retry.
- DistroKid (step 06) retry **always starts a fresh draft** via `start_release`.
- Manual "Trigger album" button opens a modal with an **optional** `themePrompt` textarea.

---

## 1. Module dependency map

`B` = blocking (must exist before dependents can be built or run). `R` = runtime-only dependency (extension running, binary on PATH, OAuth token present).

| Module | Depends on | Type |
|---|---|---|
| `lib/db` | — | B |
| `lib/settings` | `lib/db` | B |
| `lib/repos/settings` | `lib/db`, `lib/settings` | B |
| `lib/repos/channels` | `lib/db` | B |
| `lib/repos/albums` | `lib/db`, `lib/repos/channels` | B |
| `lib/repos/tracks` | `lib/db`, `lib/repos/albums` | B |
| `lib/repos/channelStats` | `lib/db`, `lib/repos/channels` | B (stats only) |
| `lib/repos/sessions` | `lib/db` | B |
| `lib/llm/openrouter` | `lib/settings` | B (steps 01, 02, 05a-prompt, 10) |
| `lib/prompts` | fs only | B (steps 01, 02, 05a, 05b, 10) |
| `extensions/suno-runner` | Chrome MV3 + persistent profile `data/suno-profile/` | R (steps 03, 04) |
| `lib/suno/client` | `extensions/suno-runner` listening on :7341 | B+R |
| `extensions/distrokid-runner` | Chrome MV3 + `data/distrokid-profile/` | R (step 06) |
| `lib/distrokid/client` | `extensions/distrokid-runner` :7342 | B+R |
| `extensions/flow-runner` | Chrome MV3 + `data/flow-profile/` | R (steps 05a, 05b) |
| `lib/flow/client` | `extensions/flow-runner` :7343 | B+R |
| `lib/audio/ffmpeg` | ffmpeg binary on PATH; NVENC detected at startup | B+R |
| `lib/audio/concat` | `lib/audio/ffmpeg` | B (step 07) |
| `lib/audio/loop` | `lib/audio/ffmpeg` | B (step 08) |
| `lib/audio/tracklist` | ffprobe via `lib/audio/ffmpeg` | B (step 10) |
| `lib/render/mux` | `lib/audio/ffmpeg` | B (step 09) |
| `lib/yt-stats/oauth` | `googleapis`, `data/yt-stats-token.json` | B+R |
| `lib/yt-stats/client` | `lib/yt-stats/oauth` | B (S10/S11) |
| `lib/yt-stats/analytics` | `lib/repos/channelStats` | B (S12) |
| `worker/runner` | `lib/repos/albums`, `lib/settings` | B |
| `worker/pipeline` | `worker/runner`, `lib/repos/albums`, all step modules | B |
| `worker/steps/01-album-brief` | `lib/llm/openrouter`, `lib/prompts`, `lib/repos/albums`, `lib/repos/channels` | B |
| `worker/steps/02-track-briefs` | `lib/llm/openrouter`, `lib/prompts`, `lib/repos/tracks` | B |
| `worker/steps/03-suno-generate` | `lib/suno/client`, `lib/repos/tracks` | B |
| `worker/steps/04-suno-download` | `lib/suno/client`, `lib/audio/ffmpeg` (validate) | B |
| `worker/steps/05a-cover-image` | `lib/flow/client`, `lib/audio/ffmpeg`, `lib/llm/openrouter` | B |
| `worker/steps/05b-thumbnail` | `lib/flow/client` (optional), `lib/audio/ffmpeg` (drawtext) | B |
| `worker/steps/06-distrokid-submit` (Branch A) | `lib/distrokid/client`, `lib/repos/albums` | B (A only) |
| `worker/steps/07-audio-concat` (Branch B) | `lib/audio/concat` | B (B only) |
| `worker/steps/08-loop-to-2h` (Branch B) | `lib/audio/loop` | B (B only) |
| `worker/steps/09-mux-video` (Branch B) | `lib/render/mux` | B (B only) |
| `worker/steps/10-youtube-metadata` | `lib/llm/openrouter`, `lib/prompts`, `lib/audio/tracklist` | B (post-join) |
| `worker/steps/11-finalize` | `lib/repos/albums` | B |
| `worker/scheduler` | `lib/repos/channels`, `lib/repos/albums`, `lib/settings`, `node-cron` | B (S9) |
| `worker/stats-fetcher` | `lib/yt-stats/client`, `lib/repos/channelStats` | B (S11) |
| dashboard `/channels` | `lib/repos/channels` | B |
| dashboard `/channels/[id]` | `lib/repos/channels`, `lib/repos/albums`, `lib/repos/tracks`, `lib/yt-stats/analytics` (S12+) | B |
| dashboard `/settings` | `lib/repos/settings` | B |
| dashboard `/api/health` | `lib/db`, `lib/settings`, `lib/repos/sessions` | B |
| dashboard `/api/channels[*]` | `lib/repos/channels`, `lib/repos/albums` (PATCH guard) | B |
| dashboard `/api/albums[*]` | `lib/repos/albums`, `lib/repos/channels` | B |
| dashboard `/api/stats/[channelId]` | `lib/yt-stats/analytics` | B (S12) |
| dashboard `/api/sessions/[service]/login-status` | `lib/repos/sessions`, extension bridges | B |

**Parallel fork dependency:** `worker/pipeline` joins Branch A (step 06) and Branch B (07→08→09) via `Promise.allSettled` after step 05b. Steps 10 + 11 run only after the join.

---

## 2. Build order — 13 sessions

Each session is one fresh Claude Code context; plan-mode → review → approve → implement → test → commit. Sessions 1–13 follow `sessions/SESSIONS-1-TO-7.md` and `sessions/SESSIONS-8-TO-13.md` verbatim; the table below is the canonical summary.

| # | Name | Files touched (key) | Blocks on | Done criteria | Rollback |
|---|---|---|---|---|---|
| 1 | Repo scaffold + DB + dashboard skeleton | `package.json`, `next.config.js`, `tsconfig.json`, `src/lib/db.ts`, `src/lib/repos/*`, `src/lib/settings.ts`, `src/app/api/health/route.ts`, `src/app/channels/page.tsx`, `src/app/layout.tsx`, `scripts/ensure-native-modules.js` | — | `npm run dev` boots; `/api/health` returns shape; `db.test.ts` passes (FK enforced, ULID len 26, album defaults `distrokid_status='pending'`, `video_status='pending'`); ESLint clean | `git checkout main && rm -rf node_modules data/` |
| 2 | Channel CRUD UI + worker runner + parallel-fork stub | `src/app/channels/[id]/page.tsx`, `src/app/api/channels/*`, `src/app/api/albums/*`, `src/worker/runner.ts`, `src/worker/pipeline.ts` (noop fork), `src/app/settings/page.tsx` | 1 | Manual trigger creates album → worker runs branchA-noop ‖ branchB-noop → seq-noop → `done`; PATCH blocked while `in_progress`; second album waits | `git revert HEAD` |
| 3 | Steps 01 + 02 (LLM-driven brief & track briefs) | `src/lib/llm/openrouter.ts`, `src/lib/prompts.ts`, `prompts/defaults/album-brief.md`, `prompts/defaults/track-briefs.md`, `src/worker/steps/01-album-brief.ts`, `src/worker/steps/02-track-briefs.ts` | 2 | Album fills metadata + 30 track rows; channel-template override beats default; mock mode (`OPENROUTER_API_KEY=mock`) returns fixture | `git revert HEAD`; `DELETE FROM tracks WHERE album_id IN (...)` |
| 4 | Suno extension + steps 03 + 04 | `extensions/suno-runner/*`, `src/lib/suno/client.ts`, `src/worker/steps/03-suno-generate.ts`, `src/worker/steps/04-suno-download.ts`, npm `suno:login` | 3 | 30 .wav files; ffprobe-validated; pre-flight credit check fails with `INSUFFICIENT_SUNO_CREDITS` when balance < 30; resume-per-track verified by killing worker after 12 submissions and restarting | `git revert HEAD`; delete `projects/<ch>/<alb>/` |
| 5 | Flow extension + steps 05a + 05b | `extensions/flow-runner/*`, `src/lib/flow/client.ts`, `src/lib/audio/ffmpeg.ts`, `src/worker/steps/05a-cover-image.ts`, `src/worker/steps/05b-thumbnail.ts`, `prompts/defaults/cover-prompt.md`, `prompts/defaults/thumbnail-prompt.md` | 4 | `cover.png` 3000², `ytImage.png` 1920×1080, `thumb.png` 1280×720; aspect-retry triggered when Flow returns non-square | `git revert HEAD`; delete images |
| 6 | DistroKid extension + step 06 (DRY-RUN) + captcha banner + Content-ID hold timestamps | `extensions/distrokid-runner/*`, `src/lib/distrokid/client.ts`, `src/worker/steps/06-distrokid-submit.ts`, captcha banner UI | 5 | End-to-end dry run on 2 channels; `distrokid-dryrun.png` + `distrokid-payload.json` saved; `distrokid_submitted_at` and `safe_to_upload_after` set; live mode throws "live mode disabled in v0" | `git revert HEAD` |
| 7 | Steps 07 + 08 + 09 + parallel fork goes live | `src/lib/audio/concat.ts`, `src/lib/audio/loop.ts`, `src/lib/render/mux.ts`, steps 07/08/09, `src/worker/pipeline.ts` (real fork) | 6 | Branch A & Branch B run concurrently; `final.mp4` 7200s ±0.5s, 1920×1080, 30fps, AAC 192k, +faststart; "Retry DistroKid only" / "Retry video render only" buttons work | `git revert HEAD`; delete `build/`, `final.mp4` |
| 8 | Step 10 (YT metadata) + step 11 (finalize) + Content-ID hold UI | `prompts/defaults/yt-metadata.md`, `src/lib/audio/tracklist.ts`, `src/worker/steps/10-youtube-metadata.ts`, `src/worker/steps/11-finalize.ts`, hold badge + countdown + "Mark as uploaded" gate | 7 | All metadata files written; `album.status='done'` only when both branches succeed; "Mark as uploaded" disabled until `safe_to_upload_after`; setting `content_id_hold_days=0` enables immediately | `git revert HEAD` |
| 9 | Scheduler subprocess (cron-driven) | `src/worker/scheduler.ts`, scheduler concurrently entry, per-channel "Next scheduled" UI | 8 | 3 channels with `* * * * *` queue 3 albums in 3 min; never two `in_progress`; disable mid-run lets in-progress finish; idempotent within a minute | `git revert HEAD` |
| 10 | YT Data API v3 OAuth + read-only client + handle resolver | `src/lib/yt-stats/oauth.ts`, `src/lib/yt-stats/client.ts`, `npm run yt-stats:auth`, channel-form handle resolver | 9 | OAuth flow saves token; `@songsforcry` resolves to `UCD3408WruZziuQjISAcFFrg`; expired token surfaces banner | `git revert HEAD`; delete `data/yt-stats-token.json` |
| 11 | Daily stats fetcher subprocess | `src/worker/stats-fetcher.ts`, "Fetch all now" button, 401 → `yt_stats_auth_expired=true` | 10 | One row/channel/day in `channel_stats`; idempotent within hour; quota logged | `git revert HEAD`; `DELETE FROM channel_stats` |
| 12 | Analytics dashboard (per-channel growth charts) | `src/lib/yt-stats/analytics.ts`, `src/app/api/stats/[channelId]/route.ts`, `src/app/api/stats/summary/route.ts`, SVG line charts in channel detail + dashboard home | 11 | After 7+ days, 3 line charts per channel (subs, views, video count); cross-channel ranking by 7-day delta | `git revert HEAD` |
| 13 | DistroKid live-mode flip + 5-channel smoke test + polish | live toggle with double-confirm + 2-prior-dry-run guard, `docs/launch-checklist.md`, `npm run db:seed:demo` (5 channels), live-mode code path in step 06 | 12 | Live toggle gated; 5-channel smoke test produces 5 valid albums; 1 live release verified in DistroKid web UI within 5 min; hold timestamps applied to live releases identically | `git revert HEAD`; manual takedown of any bad live release |

Total: **13 sessions, one feature each**, each sized to fit one Claude Code context without compaction.

---

## 3. Spec extension — section 7 (API contracts)

All shapes Zod. All routes return `application/json` except where noted. Errors are `{ error: { code: string, message: string, details?: unknown } }` with HTTP 4xx/5xx. Localhost binding only (no auth in v1).

```ts
// Shared
const Channel = z.object({
  id: z.string().length(26),
  name: z.string().min(1).max(64),
  displayName: z.string().min(1).max(128),
  description: z.string().default(''),
  active: z.boolean(),
  scheduleCron: z.string(),                          // 5-field cron, validated via node-cron
  albumBriefTemplate: z.string().nullable(),
  trackBriefsTemplate: z.string().nullable(),
  coverPromptTemplate: z.string().nullable(),
  thumbnailPromptTemplate: z.string().nullable(),
  ytMetadataTemplate: z.string().nullable(),
  distrokidArtistName: z.string().min(1),
  distrokidPrimaryGenre: z.string().min(1),
  distrokidLabelName: z.string().nullable(),
  youtubeChannelId: z.string().regex(/^UC[\w-]{22}$/).nullable(),
  youtubeChannelHandle: z.string().regex(/^@[\w.-]+$/).nullable(),
  thumbnailOverlayText: z.string().nullable(),
  spotifyPlaylistUrl: z.string().url().nullable(),
  hashtags: z.string().default(''),                  // CSV
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const Album = z.object({
  id: z.string().length(26),
  channelId: z.string().length(26),
  status: z.enum(['new','queued','in_progress','awaiting_captcha','done','failed']),
  themePrompt: z.string().nullable(),
  albumTitle: z.string(),
  artistName: z.string(),
  primaryGenre: z.string(),
  sunoStylePrompt: z.string(),
  coverImagePath: z.string().nullable(),
  thumbnailPath: z.string().nullable(),
  ytImagePath: z.string().nullable(),
  tracklistText: z.string().nullable(),
  ytTitle: z.string().nullable(),
  ytDescription: z.string().nullable(),
  ytTags: z.string().nullable(),
  distrokidReleaseId: z.string().nullable(),
  distrokidDryRunArtifact: z.string().nullable(),
  distrokidSubmittedAt: z.number().int().nullable(),
  safeToUploadAfter: z.number().int().nullable(),
  distrokidStatus: z.enum(['pending','submitted','failed','dryrun']),
  videoStatus: z.enum(['pending','rendering','rendered','failed']),
  finalVideoPath: z.string().nullable(),
  uploadedAt: z.number().int().nullable(),
  youtubeVideoId: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const Track = z.object({
  id: z.string().length(26),
  albumId: z.string().length(26),
  trackNumber: z.number().int().min(1).max(30),
  title: z.string(),
  fileName: z.string(),
  duration: z.number().nonnegative(),
  sunoTaskId: z.string().nullable(),
  sunoLyrics: z.string().nullable(),
  audioPath: z.string().nullable(),
  status: z.enum(['pending','submitted','downloading','done','failed']),
});
```

### Routes

**`GET /api/channels`**
- Response: `z.object({ channels: z.array(Channel), counts: z.object({ active: z.number(), inactive: z.number() }) })`

**`POST /api/channels`**
- Body: `Channel.omit({ id: true, createdAt: true, updatedAt: true, youtubeChannelId: true })` (server resolves handle → UC… on save when handle non-null and OAuth available)
- Response: `z.object({ channel: Channel })`
- Errors: `CHANNEL_NAME_TAKEN` (409), `INVALID_CRON` (400), `HANDLE_RESOLUTION_FAILED` (502 — non-fatal: channel saved with `youtubeChannelId=null` and warning).

**`GET /api/channels/:id`**
- Response: `z.object({ channel: Channel, albums: z.array(Album).max(50), nextScheduledAt: z.number().int().nullable() })`
- Errors: `CHANNEL_NOT_FOUND` (404).

**`PATCH /api/channels/:id`**
- Body: `Channel.partial().omit({ id: true, createdAt: true, updatedAt: true })`
- Response: `z.object({ channel: Channel })`
- Errors: `CHANNEL_LOCKED_DURING_RUN` (409 — any album for this channel is `in_progress`), `INVALID_CRON` (400), `CHANNEL_NOT_FOUND` (404).

**`POST /api/albums`** (manual enqueue)
- Body: `z.object({ channelId: z.string().length(26), themePrompt: z.string().nullable().optional() })`
- Response: `z.object({ album: Album })`
- Errors: `CHANNEL_NOT_FOUND` (404), `CHANNEL_INACTIVE` (409), `ALREADY_QUEUED_OR_RUNNING` (409 — channel has `new|queued|in_progress` album).

**`GET /api/albums/:id`**
- Response: `z.object({ album: Album, tracks: z.array(Track), pipelineLogTail: z.array(z.string()).max(200) })`
- Errors: `ALBUM_NOT_FOUND` (404).

**`POST /api/albums/:id/retry`** (introduced in S7; useful in S2 stub)
- Body: `z.object({ branch: z.enum(['A','B','full']) })`
- Response: `z.object({ album: Album })`
- Errors: `ALBUM_NOT_RETRYABLE` (409 — only failed albums or per-branch-failed), `ALBUM_NOT_FOUND` (404).

**`POST /api/albums/:id/mark-uploaded`** (S8)
- Body: `z.object({ youtubeVideoId: z.string().regex(/^[\w-]{11}$/) })`
- Response: `z.object({ album: Album })`
- Errors: `UPLOAD_HOLD_ACTIVE` (409 — `now() < safeToUploadAfter`), `ALBUM_NOT_DONE` (409).

**`GET /api/stats/:channelId`** (S12)
- Query: `?range=30d|90d|365d` (default `30d`)
- Response:
  ```ts
  z.object({
    channelId: z.string(),
    series: z.object({
      subscribers: z.array(z.tuple([z.number(), z.number()])),  // [ts, value]
      views:       z.array(z.tuple([z.number(), z.number()])),
      videos:      z.array(z.tuple([z.number(), z.number()])),
    }),
    delta: z.object({
      subscribers7d: z.number().int(),
      views7d: z.number().int(),
      videos7d: z.number().int(),
    }),
    lastFetchedAt: z.number().int().nullable(),
  })
  ```
- Errors: `CHANNEL_NOT_FOUND` (404), `NO_STATS_YET` (200 with empty series — not an error).

**`GET /api/stats/summary`** (S12)
- Response: `z.object({ totalSubscribers: z.number().int(), weeklyDelta: z.number().int(), top: z.array(z.object({ channelId: z.string(), name: z.string(), delta7d: z.number().int() })).max(3), queued: z.number().int(), inProgress: z.number().int() })`

**`POST /api/sessions/:service/login-status`**
- Path: `service ∈ {'suno','distrokid','flow','yt-stats'}`
- Body: empty.
- Behavior: server pings the relevant extension bridge (`/credits` for suno, `/ping` for distrokid + flow) or checks `data/yt-stats-token.json` validity; updates `sessions` row.
- Response: `z.object({ service: z.string(), status: z.enum(['valid','expired']), lastChecked: z.number().int(), detail: z.string().optional() })`
- Errors: `BRIDGE_UNREACHABLE` (502 — extension not running), `UNKNOWN_SERVICE` (400).

---

## 4. Spec extension — section 8 (step contracts)

All steps live under `src/worker/steps/`. Each is a stateless async function `run(ctx: StepContext): Promise<void>` reading from disk + DB and writing to disk + DB. The orchestrator owns transitions. All step errors are typed `{ code: string; message: string; retriable: boolean; cause?: unknown }`. Project root for an album = `projects/<channel_id>/<album_id>/`.

### Step 01 — `album-brief` (sequential)
- **Inputs:** `albums` row (`themePrompt`, `channelId`); `channels` row; template at `prompts/channel-templates/<channelId>/album-brief.md` else `prompts/defaults/album-brief.md`; settings `openrouter_api_key`, `model_name`.
- **Outputs:** UPDATE `albums` SET `albumTitle`, `sunoStylePrompt`, `primaryGenre`, `artistName = channels.distrokidArtistName`.
- **Errors:** `OPENROUTER_AUTH` (401, retriable=false), `OPENROUTER_RATE_LIMIT` (retriable=true, exp backoff), `OPENROUTER_MALFORMED_JSON` (retriable=true, max 2 retries with stricter prompt), `MISSING_TEMPLATE` (retriable=false).
- **Retry:** up to 3 attempts on retriable errors; exp backoff 5s/15s/45s.
- **Idempotency:** safe to re-run — overwrites album metadata fields. If `albumTitle` is already non-null, step completes as no-op (unless `retryBranch='full'`).

### Step 02 — `track-briefs` (sequential)
- **Inputs:** album row + channel row; template `track-briefs.md`.
- **Outputs:** INSERT 30 rows into `tracks` with `status='pending'`, `trackNumber 1..30`, `title`, `sunoLyrics`, `fileName='NN - Title.wav'` (zero-padded, sanitized).
- **Errors:** `OPENROUTER_*` (as 01), `EXPECTED_30_TRACKS` (retriable=true, max 2 — re-prompt with explicit count).
- **Retry:** 3 attempts, exp backoff.
- **Idempotency:** if 30 track rows already exist for this `albumId`, step is a no-op. On forced rerun: `DELETE FROM tracks WHERE album_id=?` first.

### Step 03 — `suno-generate` (sequential, branch B prereq because cover step needs nothing from Suno; resume-per-track)
- **Inputs:** album.sunoStylePrompt; tracks rows (`status='pending'` or `null sunoTaskId`); extension on :7341 reachable.
- **Outputs:** UPDATE each track SET `sunoTaskId`, `status='submitted'`.
- **Behavior:** pre-flight `GET /credits`; if `< 30 - alreadySubmittedCount` fail `INSUFFICIENT_SUNO_CREDITS`. Then sequential submit, **5–10 s delay** between, **only for tracks with `sunoTaskId IS NULL`**.
- **Errors:** `INSUFFICIENT_SUNO_CREDITS` (retriable=false; surfaces banner), `SUNO_BRIDGE_UNREACHABLE` (retriable=true, 30s backoff, 3 attempts), `SUNO_CAPTCHA` (retriable=false; sets `album.status='awaiting_captcha'`), `SUNO_RATE_LIMITED` (retriable=true, 60s backoff).
- **Retry:** step-level retry resumes per-track (skips tracks whose `sunoTaskId` is already set).
- **Idempotency:** **resume-per-track**. Re-running picks up from the first track lacking `sunoTaskId`. Never re-submits a track with a non-null `sunoTaskId`.

### Step 04 — `suno-download` (sequential)
- **Inputs:** tracks rows with `sunoTaskId` non-null; extension on :7341.
- **Outputs:** WAV files at `projects/<ch>/<alb>/songs/NN - Title.wav`; UPDATE each track SET `audioPath`, `duration` (from ffprobe), `status='done'`.
- **Behavior:** poll each task at 15 s interval, 10 min timeout per song; download `.wav` once ready; ffprobe-validate (sample rate ≥ 44.1 kHz, bit depth ∈ {16,24}, channels = 2, duration ≥ 30 s); on validation failure delete file and retry download once.
- **Errors:** `SUNO_TASK_TIMEOUT` (retriable=true, 1 retry with extended timeout), `INVALID_AUDIO_FORMAT` (retriable=true, 1 retry of the download then fail step), `SUNO_TASK_FAILED` (retriable=true, 1 re-submit which reuses sunoTaskId slot).
- **Retry:** step-level retry skips tracks already at `status='done'` with non-null `audioPath`.
- **Idempotency:** **resume-per-track**. A partial run leaves N completed .wavs; a rerun continues with the rest.

### Step 05a — `cover-image` (sequential)
- **Inputs:** `album.albumTitle`, `album.sunoStylePrompt`; channel template `cover-prompt.md`; extension on :7343.
- **Outputs:** `cover.png` (3000×3000 sRGB <10 MB), `ytImage.png` (1920×1080 — letterbox or crop per `youtube_image_aspect`); UPDATE `album.coverImagePath`, `album.ytImagePath`.
- **Behavior:** call openrouter to derive Flow visual prompt; submit via Flow; poll; download; FFmpeg post-process (square crop + resize for cover; aspect-aware resize for ytImage).
- **Errors:** `FLOW_BRIDGE_UNREACHABLE`, `FLOW_PROMPT_REJECTED` (retriable=true, 1 retry with safety-toned re-prompt), `FLOW_ASPECT_DRIFT` (retriable=true, 1 retry forcing "square composition"), `FFMPEG_POSTPROCESS_FAILED` (retriable=false).
- **Retry:** 2 attempts.
- **Idempotency:** if both files exist with correct dimensions on disk, step is no-op. Forced rerun deletes them first.

### Step 05b — `thumbnail` (sequential)
- **Inputs:** `cover.png`; `channel.thumbnailOverlayText`; channel template `thumbnail-prompt.md` (if differs from cover, second Flow call); font at `prompts/defaults/thumbnail-font.ttf`.
- **Outputs:** `thumb.png` 1280×720; UPDATE `album.thumbnailPath`.
- **Behavior:** if `thumbnailPromptTemplate === coverPromptTemplate || null`, derive thumb from `cover.png` (FFmpeg crop). Else second Flow call. If `thumbnailOverlayText` set, drawtext composite (lower-third, white + 4 px black stroke).
- **Errors:** `MISSING_FONT` (retriable=false — operator must drop font in `prompts/defaults/`), `FLOW_*` (as 05a).
- **Retry:** 2 attempts.
- **Idempotency:** if `thumb.png` exists with correct dimensions, no-op.

### **PARALLEL FORK** — orchestrator behavior

After step 05b, the orchestrator launches Branch A and Branch B with `Promise.allSettled([branchA, branchB])`. Both run on the same album; branches write disjoint files and DB columns.

| | Branch A (DistroKid) | Branch B (Video render) |
|---|---|---|
| Steps | 06 | 07 → 08 → 09 |
| Writes (DB) | `distrokidStatus`, `distrokidSubmittedAt`, `safeToUploadAfter`, `distrokidReleaseId`, `distrokidDryRunArtifact` | `videoStatus`, `finalVideoPath` |
| Writes (disk) | `distrokid-dryrun.png`, `distrokid-payload.json` (or `distrokid-receipt.png` in live) | `build/concat.wav`, `build/loop.wav`, `final.mp4` |
| Failure ⇒ peer | A fails → B continues; A's status=`failed` | B fails → A continues; B's status=`failed` |
| Join semantics | If either branch is `failed`, orchestrator **skips steps 10 + 11**, sets `album.status='failed'`, log structured error indicating which branch(es) | Per-branch retry: `POST /api/albums/:id/retry` with `branch:'A'` or `branch:'B'` resets only that branch's status to `pending` and re-runs that branch only, reusing the other branch's artifacts. |

The fork is the **only** parallelism allowed in the codebase.

### Step 06 — `distrokid-submit` (Branch A)
- **Inputs:** `album` (artistName, albumTitle, primaryGenre), `tracks` (30 rows with audioPath), `cover.png`; channel (`distrokidLabelName`); settings (`distrokid_dry_run`, `content_id_hold_days`).
- **Outputs (dry-run):** `distrokid-dryrun.png`, `distrokid-payload.json`; UPDATE `album.distrokidStatus='dryrun'`, `distrokidSubmittedAt=now()`, `safeToUploadAfter=now() + content_id_hold_days * 86400000`, `distrokidDryRunArtifact='distrokid-dryrun.png'`.
- **Outputs (live, S13):** parse releaseId from confirmation; UPDATE `distrokidStatus='submitted'`, `distrokidReleaseId`, same hold timestamps.
- **Behavior:** `verify_artist` pre-flight; `start_release` (always fresh — no resume of partial drafts); fill metadata; upload cover; upload tracks in 2 batches of 15 (verify count after each); screenshot at final review (dry-run) or click Submit + parse (live).
- **Errors:** `DISTROKID_ARTIST_NOT_FOUND` (retriable=false, banner), `DISTROKID_BRIDGE_UNREACHABLE` (retriable=true, 30s backoff, 3 attempts), `DISTROKID_CAPTCHA` (retriable=false; album → `awaiting_captcha`, "Bring window to front" banner), `DISTROKID_TRACK_UPLOAD_COUNT_MISMATCH` (retriable=true, 1 retry — re-uploads missing tracks within same draft), `DISTROKID_LIVE_DISABLED` (S6–S12 only; S13 removes), `DISTROKID_SUBMIT_FAILED` (retriable=false in live mode; abort).
- **Retry:** **branch-level retry always starts a fresh draft.** Per session-0 decision: no resume of partial DistroKid drafts. The runner does not search for existing drafts; operator manually deletes leftover drafts in DistroKid UI as cleanup.
- **Idempotency:** **non-resumable mid-step** (each retry rebuilds from `start_release`). Outer-level idempotency: if `distrokidStatus IN ('submitted','dryrun')` already, step is a no-op (skipped on full-album rerun).

### Step 07 — `audio-concat` (Branch B)
- **Inputs:** 30 .wav files in `projects/<ch>/<alb>/songs/`.
- **Outputs:** `projects/<ch>/<alb>/build/concat.wav` via `ffmpeg -f concat -safe 0 -i list.txt -c copy concat.wav`. Sets `album.videoStatus='rendering'`.
- **Errors:** `WAV_FORMAT_MISMATCH` (retriable=false — Suno changed format mid-album, halt loudly), `MISSING_TRACK_FILE` (retriable=false — operator intervention), `FFMPEG_CONCAT_FAILED`.
- **Retry:** 1 attempt.
- **Idempotency:** if `concat.wav` exists and ffprobe duration ≈ sum of source durations, no-op.

### Step 08 — `loop-to-2h` (Branch B)
- **Inputs:** `concat.wav`; setting `target_video_seconds` (default 7200).
- **Outputs:** `build/loop.wav` exactly `target_video_seconds` long via stream-copy concat-N then `-c copy -t target`.
- **Errors:** `LOOP_DURATION_DRIFT` (retriable=false — duration off by > 0.5 s after trim), `FFMPEG_LOOP_FAILED`.
- **Retry:** 1 attempt.
- **Idempotency:** if `loop.wav` exists and duration ≈ target ±0.5 s, no-op.

### Step 09 — `mux-video` (Branch B)
- **Inputs:** `build/loop.wav`, `ytImage.png`; settings (`nvenc_enabled`).
- **Outputs:** `final.mp4` (1920×1080, 30 fps, H.264 NVENC or libx264, AAC 192 k, yuv420p, +faststart). UPDATE `album.finalVideoPath`, `videoStatus='rendered'`.
- **Errors:** `NVENC_UNAVAILABLE` (retriable=true — fall back to libx264 automatically), `MUX_FAILED`, `OUTPUT_DURATION_DRIFT` (>0.5 s off target).
- **Retry:** 1 attempt; NVENC failure auto-falls back without counting as retry.
- **Idempotency:** if `final.mp4` exists with correct duration + dimensions, no-op.

### **JOIN** — orchestrator awaits both branches

If both `distrokidStatus IN ('submitted','dryrun')` and `videoStatus='rendered'`, proceed to step 10. Else skip 10 + 11, set `album.status='failed'`, write structured failure log.

### Step 10 — `youtube-metadata` (sequential, post-join)
- **Inputs:** album row, channel row, 30 .wav files (for tracklist durations), template `yt-metadata.md`.
- **Outputs:** `tracklist.txt`, `title.txt`, `description.txt`, `tags.txt` in project folder; UPDATE `album.tracklistText`, `ytTitle`, `ytDescription`, `ytTags`.
- **Errors:** `OPENROUTER_*` (as 01), `TRACKLIST_DURATION_MISMATCH` (retriable=false — concat duration vs sum-of-tracks differ).
- **Retry:** 3 attempts.
- **Idempotency:** if all 4 files exist, no-op.

### Step 11 — `finalize` (sequential)
- **Inputs:** album row + all artifacts.
- **Outputs:** `album.status='done'` iff `distrokidStatus IN ('submitted','dryrun') AND videoStatus='rendered'`; else `'failed'`. Append summary to `pipeline.log` (per-step durations, total disk size).
- **Errors:** `INCONSISTENT_STATE` (retriable=false; should never occur if join did its job).
- **Retry:** 0 (terminal).
- **Idempotency:** safe to re-run; sets the same final status.

---

## 5. Test strategy

### Pure unit (vitest) — `src/**/__tests__/*.test.ts`

| File | Covers |
|---|---|
| `db.test.ts` | Schema, FK enforcement, ULID length, default `distrokid_status='pending'` and `video_status='pending'` |
| `repos.test.ts` | CRUD on each repo, soft-delete `channels.active=false`, PATCH guard during `in_progress` |
| `settings.test.ts` | Zod coercion, default fallback |
| `prompts.test.ts` | Channel-override beats default, mustache interpolation, missing-template error |
| `openrouter.test.ts` | Mock-mode (`OPENROUTER_API_KEY=mock`) returns deterministic fixture; malformed JSON triggers re-prompt |
| `runner.test.ts` | Strict serial enforcement; second album waits; resume after kill -9 |
| `pipeline.test.ts` | Branch A throws → album `failed`, branch B still completes; both succeed → join → step 10. Uses fixture step modules. |
| `concat.test.ts` | Concat list builder writes correct paths; stream-copy command shape |
| `loop.test.ts` | Loop math: N repeats then trim to exact target; trim happens at end-of-loop not mid-song |
| `mux.test.ts` | NVENC vs libx264 command selection; +faststart flag present |
| `tracklist.test.ts` | Cumulative durations; `M:SS` vs `H:MM:SS` switch at 1:00:00; format `M:SS - Title` |
| `scheduler.test.ts` | Cron parsing, idempotent within minute, skips when global `in_progress` exists |
| `analytics.test.ts` | 7-day delta calculation; empty-state handling |
| `stats-fetcher.test.ts` | Idempotent within hour, 401 sets `yt_stats_auth_expired=true` |
| `channels-api.test.ts` | PATCH blocked during `in_progress`, handle resolution non-fatal |
| `albums-api.test.ts` | `mark-uploaded` blocked while `now() < safeToUploadAfter` |

### Mockable integration — vitest with bridge stubs

| File | Covers |
|---|---|
| `step-01.test.ts` | LLM mock returns fixture, album metadata written, template override path |
| `step-02.test.ts` | LLM mock returns 30 rows, Zod validates count, `EXPECTED_30_TRACKS` retry on bad count |
| `step-03-resume.test.ts` | Stub Suno bridge; submit 12 tracks then crash; rerun submits the remaining 18 only |
| `step-04-validate.test.ts` | Stub bridge serves a deliberately-invalid wav once → triggers download retry |
| `step-09-mux.test.ts` | Tiny inputs (1s loop, 64×64 image); asserts file exists with correct duration; runs only when ffmpeg on PATH |
| `step-11.test.ts` | Status transitions for all four (A,B) combinations |

### Manual integration (live services) — checklist in `docs/`

| File | Covers | When |
|---|---|---|
| `docs/distrokid-dryrun-checklist.md` (S6) | One full dry-run per channel; visual verification of every field; screenshot saved | S6 done criteria |
| `docs/suno-smoke-checklist.md` (S4) | Pre-flight credit check, 30-track end-to-end, credit consumption documented | S4 done criteria |
| `docs/flow-smoke-checklist.md` (S5) | Cover + thumbnail end-to-end, aspect-retry verified | S5 done criteria |
| `docs/launch-checklist.md` (S13) | All-systems pre-flight, 5-channel smoke, live-mode flip | S13 done criteria |

### Cannot be tested without live services

Steps 03 (Suno submit), 04 (Suno download — with real audio), 05a/05b (Flow image gen), 06 (DistroKid form fill). All gated behind manual checklists.

### Map: every step → at least one test

Step 01 → unit (`step-01.test.ts`) + manual (S3 done criteria run).
Step 02 → unit (`step-02.test.ts`).
Step 03 → unit-stub (`step-03-resume.test.ts`) + manual (`suno-smoke-checklist.md`).
Step 04 → unit-stub (`step-04-validate.test.ts`) + manual.
Step 05a → manual (`flow-smoke-checklist.md`); FFmpeg post-process unit test.
Step 05b → manual; drawtext unit test (composite a known overlay, assert pixel diff).
Step 06 → manual (`distrokid-dryrun-checklist.md`).
Step 07 → unit (`concat.test.ts`).
Step 08 → unit (`loop.test.ts`).
Step 09 → unit (`step-09-mux.test.ts`).
Step 10 → unit (`tracklist.test.ts`) + integration via mock LLM.
Step 11 → unit (`step-11.test.ts`).

---

## 6. Risk map

| # | Risk | Prevention |
|---|---|---|
| 1 | **Suno anti-bot lockout** from any parallel session | Hard `suno_max_concurrent=1`; scheduler enqueues only when worker is idle; submit delay 5–10 s between tracks; never headless Playwright on Suno (extension only). |
| 2 | **Suno credit exhaustion mid-album** | Pre-flight `GET /credits` in step 03 fails with `INSUFFICIENT_SUNO_CREDITS` if `< 30 - alreadySubmitted`; dashboard banner; resume-per-track means a top-up + retry doesn't burn duplicate credits. |
| 3 | **DistroKid UI drift** breaks distrokid-runner selectors | Default `distrokid_dry_run=true`; every run saves `distrokid-dryrun.png` + `distrokid-payload.json`; weekly smoke test selectors via `verify_artist`; live mode requires 2 prior dry-runs + double-confirm. |
| 4 | **Flow image aspect drift** (16:9 instead of 1:1) | Post-crop in FFmpeg always; `FLOW_ASPECT_DRIFT` retry forces "square composition"; never publish raw Flow output. |
| 5 | **NVENC unavailable** at runtime | Detect at startup (`ffmpeg -encoders | grep nvenc`) plus `nvenc_enabled` setting (`auto`/`force`/`off`); auto-fallback to `libx264 -preset medium -crf 20`; mux step succeeds either way. |
| 6 | **Scheduler racing the worker** (two `in_progress`) | Scheduler skips enqueueing whenever ANY album anywhere is `in_progress`; runner is single-process, single-loop, single-album; tests assert second album waits. |
| 7 | **OAuth token expiry** (YouTube Data API) | Refresh token persisted; 401 sets `yt_stats_auth_expired=true`; dashboard banner with "Re-authenticate" button; fetcher halts cleanly until refreshed. |
| 8 | **Disk space exhaustion** (~3-4 GB raw + 1.5 GB final.mp4 per album, 320 GB/month at 20 channels) | Setting `keep_raw_audio_after_done=false` (default) deletes `songs/` + `build/` after step 11; pipeline.log records per-album disk size; dashboard widget shows total `projects/` size. |
| 9 | **YouTube Content ID flagging your own video** | `safe_to_upload_after = distrokid_submitted_at + content_id_hold_days * 86400000` (default 14 d); "Mark as uploaded" button disabled until expiry; tooltip explains the hold; setting to 0 bypasses for testing only. |

---

## 7. Open questions (blocking only)

**None blocking implementation.** The three originally-ambiguous items were resolved in Session 0:
1. Suno step 03/04 retry → resume-per-track.
2. DistroKid step 06 retry → always start a fresh draft (no resume of partial drafts).
3. Manual album trigger UI → modal with optional themePrompt textarea.

**Operator runtime prerequisites** (not blockers for code, but required before each session can verify done criteria):

- **HistForge source unavailable** on this machine. Session 1's `ensure-native-modules.js` and Chrome-extension scaffolding will be reconstructed from the spec + domain rules instead of copied. If the operator still has HistForge elsewhere, dropping it at `E:\Projects\histforge\` before Session 1 enables verbatim copy and saves time.
- **DistroKid Musician+ subscription** active before Session 6.
- **Per-channel DistroKid artist profiles** must exist in DistroKid before that channel can run step 06.
- **`prompts/defaults/thumbnail-font.ttf`** must be supplied by the operator before Session 5.
- **Google Cloud project + YouTube Data API v3 + OAuth client (Desktop)** before Session 10.
- **Suno Premier subscription + ≥600 credits/week budget** before Session 4 production runs.

---

## 8. Verification (end-to-end)

Each session's "Done criteria" column above is the per-session verification. The full v1 verification (end of Session 13) is:

1. `npm install && npm run db:init && npm run dev` boots cleanly.
2. `npm run suno:login`, `npm run distrokid:login`, `npm run flow:login`, `npm run yt-stats:auth` all succeed.
3. `npm run db:seed:demo` inserts 5 channels.
4. With `scheduler_enabled=false`, manually trigger 5 albums sequentially (one per channel). All 5 reach `done`. All artifacts present:
   - `cover.png` 3000², `thumb.png` 1280×720, `ytImage.png` 1920×1080.
   - 30 .wav files matching `NN - Title.wav`, ffprobe-validated.
   - `distrokid-dryrun.png` + `distrokid-payload.json`.
   - `final.mp4` 7200 s ±0.5 s, 1920×1080, 30 fps, AAC 192 k, +faststart.
   - `tracklist.txt`, `title.txt`, `description.txt`, `tags.txt`.
5. `npm test` and `npm run lint` and `npm run build` clean.
6. Enable scheduler with realistic crons; observe 24 h with no failures.
7. Flip 1 channel to live DistroKid (double-confirm + 2 prior dry-runs); verify release in DistroKid web UI within 5 min.
8. After `safe_to_upload_after` expires (or after fast-forwarding it via DB), upload one video manually to a test YouTube channel; confirm no Content ID flag within 24 h.
9. Daily stats fetcher records `channel_stats` row per channel; analytics page renders charts after 7+ days.

If all 9 verifications pass, v1 is shipped.
