# AmbientForge Spec (v3.2 — ambient-video workflow)

> Canonical reference. Plan mode (Session 0) extends sections marked `[plan-mode]`. Updated 2026-05-14 for the ambient-video workflow (DB v9). Update on every contract change.

## Changelog
- v3 (Session 0 final): single-workflow ambient pipeline, parallel fork at step 06/07.
- **v3.1 (Session 10):** introduced `workflow` discriminator on channels + albums. Two workflows ship (`ambient`, `rap-compilation`). 17 new per-channel columns added. See `docs/SESSION-10-HANDOFF.md` for the full inventory.
- **v3.2 (2026-05-14, DB v9):** third workflow `ambient-video` added. Step 01b (scene generator) + a Seedance video-bed branch B (07 → 08-seedance → 09-ambient-video-mux) + a source.jpg-driven step 05a. New columns: `channels.scene_themes` + `channels.seedance_motion_prompt`; `albums.scene_image_prompt` + `scene_seedance_prompt` + `scene_title`. See `docs/plans/2026-05-14-ambient-video-scene-generation.md`.

## 1. Goals & Non-Goals

**Goals (v1):**
- Run 5-20 YouTube music channels from one machine.
- Per channel: scheduled album generation (cron-style), 30 Suno songs → DistroKid release → 2h YouTube compilation video → metadata + thumbnail.
- Daily YouTube Data API v3 stats per channel (subs, views, watch time) for feedback loop and dashboard analytics.
- Strictly serial execution to keep shared Suno/DistroKid/Flow accounts safe.
- Operator manually uploads videos to YouTube using generated metadata.
- Render videos in parallel with DistroKid submission to minimize wall-clock time per album. Hold YouTube upload for `content_id_hold_days` to avoid Content ID self-flagging.

**Non-goals (v1):**
- YouTube auto-upload.
- DistroKid live mode without explicit operator confirmation.
- Parallel album execution.
- Per-channel Suno/DistroKid/Flow accounts (shared accounts only).
- A/B thumbnail testing.
- Multi-machine distribution.
- Lyric/vocal manual editing UI.

## 2. Data Model

