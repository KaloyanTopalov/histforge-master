# Suno Python Sidecar — Integration Design (Session 4.5)

## Context

AmbientForge's current `extensions/suno-runner/` is a Chrome extension + Node bridge whose content-script handlers (`submit`, `poll`, `download`) are stubbed. Wiring them up against suno.com from JS would require Clerk-token plumbing, hCaptcha solving, and matching Suno's `/api/generate/v2-web/` payload — all of which is already implemented in `E:\Projects\RAP SUNO\suno_bot.py` (~1400 lines, evidenced direct-API client with auth refresh, captcha browser-solver, batch logic, polling, and WAV download).

**Strategy:** Replace the Node bridge with a Python sidecar that wraps the existing `suno_bot.py` codebase. AmbientForge's TypeScript Suno consumer (`src/lib/suno/client.ts`) and the steps that call it (`03-suno-generate.ts`, `04-suno-download.ts`) keep their public shapes; the bridge becomes a thin shim around the Python process. The Chrome extension at `extensions/suno-runner/` is retired (no longer needed for direct-API).

**Out of scope for this session:** DistroKid stubs (separate session), Flow smoke test (separate session), actual implementation (this is plan-only).

## Architecture decision

```
┌─────────────────────┐     HTTP :7341     ┌─────────────────────────┐     stdin/stdout    ┌────────────────────────┐
│ AmbientForge worker │  ───────────────►  │ extensions/suno-runner/ │  ───────────────►  │ sidecars/suno/         │
│ (steps 03/04)       │  ◄───────────────  │ bridge.ts (Node, slim)  │  ◄───────────────  │ sidecar.py (long-run)  │
└─────────────────────┘                    └─────────────────────────┘    JSON-RPC        └────────────────────────┘
                                                                                                       │
                                                                                          fetch        │  CDP :9333
                                                                                                       ▼
                                                                                        ┌──────────────────────────┐
                                                                                        │ studio-api.prod.suno.com │
                                                                                        │ (direct API, Bearer)     │
                                                                                        └──────────────────────────┘
                                                                                                       │
                                                                                          captcha tokens (when needed)
                                                                                                       ▼
                                                                                        ┌──────────────────────────┐
                                                                                        │ Chrome with              │
                                                                                        │ --remote-debugging-port  │
                                                                                        │ =9333 (suno.com tab)     │
                                                                                        └──────────────────────────┘
```

