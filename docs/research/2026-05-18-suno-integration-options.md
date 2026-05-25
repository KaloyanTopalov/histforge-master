## Suno Integration into HistForge — Options & Recommendation

**Date**: 2026-05-19
**Branch**: master
**Commit**: adfd6c85086a6811e49d64089f35e8336854e1e0
**Topic**: How ambientforge integrates Suno, whether a real "Suno API" exists, and how to wire Suno into HistForge.

> Companion to `2026-05-18-ambientforge-overview.md`. That document describes what exists in `ambientforge/`; this one is the decision-support doc — three options, explicit tradeoffs, a recommendation.

## TL;DR

**Suno has no public API.** Ambientforge talks to Suno's private web-app backend (`studio-api.prod.suno.com`) using cookies copied out of a logged-in Chrome session. Auth, captcha handling, and the two-step WAV download flow are all reverse-engineered. Any integration that talks to those endpoints carries the same risk.

**Recommended: Option B (port ambientforge's bridge + Python sidecar verbatim).** With the recent vendoring of `suno_client.py` and `captcha.py` into `ambientforge/sidecars/suno/`, the previous biggest objection — "depends on an external Python repo at `E:\Projects\RAP SUNO`" — is gone. The whole Suno stack is now self-contained in ambientforge: Node bridge + Python sidecar + Chrome-CDP captcha solver, all in tree. Porting this into HistForge is the fastest path to working Suno integration and reuses code that already handles every observed failure mode (auth rotation, captcha challenges, bridge crashes, dual-variant WAV downloads).

**Option A (mirror YouForge Flow with a Suno Chrome extension)** stays a credible alternative if Suno's web UI changes infrequently *and* HistForge wants to keep the dumb-runner-extension pattern uniform across providers. But the work is larger (full extension + coordinator + per-account fleet), and it gives up captcha handling that already works.

Regardless of option: lift three pure-logic modules from ambientforge verbatim — per-track prompt rotation, ffprobe audio validation, and bridge-disruption pause semantics. They encode operational lessons that don't depend on transport.

## Is there an API?

**No public Suno API.** Suno does not document or sell direct music-generation endpoints. There are three things people refer to as "the Suno API":

1. **Suno's private web-app backend (`studio-api.prod.suno.com`).** This is what suno.com itself calls. Ambientforge calls it directly via Python (`requests`) in `ambientforge/sidecars/suno/suno_client.py`. Endpoints used:
   - `POST /api/c/check` — pre-flight captcha-required probe.
   - `POST /api/generate/v2-web/` — submit a song; **always returns 2 clips per call** (Suno generates pairs). Payload shape depends on mode:
     - `custom`: `{prompt: lyrics, tags: style, title, mv: model, make_instrumental}`.
     - `description`: `{gpt_description_prompt: prompt, mv: model, make_instrumental}`.
     - `persona`: not yet wired — sidecar throws `PERSONA_PAYLOAD_NOT_CAPTURED` until the operator captures the request body from suno.com's DevTools.
   - `GET /api/clip/{id}` — current state of one clip (status, audio_url).
   - `GET /api/feed/v2?ids=…` — batch-poll up to ~10 clips by id.
   - `POST /api/gen/{clipId}/convert_wav/` — trigger server-side WAV transcoding (the audio_url in `clip` is mp3-only).
   - `GET /api/gen/{clipId}/wav_file/` — poll until `{wav_file_url}` is populated (max ~90s), then stream the CDN URL.
   - `GET /api/billing/info/` — remaining credits.
   - `POST /api/playlist/update_clips/` — add clips to a playlist (defined in `suno_client.py` but not exercised by ambientforge).

   **Auth is Clerk-based.** Two cookie shapes are accepted:
   - **`__client`** (legacy) — opaque session token. Sidecar exchanges it for a JWT by hitting `POST https://auth.suno.com/v1/client` to learn the session id, then `POST /v1/client/sessions/{sid}/tokens` to mint the JWT. JWT is refreshed automatically on 401.
   - **`__session`** / **`_session`** — already a JWT (starts with `eyJ`). Used directly as a Bearer token; refresh path is the same.

   **Captcha.** `POST /api/generate/v2-web/` can return HTTP 422 unpredictably — Suno's self-hosted hCaptcha challenge. The sidecar catches 422 and falls back to `BrowserCaptchaSolver`, which uses Chrome at CDP port 9333 to fill the form in a logged-in tab and lets the user (or hCaptcha auto-pass) clear the challenge.

   **This is the "API" everyone reverse-engineers.** It can change at any time. No SLA, no rate-limit doc, no auth doc.

2. **Suno's marketing-page API teaser.** Suno has signalled a paid developer API in private/limited beta, but it is not generally available and was not the path ambientforge took.

3. **Third-party Suno wrappers** (`sunoapi.org`, `topmediai`, `acedata.cloud`, etc.). These wrap option 1 behind a paid REST surface and absorb the captcha drama themselves. Service-availability and ToS risk are real — Suno periodically blocks these.

## What "ambientforge has it" actually means — corrected

Two updates since the prior draft of this doc:

1. **The Suno API client IS in the ambientforge package.** `ambientforge/sidecars/suno/suno_client.py` is a verbatim vendored copy of the `SunoAuth` + `SunoDirectClient` classes that previously lived in the external `E:\Projects\RAP SUNO\suno_bot.py` repo. The file's own docstring documents the vendoring: *"Extracted verbatim from `E:\Projects\RAP SUNO\suno_bot.py` … so AmbientForge no longer depends on the external `SUNO_BOT_PATH` directory."* The sidecar imports from the sibling module, not from an `$SUNO_BOT_PATH`. The CLAUDE.md confirms this (Python 3.10+ for the sidecar; no `SUNO_BOT_PATH` mentioned). `BrowserCaptchaSolver` is similarly vendored at `ambientforge/sidecars/suno/captcha.py`. Only PyPI dependency is `requests` (plus `python-dotenv` + `websocket-client` in requirements.txt).

2. **Suno still has no public REST API for music generation.** The endpoints listed above are Suno's private web-app backend. Any integration that talks to those endpoints is reverse-engineered and subject to break when Suno changes their UI or auth. That risk does not change just because the client code is now vendored.

## Architecture of ambientforge's Suno integration (5-layer stack)

```
Worker steps 03 / 04                     (Node, TypeScript)
   ↓ HTTP localhost:7341
Node bridge   extensions/suno-runner/bridge.ts
   ↓ JSON-RPC over stdin/stdout
Python sidecar  sidecars/suno/sidecar.py
   ├─→ HTTPS REST → studio-api.prod.suno.com   (via vendored suno_client.py)
   └─→ Chrome at CDP port 9333                  (via vendored captcha.py, on HTTP 422)
Chrome (persistent profile, --remote-debugging-port=9333)
   └─→ suno.com/create  (Advanced-tab DOM filled by BrowserCaptchaSolver when API path is captcha-gated)
```

**Layer 1 — Worker steps 03 + 04 (`ambientforge/src/worker/steps/`).** Sequential per album. Step 03 submits N tracks one at a time with 5-10 s gap between submissions; assigns one style per track via the deterministic rotation in `select-prompt.ts`; checks credits pre-flight. Step 04 polls every 15 s for up to 10 min, calls `download_wav`, validates with ffprobe. Bridge-disruption codes (`SUNO_BRIDGE_UNREACHABLE`, `_TIMEOUT`, `_ERROR`, `SUNO_SIDECAR_CRASHED`, `SIDECAR_INTERNAL`) pause the album to `awaiting_suno_relogin` instead of marking tracks failed — see `src/lib/suno/bridge-disruption.ts`.

**Layer 2 — Bridge client (`ambientforge/src/lib/suno/client.ts`).** `makeSunoClient()` returns a mock (`SUNO_MODE=mock`) or HTTP client that calls localhost:7341. Maps HTTP statuses to typed errors: 401 → `SUNO_AUTH` / `SUNO_COOKIE_ROTATED` (body-disambiguated), 402 → `INSUFFICIENT_SUNO_CREDITS`, 409 → `SUNO_CAPTCHA`, 429 → `SUNO_RATE_LIMITED`, 5xx → `SUNO_BRIDGE_ERROR` (with masked sidecar code+detail). Timeouts: 30 s normal, 200 s for `/submit` (matches the bridge's 180 s ceiling for the captcha path + headroom), 120 s for `/download`. The client owns the filesystem write for downloads — bridge streams raw bytes, client `fs.writeFile`'s them.

**Layer 3 — Node bridge (`ambientforge/extensions/suno-runner/bridge.ts`).** HTTP server on **port 7341**. Routes: `GET /health`, `POST /submit`, `GET /poll/:taskId`, `POST /download/:taskId?clip=N`, `GET /credits`. Spawns `python sidecars/suno/sidecar.py` as a child process; speaks JSON-RPC line-buffered over stdio. On sidecar crash: rejects in-flight RPCs with `SUNO_SIDECAR_CRASHED` and respawns with backoff `[1s, 2s, 4s, 8s, 16s, 30s]`. The bridge also boots Chrome on startup (`ensureChromeRunning`) and runs a 30 s watchdog that respawns Chrome on death + asks the sidecar to restart so it re-reads the rotated cookie.

**Layer 4 — Chrome manager (`ambientforge/extensions/suno-runner/chrome-manager.ts`).** Spawns Chrome detached/unref'd with `--remote-debugging-port=9333 --remote-allow-origins=* --user-data-dir=data/suno-profile/chrome`, lands on `https://suno.com/create`. Cookie file at `data/suno-profile/.env`, single line `SUNO_COOKIE=<value>`. `refreshCookieFromChrome()` reads `__client` cookie via `Network.getAllCookies` and writes the .env file atomically. The 30 s watchdog has a 2-consecutive-failure threshold + a single-flight spawn lock so two ticks can't race the same user-data-dir.

**Layer 5 — Python sidecar (`ambientforge/sidecars/suno/sidecar.py`).** One JSON object per line on stdin/stdout; stderr for logs. Imports `SunoAuth`, `SunoDirectClient`, and `BrowserCaptchaSolver` from sibling modules (`suno_client.py` and `captcha.py`, both vendored). Methods:

- **`submit`** — For `custom` calls `client.create_song(lyrics, style, title, model, instrumental)`. For `description` calls `create_song_description_mode(prompt, model, instrumental)`. On HTTP 422 falls back to `BrowserCaptchaSolver().submit_song(...)` which uses Chrome to fill the Advanced-tab form via `Runtime.evaluate`, then watches for the `/api/generate/v2-web/` `Network.responseReceived` event to pull the clip ids. `persona` mode fails fast with `PERSONA_PAYLOAD_NOT_CAPTURED`. Returns `{taskId: 'af-suno-NNNNNN', clipIds: [a, b]}`. `taskId` is a sidecar-local key; the real Suno clip ids are stored in `_taskmap[taskId]`.
- **`poll`** — Reads `_taskmap[taskId]`, calls `_get_clip_with_auth_retry(client, cid)` for each clip id (retries once on 401 by nulling the JWT; if 401 persists, raises `SUNO_COOKIE_ROTATED`). Aggregates: any failed → `failed`; all complete → `ready`; else `pending`.
- **`download_wav`** — Two-step transcode flow against `studio-api.prod.suno.com`:
  1. `POST /api/gen/{clipId}/convert_wav/` (triggers server-side WAV transcoding; accepts 200/202/204/409 as success — 409 = already converted).
  2. Poll `GET /api/gen/{clipId}/wav_file/` every 3 s up to 90 s until `{wav_file_url}` is populated.
  3. Stream the CDN URL in 64 KB chunks to `data/suno-profile/downloads/<taskId>.wav` (or `<taskId>-c<N>.wav` for dual-variant clip N>0). Returns `{path, bytes}` to the bridge, which then streams the bytes to the worker and unlinks the tmp file.
- **`credits`** — `client.check_credits()` reads `/api/billing/info/` and unpacks `total_credits_left` → `credits_left` → `credits`.
- **`auth_status`** — Reports whether a cookie can be read.

`_get_client()` builds a fresh `SunoDirectClient` for every request (no caching), so a cookie rotation gets picked up on the next call without a sidecar restart. The login script always captures `__client`; the sidecar passes `cookie_name="__client"` explicitly to override the JWT-shape heuristic in `suno_client.py` (modern Clerk `__client` cookies start with `eyJ` and would otherwise be misclassified as `_session` JWTs).

## Option A — Suno-runner extension + HistForge coordinator (mirror YouForge Flow)

Build a Chrome MV3 extension that drives `suno.com/create` the same way YouForge Flow drives Google Flow. HistForge owns the queue, account fleet, webhook routes, and reaper; the extension is a dumb runner that polls for work and posts results back.

**Code shape**:
- `extensions/suno-runner/` — new Chrome MV3 extension (manifest, service worker, content script for `suno.com/create`, popup).
- `src/lib/suno-coordinator/` — queue, account-fleet, webhook routes mirroring `src/lib/google-flow-coordinator/` (resolve via `domain-google-flow-coordinator` skill).
- `src/app/api/suno/*` — webhook endpoints (poll-next, post-result, status) mirroring `app/api/flow/`.
- `src/lib/suno/` — pure logic (prompt rotation, ffprobe validation, bridge-disruption codes). Lifted from ambientforge.
- A new worker step `generate-suno-tracks-runner.ts` (or per-track if HistForge's pipeline is per-asset) that enqueues to the coordinator and waits.

**Pros**:
- Reuses the dumb-runner / coordinator pattern HistForge already has documented under `domain-google-flow-coordinator` + `domain-youforge-flow`. Webhook routes, reaper, account fleet, per-(video, account) project mapping — all generalize.
- Single language. No Python. No vendored Python module to keep current.
- hCaptcha "just works" because the extension runs inside an already-logged-in Chrome profile — same model as YouForge Flow.
- Account fleet pattern lets you scale Suno accounts across videos exactly the way you scale Google Flow accounts today. Suno's anti-bot is stricter than Flow's so this is a real advantage.

**Cons**:
- Slower per-song than direct API. Each submit waits on Suno's full UI render (~30-60 s per clip pair).
- Selector fragility: when Suno redesigns `/create`, the content script breaks. Same risk profile as YouForge Flow.
- Requires building a second runner extension — non-trivial work even with `youforge-flow` as a template.
- The DOM-driven path has to re-implement the two-step WAV download Suno's web UI uses (or fall back to mp3, which `domain-suno` explicitly forbids). The direct-API path in ambientforge already nails this — Option A throws that away.
- Suno's per-account rate limiting is stricter than Google Flow's. The coordinator needs per-account cooldown / serial-per-account locks. Ambientforge runs strictly serial across its single shared account at 5 s gap; multi-account fleet semantics are net-new design work.

**Effort**: 1.5-2.5 weeks (extension + coordinator + worker step + tests).

## Option B — Port ambientforge's bridge + Python sidecar verbatim (RECOMMENDED)

Lift `extensions/suno-runner/` (Node bridge + Chrome manager), `sidecars/suno/` (Python sidecar + vendored client + vendored captcha), and `src/lib/suno/` (client + helpers) into HistForge with minimal changes.

**Pros**:
- **Self-contained.** Since the Session-4.6 vendoring, the Suno stack has no external Python repo dependency. Copy `ambientforge/sidecars/suno/` + `ambientforge/extensions/suno-runner/` + `ambientforge/src/lib/suno/` into HistForge and you have a working Suno integration. Only Python prereq is `requests` (plus `python-dotenv` and `websocket-client`).
- **Most battle-tested path.** Sequential submit, 5 s gap, per-track style rotation, two-step WAV download (`convert_wav/` → poll `wav_file/`), ffprobe validation, bridge-disruption pause-not-fail, Chrome auto-respawn, sidecar respawn with backoff, JWT refresh, captcha 422-fallback — all working code today.
- **Captcha handled.** The hCaptcha fallback is wired and the CDP form-fill JS is vendored locally so it can evolve independently from any upstream source.
- **Less new code.** Mostly copy + wire. The biggest non-copy work is wiring step 03/04 into HistForge's workflow registry and pipeline orchestrator instead of ambientforge's.

**Cons**:
- Adds Python 3.10+ to HistForge's runtime path. HistForge already has Python (older versions used aeneas; user memory notes Python 3.14 on PATH) but the current worker is pure Node.
- Adds a long-lived bridge process to the dev stack. HistForge has zero today; ambientforge runs five concurrently. The bridge needs its own healthcheck/recovery story (`/health` endpoint + concurrently/PM2).
- The Suno chrome-manager (`chrome-manager.ts`) keeps a dedicated Chrome at CDP 9333. That conflicts with the YouForge Flow Chrome unless you give Suno its own profile path — fine to do (already the default, `data/suno-profile/chrome/`), but more state to manage.
- **Single-account model.** To run multiple Suno accounts (matching HistForge's google-flow account fleet), you'd have to redesign the bridge/sidecar around an account_id parameter — significant rework. Acceptable for v1 since ambientforge runs the whole empire on one Suno Premier account.
- Re-vendoring discipline: if Suno's internal API drifts and the upstream `suno_bot.py` ever gets updated, someone has to re-copy the affected class bodies into `suno_client.py` / `captcha.py`. The vendored file's docstring notes this expectation. Self-contained ≠ self-updating.

**Effort**: 3-5 days to port + wire. Mostly mechanical — directory copies, import path rewrites, `package.json` + `requirements.txt` merges, plus the worker-step adapter for HistForge's pipeline.

## Option C — Third-party Suno HTTP API service

Use a paid third-party (e.g. `sunoapi.org`, `topmediai`, `acedata.cloud`) that wraps Suno and exposes a clean REST API.

**Pros**:
- Trivial to call: `fetch` from `src/lib/suno/client.ts`. No Chrome, no Python, no extension, no captcha drama.
- No selector fragility — service maintainer owns that.
- Multi-account / parallel submission concerns become someone else's problem.

**Cons**:
- Pay per call. Pricing varies; can be expensive at HistForge's per-video scale.
- Service availability + ToS risk. These services exist by reverse-engineering Suno; Suno periodically cracks down. Service can disappear or get rate-limited.
- You don't own the auth path. If the service is down, your pipeline is down.
- Quality / feature parity is service-dependent. Some don't support custom models, persona mode, or instrumental toggle — and you can't see their captcha-fallback story from the outside.

**Effort**: 1-2 days for a basic integration. Add a day for retry / rate-limit handling.

## Modules worth lifting from ambientforge regardless of option

Three pieces are pure logic — no Suno-specific transport — and encode hard-won operational lessons. Copy them into `src/lib/suno/` whichever option is picked.

### 1. Per-track prompt rotation
`ambientforge/src/lib/suno/select-prompt.ts:163-245`. Given a channel's collection of active style prompts and a count of tracks, deterministically assigns one prompt per track (sort by id ASC, `sorted[i % len]`). Persists per-track + sets album's "primary" to track-1's pick for audit. Handles resume (re-fetch stored FKs), legacy single-style fallback, and zero-active-prompts fallback. Pure SQLite — no network.

### 2. ffprobe audio validation
`ambientforge/src/lib/suno/audio.ts:33-114`. Asserts sample rate ≥ 44.1 kHz, bit depth ∈ {16, 24}, channels = 2, duration ≥ 30 s. Throws `INVALID_AUDIO_FORMAT` (retriable). `audioFileValid()` is the idempotency primitive — step 04 skips already-downloaded tracks by re-validating the file on disk. Pure ffprobe — no Suno-specific knowledge.

### 3. Bridge-disruption pause-not-fail semantics
`ambientforge/src/lib/suno/bridge-disruption.ts:23-70`. The `BRIDGE_DISRUPTED_CODES` set distinguishes transport-layer failures (bridge unreachable / timeout / sidecar crashed / internal) from Suno-app failures (auth / captcha / rate-limited / cookie-rotated). On transport failure, pause the album to `awaiting_suno_relogin` and throw — **don't mark individual tracks as failed**. Already-submitted tracks keep their `suno_task_id`; unsubmitted stay `pending` for clean resume. The `bridge-recovery.ts` companion (`ambientforge/src/worker/bridge-recovery.ts:93-138`) probes the full chain (bridge `/health` + Chrome CDP `/json/version` + Suno `/credits`) and auto-un-pauses when all three are healthy. Cookie-rotation pauses are intentionally NOT auto-resumed — those require `npm run suno:login`.

This pattern is the most important architectural lift from ambientforge regardless of option. It encodes the lesson that "the sidecar died" should not result in 30 tracks being marked permanently failed — they should resume cleanly when the chain recovers.

## Next steps if Option B is picked (recommended)

1. Decide HistForge integration point: a new workflow that uses Suno, or a step inside existing workflows (the workflow registry under `src/lib/workflows.ts` is where that lives — pair with `domain-workflows`).
2. Copy in three trees (preserve git history with `git mv` from a temp branch if desired, or fresh copy):
   - `ambientforge/sidecars/suno/` → `histforge/sidecars/suno/` (Python sidecar + vendored client + vendored captcha + requirements.txt + README.md).
   - `ambientforge/extensions/suno-runner/` → `histforge/extensions/suno-runner/` (bridge.ts + chrome-manager.ts + manifest/popup/content/background JS — though manifest/popup/content/background are vestigial after the sidecar rewrite and can probably be dropped; verify against ambientforge's `domain-suno` note about Session 4.5 retirement).
   - `ambientforge/src/lib/suno/` → `histforge/src/lib/suno/` (client + bridge-disruption + select-prompt + audio + effective-config + models + modes). Tests under `__tests__/` come along.
3. Wire `scripts/suno-login.ts` (operator login flow) into HistForge's `package.json` scripts.
4. Add `concurrently` entry for `npm run suno:bridge` to HistForge's dev/start scripts (mirror ambientforge's `package.json:9`).
5. Add a worker step that calls `makeSunoClient().submit(...)` + `poll(...)` + `download(...)`. Keep it stateless: read inputs from disk, write WAVs to disk, let the orchestrator handle pause/resume.
6. Wire the bridge-recovery auto-resume probe into HistForge's worker tick (the `tryAutoResumeAfterBridgeRecovery` pattern from `ambientforge/src/worker/bridge-recovery.ts`).
7. Add `suno_cookie_rotated` + `suno_bridge_disrupted` to HistForge's settings schema (string-typed, mirror ambientforge).
8. Add a `POST /api/albums/:id/resume-suno-auth` (or HistForge-equivalent) that clears both flags.
9. End-to-end test with `SUNO_MODE=mock` first (uses fixture WAVs), then with one real song before scaling.

## File references

### Suno integration in ambientforge

- `ambientforge/sidecars/suno/suno_client.py:1-469` — **vendored Suno API client** (`SunoAuth` + `SunoDirectClient`). Verbatim from `E:\Projects\RAP SUNO\suno_bot.py`. Self-contained.
- `ambientforge/sidecars/suno/sidecar.py:1-436` — JSON-RPC sidecar (submit / poll / download_wav / credits / auth_status).
- `ambientforge/sidecars/suno/captcha.py` — vendored `BrowserCaptchaSolver` (Chrome-CDP form-fill).
- `ambientforge/sidecars/suno/requirements.txt` — `requests>=2.31`, `python-dotenv>=1.0`, `websocket-client>=1.6`.
- `ambientforge/sidecars/suno/README.md` — sidecar architecture + operator setup + RPC method table.
- `ambientforge/extensions/suno-runner/bridge.ts:1-422` — Node HTTP bridge on :7341 + sidecar child-process lifecycle.
- `ambientforge/extensions/suno-runner/chrome-manager.ts:1-398` — Chrome spawn / watchdog / CDP cookie refresh.
- `ambientforge/src/lib/suno/client.ts:1-387` — bridge client + typed error mapping (mock + real).
- `ambientforge/src/lib/suno/bridge-disruption.ts:23-70` — `BRIDGE_DISRUPTED_CODES` + `pauseAlbumForBridgeDisruption`.
- `ambientforge/src/lib/suno/audio.ts:33-114` — ffprobe + `validateAudio` + `audioFileValid`.
- `ambientforge/src/lib/suno/select-prompt.ts:163-245` — `selectSunoPromptRotation` deterministic rotation.
- `ambientforge/src/lib/suno/models.ts`, `modes.ts`, `effective-config.ts` — config surfaces.
- `ambientforge/src/worker/steps/03-suno-generate.ts` — step 03 (submit + dual-variant pair handling).
- `ambientforge/src/worker/steps/04-suno-download.ts` — step 04 (poll + two-step WAV).
- `ambientforge/src/worker/bridge-recovery.ts:93-138` — full-chain auto-resume probe.

### Suno's private API endpoints (consumed by `suno_client.py` + `sidecar.py`)

- `https://auth.suno.com/v1/client` — Clerk session bootstrap (POST).
- `https://auth.suno.com/v1/client/sessions/{sid}/tokens` — JWT mint (POST).
- `https://studio-api.prod.suno.com/api/c/check` — captcha-required probe (POST).
- `https://studio-api.prod.suno.com/api/generate/v2-web/` — submit song (POST). Returns 2 clips per call.
- `https://studio-api.prod.suno.com/api/clip/{id}` — single clip state (GET).
- `https://studio-api.prod.suno.com/api/feed/v2?ids=…` — batch poll (GET).
- `https://studio-api.prod.suno.com/api/gen/{clipId}/convert_wav/` — trigger WAV transcode (POST).
- `https://studio-api.prod.suno.com/api/gen/{clipId}/wav_file/` — poll for WAV URL (GET).
- `https://studio-api.prod.suno.com/api/billing/info/` — credits (GET).
- `https://studio-api.prod.suno.com/api/playlist/update_clips/` — playlist mutation (POST, defined but unused by ambientforge).

### Companion docs

- `docs/research/2026-05-18-ambientforge-overview.md` — full architectural reference for ambientforge (note: contains stale `ambientforge-main/` path references; the actual untracked folder is `ambientforge/`).