```ts
type Channel = {
  id: string;                          // ulid
  name: string;                        // "sad-ambient", "lofi-study"
  displayName: string;                 // "i'm crying" (channel branding)
  description: string;                 // Internal notes about niche
  active: boolean;                     // false = scheduler skips
  scheduleCron: string;                // standard cron, e.g. "0 9 * * 1" (Mon 9am)
  // === DORMANT template-name columns (Session 10: kept for back-compat, NEVER read by code) ===
  // The new content-bearing prompt_<kind> columns below replace these. A future v6 cleanup may drop them.
  albumBriefTemplate: string | null;
  trackBriefsTemplate: string | null;
  coverPromptTemplate: string | null;
  thumbnailPromptTemplate: string | null;
  ytMetadataTemplate: string | null;
  // DistroKid
  distrokidArtistName: string;
  distrokidPrimaryGenre: string;
  distrokidLabelName: string | null;
  // YouTube
  youtubeChannelId: string | null;     // For stats fetch (UC...)
  youtubeChannelHandle: string | null;
  // Branding
  thumbnailOverlayText: string | null;
  spotifyPlaylistUrl: string | null;
  hashtags: string;                    // CSV
  // === Suno per-channel (added v4) ===
  sunoModel: string;                   // 'chirp-fenix' default
  sunoMode: 'custom' | 'description' | 'persona';
  sunoInstrumental: boolean;
  sunoPersonaId: string | null;
  distrokidArtistVerifiedAt: number | null;
  // === v5 (Session 10) — workflow + per-channel pipeline + prompts + DK overrides ===
  workflow: 'ambient' | 'rap-compilation' | 'ambient-video';
  tracksPerAlbum: number | null;       // override workflow default (ambient 30, rap 10, ambient-video 30) when set
  targetVideoSeconds: number | null;   // ambient + ambient-video; null = use settings.target_video_seconds
  brollFolderPath: string | null;      // rap only; absolute path to a folder of video clips
  sunoStylePrompt: string | null;      // long descriptive "voice" of the channel; interpolated into step 01's LLM template
  promptAlbumBrief: string | null;     // per-channel content for step 01's prompt (NOT a name)
  promptTrackBriefs: string | null;    // step 02
  promptCoverImage: string | null;     // step 05a
  promptThumbnail: string | null;      // step 05b
  promptYtMetadata: string | null;     // step 10
  youtubeImageAspect: 'letterbox' | 'crop' | null;  // null = use settings.youtube_image_aspect
  distrokidSongwriterName: string | null;            // unified "First Last"; split on whitespace into DK form fields
  distrokidPerformerName: string | null;
  distrokidPerformerRole: string | null;
  distrokidProducerName: string | null;
  distrokidProducerRole: string | null;
  rapClipStrategy: 'random-fill' | 'sequential' | 'seeded-by-album' | null;
  // === v9 (2026-05-14) — ambient-video ===
  sceneThemes: string | null;           // JSON-encoded string[] of themes; null = use the hardcoded fallback theme
  seedanceMotionPrompt: string | null;  // channel-level fallback motion prompt; album.scene_seedance_prompt overrides
  // ====
  createdAt: number;
  updatedAt: number;
};

type Album = {
  id: string;
  channelId: string;
  status: 'new' | 'queued' | 'in_progress' | 'awaiting_captcha' | 'done' | 'failed';
  themePrompt: string | null;
  // Generated by step 01:
  albumTitle: string;
  artistName: string;
  primaryGenre: string;
  sunoStylePrompt: string;
  // Generated by step 05:
  coverImagePath: string | null;
  thumbnailPath: string | null;
  ytImagePath: string | null;
  // Generated by step 10:
  tracklistText: string | null;
  ytTitle: string | null;
  ytDescription: string | null;
  ytTags: string | null;
  // External IDs:
  distrokidReleaseId: string | null;
  distrokidDryRunArtifact: string | null;
  // Content ID hold tracking (v3):
  distrokidSubmittedAt: number | null;     // unix ms — set when step 06 finishes
  safeToUploadAfter: number | null;        // unix ms — distrokidSubmittedAt + content_id_hold_days * 86400000
  // Parallel pipeline tracking (v3):
  distrokidStatus: 'pending' | 'submitted' | 'failed' | 'dryrun';
  videoStatus: 'pending' | 'rendering' | 'rendered' | 'failed';
  // Operator workflow:
  finalVideoPath: string | null;
  uploadedAt: number | null;
  youtubeVideoId: string | null;
  // Per-album Suno overrides (added v4):
  sunoModel: string | null;
  sunoMode: 'custom' | 'description' | 'persona' | null;
  sunoInstrumental: boolean | null;
  sunoPersonaId: string | null;
  // v5 (Session 10): workflow snapshot at album creation time.
  // Immutable per album — protects historical accuracy when channel.workflow
  // changes later. Only albumsRepo.create() writes this.
  workflow: 'ambient' | 'rap-compilation' | 'ambient-video';
  // Branch B progress + retry (added v3 along with parallel fork):
  videoProgressPct: number;
  retryBranchOnly: 'A' | 'B' | null;
  // v9 (2026-05-14): ambient-video scene generator (step 01b) output.
  // imagePrompt is the Midjourney prompt the operator copies by hand to
  // generate source.jpg. seedancePrompt drives step 08. title overrides
  // step 10's LLM-generated yt_title.
  sceneImagePrompt: string | null;
  sceneSeedancePrompt: string | null;
  sceneTitle: string | null;
  createdAt: number;
  updatedAt: number;
};

type Track = {
  id: string;
  albumId: string;
  trackNumber: number;
  title: string;
  fileName: string;
  duration: number;
  sunoTaskId: string | null;
  sunoLyrics: string | null;
  audioPath: string | null;
  status: 'pending' | 'submitted' | 'downloading' | 'done' | 'failed';
};

type ChannelStats = {
  id: string;
  channelId: string;
  fetchedAt: number;
  subscriberCount: number;
  totalViews: number;
  videoCount: number;
};

type Settings = { key: string; value: string };
type Session = { service: 'suno'|'distrokid'|'flow'|'yt-stats'; status: 'valid'|'expired'; lastChecked: number };
```

The album-level `status` field is derived: `done` requires BOTH `distrokidStatus IN ('submitted','dryrun')` AND `videoStatus='rendered'`.

## 3. Pipeline Steps (single workflow, parameterized by channel)