**Why this layout:**
- Reuses the existing `bridge.ts` HTTP server (CORS, error mapping, route shapes) — minimal change to AmbientForge wire format.
- Python sidecar speaks JSON-RPC on stdio (no extra port to bind, no second HTTP server). The Node bridge spawns and respawns it.
- Python codebase is `suno_bot.py` ported (not vendored — adapted into a service-shaped module) so we keep one source of truth.
- Chrome with `--remote-debugging-port=9333` is the captcha solver (uses standard CDP, **no Brave required** despite suno_bot.py's hardcoded Brave path — that path is the only thing we change).

## 1. Sidecar architecture

**Process model:**
- New top-level directory `sidecars/suno/` (mirror of `extensions/`).
- Single long-running Python process `sidecar.py`. Owns Suno auth state in memory, writes refreshed cookies to `data/suno-profile/.env` so a restart picks up the latest token.
- Spawned by `extensions/suno-runner/bridge.ts` as a child via `child_process.spawn('python', ['sidecars/suno/sidecar.py'])`.
- JSON-RPC over stdin/stdout (one JSON object per line, `{id, method, params}` → `{id, result}` or `{id, error}`). Python's `sys.stdin.readline()` loop with `json.dumps(..., flush=True)` for responses.

**Why JSON-RPC over stdio (not HTTP):**
- One less port to manage, one less surface to lock down (no localhost binding accidentally exposed).
- Crash semantics are clean: bridge.ts watches the child; on stdio close, respawn after exponential backoff (cap 30s).
- No round-trip overhead for in-process pipe; gen requests are minute-scale anyway.

**Concurrently integration:**
- `package.json` `dev` script changes the `suno-br` slot from `tsx extensions/suno-runner/bridge.ts` to the same (unchanged) — bridge.ts now has supervision built-in for the Python child.
- A new dependency check at bridge startup: read `python --version`; if missing, print actionable error and exit. Document in CLAUDE.md and a new `sidecars/suno/README.md`.
- `concurrently` still owns the Node side; the Python side is bridge.ts's child, not concurrently's.

**Crash recovery:**
- Sidecar crash → bridge.ts respawns with backoff (1s, 2s, 4s, ..., 30s cap), logs `[suno-sidecar] respawn attempt N`.
- In-flight requests at crash time: bridge.ts rejects them with `SUNO_SIDECAR_CRASHED` (retriable), worker retries.
- Bridge.ts crash → concurrently restarts whole process tree; sidecar dies as orphan and bridge.ts on restart re-spawns it. Cookies persist via `data/suno-profile/.env`.

**Auth state sharing:**
- `data/suno-profile/.env` holds `SUNO_COOKIE=<__session JWT or __client cookie>`.
- Sidecar reads at startup (replicates `suno_bot.py:45`).
- Sidecar refreshes Clerk JWT on schedule (50s validity per `suno_bot.py:162`); writes refreshed cookie back to `.env` via atomic rename.
- `npm run suno:login` (already in package.json — currently TS) is rewritten to: launch dedicated Chrome user-data-dir `data/suno-profile/chrome/` with `--remote-debugging-port=9333`, prompt operator to log into suno.com, then CDP-extract the `__session` cookie and write to `data/suno-profile/.env`.

## 2. Protocol

**Bridge ↔ worker (HTTP at :7341)** — keep all existing routes from `extensions/suno-runner/bridge.ts:162-222`. Extend the `/submit` body shape to support per-channel config:

| Route | Method | Body in | Body out | Status |
|---|---|---|---|---|
| `/submit` | POST | `{stylePrompt, lyrics, model, mode, instrumental, personaId, title}` (last 5 NEW) | `{taskId}` | exists, extend body |
| `/poll/:taskId` | GET | — | `{status: 'pending'\|'ready'\|'failed', error?}` | unchanged |
| `/download/:taskId` | POST | — | binary stream (WAV) | unchanged |
| `/credits` | GET | — | `{credits: number}` | exists, real impl now |
| `/health` | GET | — | `{status, queueDepth, inFlight, sidecarAlive, sidecarPid}` | extend |

**Bridge ↔ sidecar (JSON-RPC over stdio)** — Python-friendly shape mirroring `suno_bot.py`'s natural interface:

| Method | Params | Result |
|---|---|---|
| `submit` | `{model, mode, prompt?, lyrics?, tags?, title?, instrumental, persona_id?}` | `{taskId, clipIds: [a, b]}` |
| `poll` | `{taskId}` | `{status, clips: [{id, status, audio_url?}], error?}` |
| `download_wav` | `{taskId}` | `{path, bytes}` (see "Decision: WAV streaming" below) |
| `credits` | — | `{credits}` |
| `auth_status` | — | `{cookieValid, jwtExpiresAt}` |

Mode field handled via `suno_bot.py:449-475` (custom) vs `:485-506` (description) branches in the sidecar's `submit` handler.

**Decision: WAV streaming.** 30 tracks × ~10MB = 300MB per album. Base64 over stdio works but bloats by 33%. Recommendation: sidecar writes WAV directly to disk at a path the bridge specifies, returns `{path, bytes}`; bridge.ts streams from disk to the worker's `POST /download/:id`. Path = `data/suno-profile/downloads/<taskId>.wav` (sidecar-owned, bridge-readable, deleted after worker confirms write).

## 3. Per-channel config wiring

**Schema migration (db.ts schema version 3 → 4):**

```sql
-- channels table: add 4 columns (defaults match suno_bot.py defaults)
ALTER TABLE channels ADD COLUMN suno_model TEXT NOT NULL DEFAULT 'chirp-fenix';
ALTER TABLE channels ADD COLUMN suno_mode TEXT NOT NULL DEFAULT 'custom';      -- 'custom' | 'description' | 'persona' (validated in repo)
ALTER TABLE channels ADD COLUMN suno_instrumental INTEGER NOT NULL DEFAULT 0;  -- 0/1 boolean
ALTER TABLE channels ADD COLUMN suno_persona_id TEXT NULL;                     -- null OK; future use

-- albums table: add same 4 columns as nullable overrides
ALTER TABLE albums ADD COLUMN suno_model TEXT NULL;
ALTER TABLE albums ADD COLUMN suno_mode TEXT NULL;
ALTER TABLE albums ADD COLUMN suno_instrumental INTEGER NULL;
ALTER TABLE albums ADD COLUMN suno_persona_id TEXT NULL;
```

Resolution order for step 03: `album.suno_X ?? channel.suno_X`. Worker computes `effective` config struct once at album start, passes through to `client.submit(...)`.

**Files to modify:**
- `src/lib/db.ts` — bump SCHEMA_VERSION, add migration `v4Up()`.
- `src/lib/repos/channels.ts` — add columns to mapper + ChannelInput type, set defaults in CRUD.
- `src/lib/repos/albums.ts` — add nullable columns to mapper + AlbumInput.
- `src/lib/suno/client.ts` — change `submit` signature: `submit(opts: SubmitOpts): Promise<string>` where `SubmitOpts = {stylePrompt, lyrics, model, mode, instrumental, personaId?, title?}`. Backward-compat shim (positional → opts) inside the mock client only, for existing tests.
- `src/worker/steps/03-suno-generate.ts:69` — replace `client.submit(album.sunoStylePrompt, track.sunoLyrics ?? '')` with `client.submit({stylePrompt, lyrics, model: effective.sunoModel, mode: effective.sunoMode, instrumental: effective.sunoInstrumental, personaId: effective.sunoPersonaId, title: track.title})`.
- `src/app/channels/` UI — add 4 form fields (model dropdown, mode dropdown, instrumental toggle, persona text input).
- `src/worker/__tests__/pipeline.test.ts`, `src/lib/suno/__tests__/client.test.ts` — update fixtures/mocks for new signature.

**Existing-rows safety:** `DEFAULT 'chirp-fenix'` and `DEFAULT 'custom'` apply to existing channels on `ALTER`; `INSERT` paths inherit defaults if caller omits. `NOT NULL` on channels columns + `NULL`-OK on albums columns means no row migration code needed.

**Mode validation:** repo-level enum check on insert/update — `if (!['custom','description','persona'].includes(suno_mode)) throw`. Sidecar additionally validates and returns `INVALID_MODE` if it sees something else.

## 4. Persona mode plumbing

**Schema (already covered in §3):** `suno_persona_id TEXT NULL` from day one.

**Sidecar:** dedicated `submit_persona_mode(persona_id, ...)` function with explicit failure mode:

```python
def submit_persona_mode(persona_id, ...):
    # TODO(persona): payload field name not yet captured from suno.com /api/generate/v2-web/.
    # Capture by: open suno.com/create, select persona, click Generate, watch DevTools Network
    # tab for /api/generate/v2-web/, copy the request body. The new key (likely persona_id or
    # similar) goes into the payload below alongside `mv`.
    raise SidecarError('PERSONA_PAYLOAD_NOT_CAPTURED',
                       'Persona mode plumbing in place; payload field name needs network capture.')
```

Sidecar registers `submit` to dispatch to `submit_custom_mode`, `submit_description_mode`, or `submit_persona_mode` based on `mode` field.

Worker step 03 surfaces the error code: dashboard banner "Channel X uses persona mode but Suno payload field hasn't been captured yet — switch to custom or description mode, or capture the field." Step does NOT silently fall back to a different mode.

UI: persona dropdown in channel form is *enabled* (so user can configure it), but submitting an album with persona mode shows a one-time warning modal.

When payload IS captured: only the sidecar function changes (one file, ~10 lines). Schema, repos, step 03, dashboard, error mapping are all wired already.

## 5. What `suno_bot.py` doesn't already do that we need

| Need | suno_bot.py status | Wrapper work |
|---|---|---|
| 30 sequential songs per album | yes — batch loop at `:1077-1194` | adjust `BATCH_SIZE`, `BATCH_COOLDOWN_S` defaults to AmbientForge cadence (5-10s delay, no batch cooldown — single 30-song run) |
| Idempotency for retries | NO — duplicates on retry | not needed — worker step 03 already filters `pending = tracks.filter(t => t.sunoTaskId == null)` (`03-suno-generate.ts:37`). Sidecar can be naive. |
| `NN - Title.wav` filename | NO — saves as `{title}_{clip_id[:8]}.mp3` (`:626`) | sidecar saves to `data/suno-profile/downloads/<taskId>.wav` (opaque filename); worker step 04 renames per its own pattern (`track.fileName`) when copying from the sidecar's path to `projects/<ch>/<alb>/songs/`. |
| WAV format (not MP3) | partial — `download_clip()` defaults to MP3, but Suno exposes `/api/gen/{id}/wav_file/` per `D:\ai-music-ext-main\contentScript.js:1161` | sidecar's `download_wav` calls `/api/gen/{id}/wav_file/`, follows the returned `wav_file_url`, streams to disk. |
| Audio validation (44.1kHz, 16/24-bit, stereo, ≥30s) | NO | already done by AmbientForge step 04 (`src/lib/suno/audio.ts:33-103`). Sidecar just downloads. |
| Polling cadence (15s, 10min timeout) | yes — `wait_for_clips()` at `:1200-1273` (10s default) | tweak interval to 15s; respect timeout passed in `poll` RPC params. |

**Net wrapper work in sidecar.py:** ~300-400 lines on top of imported `suno_bot.py` code. Mostly the JSON-RPC dispatcher + per-call adapter to suno_bot's class methods + WAV path logic + AmbientForge-shaped error codes.

## 6. Auth setup flow

**Operator workflow:**

```
$ npm run suno:login
[suno-login] Launching Chrome with user-data-dir=data/suno-profile/chrome/ and --remote-debugging-port=9333
[suno-login] Browser opened — log in to suno.com in the new window
[suno-login] Waiting for __session cookie... (60s timeout)
[suno-login] Cookie captured (length=1342). Saved to data/suno-profile/.env
[suno-login] Done. Leave this Chrome window open during dev sessions.
```

**`scripts/suno-login.ts` (rewrite):**
1. Check if `data/suno-profile/chrome/` exists; create if not.
2. Spawn Chrome with `--user-data-dir=<path>` `--remote-debugging-port=9333` `https://suno.com/`.
3. Connect to CDP at `localhost:9333`, find suno.com tab.
4. Poll `Network.getAllCookies` until `__session` (or `__client`) cookie appears for `*.suno.com`.
5. Write `SUNO_COOKIE=<value>` to `data/suno-profile/.env` (atomic rename).
6. Print success; leave Chrome running.

**Sidecar startup auth:**
1. Read `data/suno-profile/.env` → `SUNO_COOKIE`.
2. If missing → respond to all `submit`/`credits` calls with `SUNO_AUTH` error code (worker maps to dashboard banner).
3. If present → instantiate `SunoAuth(cookie)` (suno_bot.py:97-115).
4. On every API call, before send: check JWT expiry (`:143`), refresh if needed (`:140-177`), write refreshed JWT back to `.env`.
5. On 401 mid-call: one refresh attempt, then propagate `SUNO_AUTH` to bridge (`:382-388`).

**Cookie lifetime:** `__session` lasts ~30 days from last refresh; sidecar's auto-refresh (every ~50s when active) keeps it alive indefinitely while AmbientForge runs at least daily.

## 7. hCaptcha handling

**Strategy:** browser-assisted via CDP (replicates `suno_bot.py:208-341` BrowserCaptchaSolver), using **Chrome** (not Brave — only the path is changed).

**Operator setup:**
- The Chrome instance launched by `npm run suno:login` (user-data-dir `data/suno-profile/chrome/`, `--remote-debugging-port=9333`) stays open during dev.
- Sidecar connects to CDP at `localhost:9333` only when captcha is required.

**Captcha-required detection:** `_check_captcha_required()` at `suno_bot.py:408-422` → `POST /api/c/check {ctype: "generation"}`. Sidecar calls this before each `/api/generate/v2-web/` request. If response says required, runs the browser solver inline; payload then includes `token`.

**No Brave dependency:** suno_bot.py's `suno_auth.py:27` hardcodes Brave's path; we override to Chrome. CDP is browser-agnostic; only the executable path needs adjusting. Sidecar config: `BROWSER_PATH=$env:CHROME_PATH ?? 'C:\Program Files\Google\Chrome\Application\chrome.exe'`.

**Fallback path (future, optional):** add a setting `captcha_service: 'browser' | 'twocaptcha'` plus `twocaptcha_api_key` setting. If browser unreachable, sidecar tries 2captcha. Out of scope for Session 4.5 — wire the setting names and config plumbing only, leave the implementation as a documented gap.

**Failure modes surfaced to dashboard:**
- `CAPTCHA_BROWSER_UNREACHABLE` → "Chrome not running with debug port. Run `npm run suno:login` and leave Chrome open."
- `CAPTCHA_SOLVE_FAILED` → "Suno captcha could not be solved automatically. Solve manually in the Chrome window, then retry the album."
- `CAPTCHA_REQUIRED_NO_FALLBACK` → only if `captcha_service=twocaptcha` but no API key set.

## 8. Risk inventory

**Path 2 (this plan) risks:**
- **Suno API drift** (HIGH) — `/api/generate/v2-web/` payload shape, `mv` value list, response structure. Suno deploys frequently. Mitigation: sidecar emits raw response on parse failure; one capture-and-fix iteration per drift event. Risk floor is ~2-4h per drift.
- **Anti-bot detection on direct API** (MEDIUM) — Suno may flag direct-API patterns (header fingerprints, request rate, IP). suno_bot.py already mitigates with realistic headers + delays, but at AmbientForge's scale (30 songs/album × 20 channels/week = 600/week) this is more pronounced. Mitigation: tune batch cadence; possibly add proxy rotation later.
- **Captcha tightening** (MEDIUM) — Suno could make captcha mandatory on all generates and harder to solve via headless. Mitigation: have 2captcha fallback wired as a setting (Section 7).
- **Operator forgets to leave Chrome open** (HIGH likelihood, LOW severity) — sidecar fails fast with clear error; not a data-corruption risk.
- **Python dependency bloat** (LOW) — adds Python 3.10+ requirement to dev setup. Mitigated by `sidecars/suno/requirements.txt` + a dev-setup README.
- **suno_bot.py code drift inside its source repo** (LOW) — we're forking, not symlinking. Vendor copy lives in `sidecars/suno/`. Document the upstream path so future updates can be diffed in.

**Path 1 (extension wiring) risks for comparison:**
- Clerk JWT extraction from MAIN-world page — fragile, may break on Suno frontend updates.
- 3-5h estimated per the prior inventory; same drift risk as Path 2 but per-stub instead of one codebase.
- Captcha still needs a solution (Path 1 doesn't get one for free).

**Both paths share:**
- **Suno session expiry** — operator must re-login periodically. Mitigated identically in both: dashboard banner.
- **Persona payload unknown** — neither path can build the payload without operator-captured network traffic. Identical blocker.
- **Credit exhaustion mid-album** — fails the same way at the same place (step 03 pre-flight check).
- **30 songs per album cadence** — Suno doesn't publish rate limits; both paths could trip them.

**New risks Path 2 introduces that Path 1 doesn't:**
- Process supervision (Python child crashes on Node parent). Mitigated by bridge.ts respawn logic + concurrently isolation.
- Cross-process serialization overhead for WAV bytes. Mitigated by file-path handoff (Section 2 "WAV streaming" decision).
- Dev env has 6 things to install (Node + Python + ffmpeg + Chrome with debug port + Suno login + OpenRouter key) instead of 5.

## Files to create

```
sidecars/suno/sidecar.py           — JSON-RPC entry point, dispatcher (REAL, Session 4.5)
sidecars/suno/captcha.py           — local vendor of BrowserCaptchaSolver, rewritten for current
                                     Suno UI (REAL, Session 4.6 — always-Advanced-tab form fill,
                                     Instrumental toggle via computed bg, Create-disabled wait)
sidecars/suno/requirements.txt     — requests, python-dotenv, websocket-client (REAL)
sidecars/suno/README.md            — operator setup notes (REAL)
sidecars/suno/suno_client.py       — DEFERRED. Currently imported from suno_bot.py at SUNO_BOT_PATH;
                                     vendor only if upstream source becomes unavailable.
sidecars/suno/auth.py              — DEFERRED. Same — SunoAuth still imported from suno_bot.py.
```

## Files to modify

```
extensions/suno-runner/bridge.ts             — drop extension face, add Python child management + JSON-RPC client
src/lib/suno/client.ts                       — submit signature change to SubmitOpts
src/lib/db.ts                                — schema v3 → v4, ALTERs
src/lib/repos/channels.ts                    — 4 new fields in mapper + CRUD
src/lib/repos/albums.ts                      — 4 nullable override fields in mapper + CRUD
src/worker/steps/03-suno-generate.ts:69      — pass effective config to submit
src/app/channels/[id]/page.tsx (or similar)  — 4 form fields in channel CRUD
scripts/suno-login.ts                        — rewrite for Chrome CDP cookie capture
package.json                                 — no changes to dev script (bridge.ts gains supervision); add npm run suno:sidecar for diagnostics
CLAUDE.md                                    — document Python prerequisite + Chrome debug-port setup
.claude/rules/domain-suno.md                 — update with sidecar architecture, replace bridge-references
```

## Files to retire (do not delete this session — mark as deprecated)

```
extensions/suno-runner/content.js           — extension content script, no longer used (move to .deprecated)
extensions/suno-runner/background.js        — same
extensions/suno-runner/popup.html, popup.js — same
extensions/suno-runner/manifest.json        — same
```

Defer hard-delete to the session after Session 4.5 succeeds end-to-end against real Suno. The directory rename keeps git history clean for the reused `bridge.ts`.

## Verification (Session 4.5 acceptance criteria)

1. `npm run db:init` migrates from v3 → v4 cleanly on a populated DB; existing channel rows get default `suno_model='chirp-fenix'`, `suno_mode='custom'`, `suno_instrumental=0`, `suno_persona_id=NULL`.
2. `npm run suno:login` launches Chrome with debug port 9333, captures `__session` cookie, writes `data/suno-profile/.env`. Operator can verify cookie length > 100.
3. `npm run dev` starts; bridge.ts logs `[suno-bridge] sidecar pid=<N> started`. `GET /credits` returns the operator's real Suno credit count (verifies sidecar + auth + direct API).
4. Queue an album on a real channel with `suno_mode='custom'`. Step 03 pre-flight credits check passes; first track submits, returns a real taskId; bridge.ts log shows the JSON-RPC round-trip.
5. After step 04 completes for one track: `data/suno-profile/downloads/<taskId>.wav` was created, then deleted; `projects/<ch>/<alb>/songs/01 - Track 1.wav` exists, `ffprobe` confirms 44.1kHz+ stereo 16/24-bit ≥ 30s.
6. Sidecar SIGKILL during a long-poll → bridge.ts logs `[suno-sidecar] respawn attempt 1`; new sidecar process picks up; in-flight `/poll/:id` request fails with `SUNO_SIDECAR_CRASHED` (retriable); worker retries; album completes.
7. Persona-mode album → step 03 fails with `PERSONA_PAYLOAD_NOT_CAPTURED`, dashboard banner appears, album marked failed (not silently downgraded).
8. Captcha challenge during submit → sidecar invokes Chrome CDP, captcha solves silently, submission proceeds. Operator can SEE the captcha being solved in the Chrome window (not headless).

## Critical files referenced

**Source-of-truth Python (E:\Projects\RAP SUNO\):**
- `suno_bot.py:97-199` — `SunoAuth` class (cookie + Clerk refresh)
- `suno_bot.py:208-341` — `BrowserCaptchaSolver` (CDP, port 9333)
- `suno_bot.py:449-475` — `create_song()` custom mode payload `{prompt, tags, title, mv, make_instrumental, token?}`
- `suno_bot.py:485-506` — `create_song_description_mode()` `{gpt_description_prompt, mv, make_instrumental, token?}`
- `suno_bot.py:516-529` — `get_clip()`, `get_feed()` polling endpoints
- `suno_bot.py:611-643` — `download_clip()` (defaults to MP3; we override to WAV via `/api/gen/{id}/wav_file/`)
- `suno_auth.py:109-156` — Brave-CDP cookie extraction (we change browser path to Chrome)
- `suno-extension/BRIDGE.md:106-178` — RPC protocol patterns to mirror

**AmbientForge target files:**
- `src/lib/suno/client.ts:22-27` — current SunoClient interface (extend submit signature)
- `src/lib/suno/client.ts:147-182` — error codes (extend with SUNO_SIDECAR_CRASHED, PERSONA_PAYLOAD_NOT_CAPTURED, CAPTCHA_*)
- `src/worker/steps/03-suno-generate.ts:43-59` — credit pre-flight (unchanged)
- `src/worker/steps/03-suno-generate.ts:69` — submit call site (signature change)
- `src/worker/steps/04-suno-download.ts` — audio validation (unchanged)
- `src/lib/db.ts:185-189` — singleton DB connection
- `extensions/suno-runner/bridge.ts:162-222` — HTTP route table (worker face stays; extension face removed)
- `package.json:9` — dev script (no change to concurrently args; bridge.ts internal logic changes)

## Open decision flagged for execution session

**File path for sidecar code:** plan recommends `sidecars/suno/`. If the user prefers `extensions/suno-runner/sidecar.py` to keep all Suno code under one folder, the plan applies identically — only paths in §"Files to create" and the bridge.ts spawn argument change. Confirm at execution time.
