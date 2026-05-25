# domain-suno

Use when modifying: `sidecars/suno/`, `extensions/suno-runner/bridge.ts`, `lib/suno/`, steps `03-suno-generate`, `04-suno-download`. The Chrome-extension content scripts under `extensions/suno-runner/{content,background,popup}.*` are retired (Session 4.5) — keep them in tree until the sidecar is verified end-to-end against real Suno, then delete.

## Architecture

Worker → Node bridge (port 7341) → Python sidecar (`sidecars/suno/sidecar.py`, JSON-RPC over stdio) → studio-api.prod.suno.com.

The sidecar imports `SunoAuth` and `SunoDirectClient` from the path in `SUNO_BOT_PATH` (default `E:\Projects\RAP SUNO`) but `BrowserCaptchaSolver` is **locally vendored** at `sidecars/suno/captcha.py` (Session 4.6) so we can evolve form-fill JS independently as Suno's UI drifts. hCaptcha is solved via Chrome at `--remote-debugging-port=9333` (run `npm run suno:login` once; leave that Chrome window open).

See `docs/suno-sidecar-plan.md` for the full design.

## Rules

- One shared Suno account across all channels. **Never run two Suno sessions in parallel** — anti-bot will lock the account.
- Submit songs **sequentially** with 5-10s delay between. Parallel submission triggers anti-bot.
- Polling: 15s interval, 10min timeout per song.
- Pre-flight credit check before step 03. Bridge exposes `GET /credits`. If credits < required, fail step with `INSUFFICIENT_SUNO_CREDITS` and surface a dashboard banner.
- **Suno style prompt is per-track via `selectSunoPromptRotation` (Session 13).** Step 03 calls the rotation helper which assigns one prompt per track from the channel's active collection (round-robin sorted by id). With N active prompts and M tracks, each prompt appears `floor(M/N)` or `ceil(M/N)` times so all styles are exercised when M ≥ N. The picked id + content snapshot are persisted on `tracks.suno_prompt_id` + `tracks.suno_prompt_resolved_text` so retries don't re-roll. Album-level `albums.suno_prompt_id` + `suno_prompt_resolved_text` are set to track-1's pick (audit "primary"). Single-active-prompt channels and legacy-column channels degenerate to all-tracks-same-style transparently.
- Lyrics from `track.sunoLyrics`. Each Suno submission combines the per-track style prompt with the per-track lyrics — both come from the track row, not the album row.
- Filename format: `NN - Title.wav` (zero-padded, space-dash-space, .wav). DistroKid bulk uploader expects this. Step 04 owns the rename when copying from sidecar's tmp path.
- Always download .wav. The endpoint is **two-step** (verified Session 4.6): `POST /api/gen/{id}/convert_wav/` to trigger server-side WAV transcoding, then poll `GET /api/gen/{id}/wav_file/` until it returns `{wav_file_url}`, then stream-download the URL. .mp3 is not used in v1.
- Bridge HTTP server on port 7341. Routes: `POST /submit`, `GET /poll/:id`, `POST /download/:id`, `GET /credits`, `GET /health`.
- Sidecar JSON-RPC methods: `submit`, `poll`, `download_wav`, `credits`, `auth_status`. One JSON object per line on stdio.
- **Per-channel config:** `channels.suno_model`, `channels.suno_mode`, `channels.suno_instrumental`, `channels.suno_persona_id`. Albums can override each (nullable column = inherit from channel).
- **Modes:** `'custom'` (lyrics + style + title), `'description'` (Suno writes lyrics from a prompt), `'persona'` (saved persona id — payload field name not yet captured; sidecar fails fast with `PERSONA_PAYLOAD_NOT_CAPTURED` until captured). The captcha-solver fallback path always submits via the Advanced-tab form regardless of `mode` (Suno's current Simple-tab "Describe the sound you want" textarea is vestigial — disconnected from the Create-button watcher); for description mode, the prompt goes into the style textarea with empty lyrics, which is functionally equivalent.
- **Audio validation after download** (step 04): ffprobe each .wav, assert sample rate ≥ 44.1kHz, bit depth ∈ {16,24}, channels = 2, duration ≥ 30s. Throw `INVALID_AUDIO_FORMAT` on failure; retry once before failing the step.
- **Auth:** sidecar reads `SUNO_COOKIE` from `data/suno-profile/.env`. Refresh is automatic via Clerk. On 401 propagate `SUNO_AUTH` to dashboard; operator runs `npm run suno:login` to re-capture.
- **Bridge-disruption pause-and-resume.** When step 03 or step 04 see one of `SUNO_BRIDGE_UNREACHABLE`, `SUNO_BRIDGE_TIMEOUT`, `SUNO_BRIDGE_ERROR`, `SUNO_SIDECAR_CRASHED`, or `SIDECAR_INTERNAL` (helpers in `src/lib/suno/bridge-disruption.ts`), they patch the album to `awaiting_suno_relogin`, set the `suno_bridge_disrupted` settings flag, and throw — *no track is marked as `failed`*. Tracks that haven't been submitted yet stay at `status='pending'` with `sunoTaskId=null`; on resume, step 03 picks up exactly those. Distinct from `suno_cookie_rotated` because the recovery is "restart Chrome / sidecar / bridge" rather than "re-run `npm run suno:login`". `POST /api/albums/:id/resume-suno-auth` clears both flags. The runner's `recoverInProgress` clears both on worker startup.
- **Self-healing Chrome / sidecar.** The Suno bridge (`extensions/suno-runner/bridge.ts`) spawns Chrome on startup if port 9333 isn't responding (no-op if `npm run suno:login` already left a Chrome window open) and runs a 30s-interval watchdog (`extensions/suno-runner/chrome-manager.ts`). On Chrome death the watchdog respawns it with the saved profile, refreshes `__client` via CDP, and asks the sidecar to restart so it re-reads `data/suno-profile/.env`. Cookie persistence in the Chrome profile means re-spawn is non-interactive after the first-time login.
- **Worker auto-resume on bridge recovery.** Each `runOnce` tick calls `tryAutoResumeAfterBridgeRecovery` (in `src/worker/bridge-recovery.ts`). When `suno_bridge_disrupted` is set AND `suno_cookie_rotated` is empty AND `/health` reports `sidecarAlive: true` AND `/credits` returns 200, the paused album is patched back to `queued` and the flag is cleared. Probes are throttled to every 30s. Cookie-rotation pauses are intentionally NOT auto-resumed — those need `npm run suno:login` to re-capture the long-lived `__client` cookie.

## Anti-patterns

- Headless Playwright on Suno. Use the dedicated Chrome+CDP profile that `npm run suno:login` provisions.
- Generating songs in parallel. Worker must serialize.
- Hardcoding song durations. Suno returns variable lengths; read via ffprobe after download.
- Conflating sunoStylePrompt with artistName.
- Conflating sunoStylePrompt with sunoModel — they're separate channel fields. `sunoStylePrompt` is the per-track style descriptor (resolved by `selectSunoPromptRotation` from the channel's prompt collection); `sunoModel` is the `mv` value (e.g. `chirp-fenix`).
- Reading `albums.suno_prompt_id` from step 03 to drive the actual submit. That FK is the audit "primary" (track-1's pick), NOT the per-track style. Step 03 must call `selectSunoPromptRotation` and use `tracks.suno_prompt_id` / the returned per-track content for each submission.
- Loudness normalization. We accept Suno's native peaks.
- Submitting a persona-mode album when the payload field hasn't been captured. Switch the channel to `custom` or `description` first.
- Bypassing the Chrome+CDP captcha solver. Captcha shows up unpredictably on `/api/generate/v2-web/`.
- Marking individual tracks as `status='failed'` when the underlying error is in `BRIDGE_DISRUPTED_CODES` (see `src/lib/suno/bridge-disruption.ts`). Those errors invalidate the whole submission session — pause the album instead so the resume path can pick up cleanly.