| # | Step | Branch | Inputs | Outputs |
|---|------|--------|--------|---------|
| 01 | `album-brief` | sequential | channel + (theme override OR template) | albumTitle, sunoStylePrompt, primaryGenre |
| 02 | `track-briefs` | sequential | album + channel template | 30 track rows |
| 03 | `suno-generate` | sequential | 30 tracks + channel sunoStylePrompt | 30 sunoTaskIds |
| 04 | `suno-download` | sequential | 30 tasks | 30 .wav files (validated by ffprobe: 44.1kHz+, 16/24-bit, stereo) |
| 05a | `cover-image` | sequential | sunoStylePrompt + albumTitle + channel template | cover.png 3000x3000 |
| 05b | `thumbnail` | sequential | cover + channel.thumbnailOverlayText | thumb.png 1920x1080, ytImage.png 1920x1080 |
| --- | **PARALLEL FORK** | --- | --- | --- |
| 06 | `distrokid-submit` | **branch A** | album + 30 tracks + cover | releaseId OR dry-run artifact + distrokidSubmittedAt + safeToUploadAfter |
| 07 | `audio-concat` | **branch B** | 30 .wav | concat.wav |
| 08 | `loop-to-2h` | **branch B** | concat.wav | loop.wav (exactly 7200s) |
| 09 | `mux-video` | **branch B** | loop.wav + ytImage.png | final.mp4 |
| --- | **JOIN** | --- | --- | --- |
| 10 | `youtube-metadata` | sequential | album + tracklist + channel template | title.txt, description.txt, tags.txt |
| 11 | `finalize` | sequential | all artifacts | album.status = done, summary in pipeline.log |

**Branch A** = DistroKid submission. **Branch B** = video rendering (concat → loop → mux). They run concurrently within the same album. The orchestrator joins both before step 10.

If branch A fails: album.distrokidStatus='failed', branch B still completes, album.videoStatus='rendered'. Operator can retry just step 06.

If branch B fails: album.videoStatus='failed', branch A still completes, album.distrokidStatus='submitted' (or 'dryrun'). Operator can retry just steps 07-09.

If both fail: full retry available.

### Workflow variants (v3.1+)

The pipeline above is the `ambient` workflow. Each registered workflow can override `step01`, `step05a`, and `branchB` (the full sequence). Workflows registered as of v9:

| Workflow | step01 | step05a | branchB |
|---|---|---|---|
| `ambient` | 01-album-brief | 05a-cover-image (Flow) | 07 → 08-loop-to-2h → 09-mux-video |
| `rap-compilation` | 01-album-brief | 05a-cover-image (Flow) | 07-rap-audio-concat → 09-rap-broll-mux |
| `ambient-video` | 01-album-brief → 01b-scene-generator | 05a-ambient-video-cover (source.jpg) | 07 → 08-seedance-clip → 09-ambient-video-mux |

#### ambient-video specifics

- **Step 01b (`scene-generator`).** Runs after step 01 in the composed `workflow.step01`. Picks one theme from `channel.scene_themes` (JSON `string[]`; null falls back to the hardcoded `"medieval knight in a peaceful fantasy environment"`). Calls OpenRouter with `temperature: 0.9 / max_tokens: 600 / response_format: { type: 'json_object' }` and a system+user message (system = `prompts/defaults/ambient-video-scene.md`; user = the picked theme). Produces `{ scene, imagePrompt, seedancePrompt, title }` and writes:
  - `album.scene_image_prompt`, `album.scene_seedance_prompt`, `album.scene_title`
  - `projects/<channel_id>/<album_id>/scene.json` (operator reference)
  - A prominent `=`-banner in `pipeline.log` containing the Midjourney prompt so operators can copy it from the log if they miss the dashboard.

- **source.jpg convention.** ambient-video is the first workflow that doesn't depend on Flow. The operator generates a Midjourney render from the prompt above and drops it at `projects/<channel_id>/source.jpg`. The SAME image is used as:
  - cover.png / cover.jpg base (via step 05a-ambient-video-cover's `cropAndScaleSquare`),
  - ytImage.png base (via `resizeWithMode` to 1920×1080),
  - the Seedance `first_frame` AND `last_frame` (so the clip loops seamlessly).

  Workflow preflight checks that `source.jpg` exists with size > 50 KB **before step 01** so Suno doesn't burn 30 song credits on a run that can't render its video bed.

- **Step 08-seedance-clip.** Resolves the motion prompt with album > channel fallback priority (`album.scene_seedance_prompt || channel.seedance_motion_prompt`; both empty → `SEEDANCE_PROMPT_MISSING`). Submits to OpenRouter `/api/v1/videos` with `bytedance/seedance-2.0`, `generate_audio: false`, `aspect_ratio: '16:9'`, `duration: 10`, `first_frame = last_frame = source.jpg` (base64 data URL). Polls 15s × 40 (10 min budget). Downloads to `build/clip.mp4`. Validates h264 + 16:9 + duration ≥ 9s. Idempotent on a valid existing clip.

- **Step 09-ambient-video-mux.** Loops `concat.wav` → `build/loop.wav` via `loopToTarget(target_video_seconds)`. Then FFmpeg `-stream_loop -1 -i clip.mp4 -i loop.wav -map 0:v:0 -map 1:a:0 -vf scale=1920:1080:force_original_aspect_ratio=decrease,pad=...,setsar=1 ... -t target` to produce `final.mp4` of exact target duration. NVENC/libx264 via `pickEncoder`. Re-encodes video at this final pass; `-map` is mandatory (same gotcha as rap branch).

- **Step 10 title override.** When `album.workflow === 'ambient-video'` AND `album.scene_title` is non-empty, step 10 replaces the LLM-generated `ytTitle` with `scene_title` (Gates-formula). Description and tags stay LLM-generated. This is the single permitted workflow conditional in step code.

- **No Flow / no Suno bridge involvement for the visual bed.** OpenRouter `/api/v1/videos` is a stateless REST call against the same `OPENROUTER_API_KEY` as the LLM. No new sidecar / Chrome instance.

## 4. Scheduler

Subprocess runs every 60 seconds. For each `channels.active=true`:
1. Compute next cron tick from `scheduleCron`. If next tick <= now AND no album for this channel exists in `new|queued|in_progress` state → enqueue new album.
2. New album row inherits `channelId`, copies `distrokidArtistName` → `artistName`, sets `status=queued`, themePrompt=null.

Scheduler does not enqueue while ANY album is `in_progress` globally.

## 5. Stats Fetcher

Subprocess runs once daily at 03:00 UTC. For each `channels.youtubeChannelId IS NOT NULL`:
1. YouTube Data API v3 read-only: `GET /channels?id=UC...&part=statistics,snippet`.
2. Insert row into `channel_stats` with snapshot.
3. Quota: 1 unit/channel/day = 20 units/day for 20 channels. Free quota is 10,000/day.

OAuth: read-only scope `https://www.googleapis.com/auth/youtube.readonly`.

## 6. Settings (global)

| Key | Default | Notes |
|---|---|---|
| `queue_state` | `paused` | `running` enables worker |
| `scheduler_enabled` | `false` | enables cron scheduler |
| `openrouter_api_key` | env | required |
| `model_name` | `anthropic/claude-haiku-4.5` | OpenRouter model id |
| `distrokid_dry_run` | `true` | irreversible if false |
| `target_video_seconds` | `7200` | exactly 2h |
| `youtube_image_aspect` | `letterbox` | `letterbox` or `crop` |
| `suno_max_concurrent` | `1` | NEVER raise |
| `suno_poll_interval_ms` | `15000` | |
| `suno_poll_timeout_ms` | `600000` | |
| `nvenc_enabled` | `auto` | `auto`, `force`, `off` |
| `stats_fetch_hour_utc` | `3` | 0-23 |
| `content_id_hold_days` | `14` | Days after DistroKid submission before "ready to upload" badge |

## 7. API Contracts `[plan-mode]`

(extended in Session 0 plan)

## 8. Step Contracts `[plan-mode]`

(extended in Session 0 plan — for each step: inputs, outputs, error modes, retry, idempotency)

## 9. Risks

1. **Suno anti-bot lockout** if parallel sessions ever happen. Mitigation: hard `suno_max_concurrent=1`, scheduler enqueues only when worker idle.
2. **DistroKid UI drift** breaks distrokid-runner. Mitigation: dry-run default, screenshot artifact every run, smoke-test selectors weekly.
3. **Suno credit exhaustion mid-album.** Mitigation: pre-flight credit check before step 03.
4. **Flow image aspect drift.** Mitigation: post-crop in FFmpeg always.
5. **YT stats OAuth expiry.** Mitigation: refresh token persisted, daily fetcher logs auth failure to dashboard banner.
6. **Disk space.** Each album = ~3-4GB raw + 1.5GB final.mp4. 20 channels × 4 albums/month = 320GB/month. Mitigation: settings flag `keep_raw_audio_after_done` defaults to false.
7. **YouTube Content ID flagging your own video.** If video uploaded before DistroKid finishes Content ID delivery (~5-14 days), YouTube can match the audio to the licensed copy and flag/demonetize the video. Mitigation: `safeToUploadAfter` timestamp + dashboard hold badge. Operator cannot click "Mark as uploaded" until the hold expires.

## 10. Audio format requirements

**Suno output is DistroKid-compatible by default.** Suno's WAV download is 48kHz, 16-bit stereo PCM, which DistroKid accepts. Step 04 validates each downloaded .wav with ffprobe and asserts: sample rate ≥ 44.1kHz, bit depth ∈ {16, 24}, channels = 2, duration ≥ 30s. Failures throw `INVALID_AUDIO_FORMAT` and the step retries the download.

**No loudness normalization.** We accept Suno's native peak levels. Spotify's loudness normalizer handles streaming playback; YouTube uploads are unaffected. The bit-identical guarantee between DistroKid release and YouTube video matters more than perfectly leveled songs.

## 11. Project status

v1: 5-20 channels, scheduled production, manual YT upload, daily stats, single Windows machine.
