# Session 4.6 Handoff

Written end-of-session 2026-04-27. Read this first tomorrow.

## 1. Where we are right now

- **Sessions 1, 2, 3, 5, 6, 7, 8 committed.** Most recent commit before today's session: `732d640 session 8: youtube metadata + tracklist + content id hold UI + mark-as-uploaded`.
- **Session 4.5 committed today** as `d589390 session 4.5: real suno integration via python sidecar + per-channel model/mode/instrumental/persona`. 26 files changed, +1568/-260. Adds:
  - DB schema v3→v4 (4 new channel columns, 4 nullable album columns)
  - Python sidecar at `sidecars/suno/{sidecar.py, requirements.txt, README.md}`
  - Node bridge rewrite (drops extension face, spawns Python child, JSON-RPC over stdio, exponential-backoff respawn)
  - SunoClient `submit(opts: SubmitOpts)` signature change
  - Per-channel UI (model + mode + instrumental + persona)
  - `scripts/suno-login.ts` rewrite for Chrome CDP cookie capture
  - `docs/suno-sidecar-plan.md`
- **Session 4.6 NOT started.** That's tomorrow's work — see §5.
- **Real-account smoke test in progress.** Auth fully verified. Generation automation is the blocker (see §3).

## 2. What works in real mode (verified end-to-end this session)

| Capability | Evidence |
|---|---|
| Suno auth via `__client` cookie | `python -c "from suno_bot import SunoAuth; a = SunoAuth(<cookie>, cookie_name='__client'); a.get_token()"` returns a 1373-char fresh JWT |
| Bridge `/credits` returns real number | `Invoke-RestMethod http://localhost:7341/credits` → `3920` |
| `check_credits()` returns full plan info | Premier plan, 3920 credits, 6080/10000 monthly used |
| Python sidecar process model | Spawn-by-bridge, JSON-RPC over stdio, exponential-backoff respawn (1/2/4/8/16/30s caps), no-cache instantiation in `_get_client()` |
| Bridge timeouts | `RPC_SUBMIT_TIMEOUT_MS = 180_000` (3 min for /submit), default 60 s for /poll, /credits; /download already 5 min |
| Worker-side timeouts | `BRIDGE_SUBMIT_TIMEOUT_MS = 200_000` (slightly > bridge so bridge times out first with clean error code) |
| Login script captures `__client` | Filter `c.name === '__client' && c.domain.includes('suno.com')`. Captures 615-char JWT from `auth.suno.com`. Log line: `[suno-login] __client cookie captured (length=615)` |
| Sidecar forces correct cookie name | `auth = SunoAuth(cookie, cookie_name="__client")` — the eyJ heuristic from `suno_bot.py:1009` is bypassed because modern Clerk emits `__client` as JWT-shaped (starts with `eyJ`), which fooled the heuristic |
| `BrowserCaptchaSolver` WS handshake to Chrome | Chrome launched with `--remote-allow-origins=*` so CDP accepts non-default-Origin WS connections |

## 3. What doesn't work and why (Session 4.6 problem)

**Manual generation in `suno.com/create` Chrome window WORKS** — the user confirmed this. So cookie auth + Suno account + hCaptcha + the suno.com web app are all healthy.

**Automated submit fails** with `RuntimeError: No clips returned from browser generation (timed out)` after the BrowserCaptchaSolver's internal 120 s deadline (`E:\Projects\RAP SUNO\suno_bot.py:305`).

**Root cause:** `BrowserCaptchaSolver.submit_song` in `E:\Projects\RAP SUNO\suno_bot.py:227-341` was written against an older Suno UI. The CSS-substring + button-text-match selectors don't all hit the current Suno DOM. Specifically:

1. **Forces `Advanced` tab unconditionally** (`suno_bot.py:244-248`). Description-mode tests want the `Simple` tab. Wrong tab = wrong form fields visible.
2. **Style textarea hunt is broken.** JS: `placeholder.includes("moombahcore" || "style" || "genre")`. Current placeholder = rotating recommended-style suggestions like `"melodic, melodious, rowdy, high voice, driving rhythms"`. None of the literal substrings match — style field never gets filled.
3. **No Instrumental toggle.** JS doesn't enable the Instrumental switch even when `instrumental=true` is passed. Combined with empty lyrics + unfilled style, Create button stays disabled (or Suno rejects on submit) → no `/api/generate/v2-web/` request fires → solver waits its 120 s and gives up.

The `Authentication failed` errors from earlier rounds are GONE. Auth is fixed. The remaining problem is purely UI-automation drift.

## 4. DOM probe findings (live CDP probe, this session)

Probed `https://suno.com/create` via `Runtime.evaluate` with credentials present (3920 credits visible).

| Selector the JS expects | Live DOM | Status |
|---|---|---|
| Button text `"Advanced"` | exists | ✅ stable |
| Button text `"Simple"` | exists | ✅ stable (new tab option) |
| Button text `"Custom"` | does not exist | n/a (suno_bot.py only checks "Advanced") |
| Button aria-label `"Create song"` | exists | ✅ stable |
| Lyrics textarea via `placeholder.includes("lyrics")` | placeholder = `"Write some lyrics or leave blank for instrumental"` (also `data-testid="lyrics-textarea"`) | ✅ matches (substring "lyrics" present) |
| Style textarea via `placeholder.includes("moombahcore"\|"style"\|"genre")` | placeholder rotates: `"melodic, melodious, rowdy, ..."` etc | ❌ **STALE — no match.** Wrapper has stable `data-testid="create-form-styles-wrapper"` |
| Title input `placeholder*='title'` or `'Title'` | placeholder = `"Song Title (Optional)"` | ✅ matches |
| Network response URL filter `"generate" in url AND "v2" in url` | Suno still uses `/api/generate/v2-web/` | ✅ stable |
| Description-mode prompt textarea | NEW: placeholder = `"Describe the sound you want"` (in Simple tab) — no current selector targets this | ❌ **MISSING ENTIRELY in submit_song** |

Other facts surfaced:
- `[data-testid='lyrics-textarea']` exists — stable selector for lyrics field.
- `[data-testid='create-form-styles-wrapper']` exists — stable wrapper for the style textarea.
- 4 textareas total on the page; placeholders: `"Write some lyrics or leave blank for instrumental"`, `"melodic, melodious, rowdy, high voice, driving rhythms"`, `"Futuristic ebm song about carefree living"`, `"Describe the sound you want"`.
- 19 inputs, 2 of them with placeholder `"Song Title (Optional)"` (one per Simple/Advanced form).
- Many new aria-labels introduced since the solver was written: `Save lyrics, Clear lyrics, Generate lyrics, Expand lyrics box, Personalize style prompt to match your taste, View saved style prompts, Refresh recommended styles, Add style: <name>` …

## 5. Session 4.6 plan — vendor BrowserCaptchaSolver into sidecars/suno/captcha.py

This is tomorrow's work. Plan-mode this in a fresh Claude Code session.

**Goal:** vendor a corrected `BrowserCaptchaSolver` into `sidecars/suno/captcha.py`, have `sidecar.py` import it from there instead of from `suno_bot`, and verify end-to-end /submit → /poll → /download against a real ambient-piano test track.

### PART 1 — Vendor the existing class (no behavior change yet)

Goal: get a clean baseline that imports cleanly and passes the same broken behavior, so any rewrite delta is isolated.

Tasks:
- Create `sidecars/suno/captcha.py`. Copy `BrowserCaptchaSolver` (`suno_bot.py:208-341`) verbatim. Module-level `import websocket` instead of late import.
- Pull `CDP_PORT = 9333` constant in. Make it overridable via env var `SUNO_CDP_PORT`.
- Update `sidecar.py` import: `from captcha import BrowserCaptchaSolver` (or `from sidecars.suno.captcha import ...` depending on Python module resolution — likely the former since `sys.path` is set to the directory the bridge spawns the process from).
- Verify: kill sidecar, retest `/submit` for description mode. Should fail in the SAME way (timeout after 120 s). Confirms the vendor copy is wired up without behavior drift.

### PART 2 — Rewrite the JS injection for the current Suno UI

Goal: form filling actually completes for both Simple (description) and Advanced (custom) modes.

Tasks:
- Make `submit_song` accept `mode: "custom" | "description"` as a new arg (sidecar.py already knows the mode — it's in `params`).
- For `mode="description"`:
  - Click the `Simple` tab button (text exact match, mirroring the existing Advanced match).
  - Find the textarea with placeholder `"Describe the sound you want"` (or query within whatever wrapper the Simple tab provides — probe DOM to confirm a stable hook exists).
  - Set its value via `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set` + `_valueTracker` clear + dispatch `input` event (existing pattern, keep).
  - Toggle Instrumental checkbox if `instrumental=true`. Need a DOM probe to find the right selector — likely an `input[type="checkbox"]` near a label "Instrumental", or a `role="switch"` button with that aria-label. PROBE BEFORE WRITING.
  - Click Create (`aria-label="Create song"` is still good).
- For `mode="custom"`:
  - Click `Advanced` tab.
  - Fill `[data-testid="lyrics-textarea"]` (stable hook now exists).
  - Fill the textarea inside `[data-testid="create-form-styles-wrapper"]` (stable hook now exists).
  - Fill title input with placeholder `"Song Title (Optional)"`.
  - Toggle Instrumental if `instrumental=true`.
  - Click Create.
- Common: keep the network monitor as-is (`Network.responseReceived` filter on `"generate" in url AND "v2" in url`). That layer is fine.

Open question for Part 2: model selection. Suno's UI lets you pick the `mv` (chirp-fenix, chirp-crow, etc.) via a dropdown. The current `submit_song` ignores the `model` param entirely (the JS never touches a model picker). For Session 4.6 we can document this as "uses whatever model is currently selected in the UI" — meaning the operator manually selects the model in the Chrome window once and leaves it. Real per-album model switching is a follow-up.

### PART 3 — Verify the three smoke tests in isolation

Once Part 2 ships, run from PowerShell:

1. **submit (description, instrumental):**
   ```powershell
   Invoke-RestMethod -Method Post -Uri http://localhost:7341/submit -ContentType 'application/json' -Body (@{
     stylePrompt = "slow ambient piano, 60 BPM, A minor, soft pads, late-night reflective, no percussion"
     lyrics = ""
     title = "AmbientForge sidecar smoke test"
     model = "chirp-fenix"
     mode = "description"
     instrumental = $true
   } | ConvertTo-Json)
   ```
   Expect `{taskId: "af-suno-NNNNNN"}` within ~60-90 s. If captcha challenge appears in the Chrome window, operator solves it manually; sidecar's network monitor will pick up clips when they arrive.

2. **poll (every 30 s until ready or 10 min):**
   ```powershell
   Invoke-RestMethod -Method Get -Uri "http://localhost:7341/poll/<taskId>"
   # → {status: "pending" | "ready" | "failed"}
   ```

3. **download (writes WAV to disk):**
   ```powershell
   Invoke-WebRequest -Method Post -Uri "http://localhost:7341/download/<taskId>" -OutFile "data/test-suno-smoke.wav"
   ```
   Then verify:
   ```powershell
   ffprobe data/test-suno-smoke.wav
   ```
   Should report ≥44.1 kHz, 16/24-bit, stereo, ≥30 s duration.

### PART 4 — Cleanup, commit, retire stale code

Once smoke tests pass:
- Delete the stale fallback comment in `sidecars/suno/sidecar.py` referencing `from suno_bot import ... BrowserCaptchaSolver` (we now import locally).
- Update `docs/suno-sidecar-plan.md` §"Files to create" to reflect that `captcha.py` is real now, not aspirational.
- Update `.claude/rules/domain-suno.md` to mention the local vendored captcha module.
- Commit message: `session 4.6: vendor + rewrite browser captcha solver for current suno ui`
- After commit, **cancel and recreate the queued album `01KQ7HS1MXZ14TXH1QREC7XN79`** (it's been sitting in DB since before any of the auth fixes; safer to enqueue fresh).

## 6. Current process state at end of this session

- **Chrome (debug-port 9333):** **NOT LISTENING anymore.** Chrome.exe processes still in tasklist (31304, 39952), but port 9333 is free. The dedicated CDP Chrome was closed at some point during the round. Implication: tomorrow `npm run suno:login` must be re-run to relaunch Chrome with `--remote-allow-origins=*` and recapture the cookie. (The persistent profile at `data/suno-profile/chrome/` keeps the user logged in; just relaunching gets a fresh cookie.)
- **Bridges (still running):**
  - port 3003 (Next.js web): PID 19840
  - port 7341 (suno bridge → Python sidecar): PID 40560
  - port 7342 (distrokid bridge): PID 57180
  - port 7343 (flow bridge): PID 62296
- **Python sidecar:** PID 11820 (has the cookie_name="__client" fix loaded — verified via `/credits` working in this round).
- **Database:** `data/ambientforge.db`, schema v4. Contains:
  - 1 channel: `01KQ7HRA4SJ9GX6JMC4Q3CNWR1` name=`sad-ambient-01`, artist=`AetherSound`, active=1, defaults `suno_model='chirp-fenix'`, `suno_mode='custom'`, `suno_instrumental=0`, `suno_persona_id=null`. (Defaults — was created before per-channel UI shipped, so picked up the ALTER defaults.)
  - 1 album: `01KQ7HS1MXZ14TXH1QREC7XN79`, status=`queued`, channel matches above, theme/title/style empty (never ran step 01). **Should be cancelled and recreated** before triggering — it predates auth fixes and the per-channel column ALTER.
  - `data/suno-profile/.env` contains `SUNO_COOKIE=<__client JWT, length=615>`. May or may not still be valid tomorrow — Clerk's `__client` is long-lived (~30 days) so likely still good, but will need re-capture if Chrome is restarted.
- **Settings:** `queue_state=paused` (was set so the album wouldn't auto-pick up). `openrouter_api_key` is set (length=73). `distrokid_dry_run=true`. `target_video_seconds=7200`. `content_id_hold_days=14`.

## 7. Tomorrow's pickup steps (numbered)

1. **Confirm dev still running:**
   ```powershell
   Invoke-RestMethod http://localhost:3003/api/health
   Invoke-RestMethod http://localhost:7341/health
   ```
   Both should respond. If not, `npm run dev` from the project root.

2. **Confirm Chrome alive on 9333:**
   ```powershell
   Get-NetTCPConnection -LocalPort 9333 -State Listen
   ```
   If empty, run `npm run suno:login` — relaunches Chrome with `--remote-allow-origins=*` and the persistent profile (still logged into Suno). Wait for `[suno-login] __client cookie captured (length=615)`.

3. **Verify auth path:**
   ```powershell
   Invoke-RestMethod http://localhost:7341/credits
   ```
   Should return a real number (≈3920). If `Authentication failed`, the `__client` cookie has rotated server-side — re-run `npm run suno:login`. If still failing, kill the sidecar PID (whatever it is — fetch from `/health`) so the bridge respawns it (the no-cache fix means it'll re-read the file).

4. **Open the Session 4.6 plan in a fresh Claude Code session in plan mode.** Paste this exact prompt:

   > Read `docs/SESSION-4.6-HANDOFF.md` first. Then proceed with the Session 4.6 plan documented in section 5. Open with a sub-plan and ask only blocking questions before starting implementation.

5. **After Session 4.6 ships:** cancel + recreate the queued album. From the dashboard (http://localhost:3003), delete album `01KQ7HS1MXZ14TXH1QREC7XN79` and queue a fresh one. The fresh one inherits the channel's per-channel Suno config, which can now be edited in the channel form.

## 8. Open follow-ups not blocking Session 4.6

- **DistroKid stub fixes** — 5 metadata fields (genre, language, explicit, release date, label), `start_release` (likely needs simulated click + MutationObserver for React routing), `verify_artist` (iterate dropdown options), screenshot capture via `chrome.tabs.captureVisibleTab` from background. ~3-5h. Candidate for Session 4.7. `extensions/distrokid-runner/content.js:259, 265, 274, 290, 302` are the stub call sites.
- **Persona mode payload capture** — open `suno.com/create`, select a saved persona, click Create, watch DevTools Network for `/api/generate/v2-web/` body. Extract the new field name (likely `persona_id`). Wire into `sidecars/suno/sidecar.py` `submit_persona_mode`. 30 min once captured. Until then, persona-mode albums fail fast with `PERSONA_PAYLOAD_NOT_CAPTURED`.
- **Sessions 9-13 still pending:**
  - 9 — channel scheduler (cron parsing, auto-enqueue at scheduled times)
  - 10 — YouTube Data API OAuth setup (`npm run yt-stats:auth`, handle resolution, refresh token storage)
  - 11 — daily stats fetcher subprocess + `channel_stats` rows
  - 12 — channel analytics dashboard (delta computation from snapshots)
  - 13 — DistroKid live-mode flip (the "type SUBMIT to confirm" flow + audit log)
- **Album E retry-B → status=done bug** from Session 7 — when `retry_branch_only='B'` is set on a previously-failed album, branch B succeeds and the runner overwrites step 11's `status=failed` write to `status=done`. Surfaced during Session 8 verification. Pre-existing; not on the critical path.

## 9. Files modified this session

### Already committed in `d589390 session 4.5`:

```
732d640 session 8: youtube metadata + tracklist + content id hold UI + mark-as-uploaded
a934ebb session 7: parallel fork goes live + steps 07-09 (concat, loop, mux) + per-branch retry
5e55e30 session 6: distrokid-runner extension + step 06 dry-run + captcha banner + content id hold timestamps
84629fb session 5: flow-runner extension (reused YouForge) + steps 05a/05b cover and thumbnail
c6efb92 session 3: album-brief + track-briefs steps with template overrides + mock mode
0285f3b chore: ignore local scratch file
4182838 session 2: channel CRUD + worker queue + parallel fork stub (port 3003)
acb48a8 session 1: repo scaffold + DB + dashboard skeleton
2051f4c plan: v1 implementation plan approved
d589390 session 4.5: real suno integration via python sidecar + per-channel model/mode/instrumental/persona
```

### Uncommitted (working tree changes from auth-debug rounds today):

```
modified:   extensions/suno-runner/bridge.ts        — RPC_SUBMIT_TIMEOUT_MS = 180_000 added
modified:   package-lock.json                        — @types/ws added (devDep) + transitive churn
modified:   package.json                             — @types/ws added to devDependencies
modified:   scripts/suno-login.ts                    — switch to ws package, capture __client (not __session), --remote-allow-origins=*, log errors per-attempt
modified:   sidecars/suno/sidecar.py                 — no-cache _get_client, force cookie_name="__client", BrowserCaptchaSolver fallback path on 422
modified:   src/lib/suno/client.ts                   — BRIDGE_SUBMIT_TIMEOUT_MS = 200_000 + per-method timeout override
```

These six files are the entire delta from `d589390` to "current working tree." Lint clean, type-check clean, all 215 tests pass. They are NOT committed because each round we wanted to verify against the running Chrome/sidecar before persisting. They will be folded into the Session 4.6 commit once the smoke tests pass.

## 10. End-of-session machine state recommendation

User's call. Two options:

- **Stop dev cleanly** (recommended): `Ctrl+C` in the `npm run dev` window. Tomorrow restart with `npm run dev` + `npm run suno:login`. Cleanest state. Cookie file may need refresh if Suno rotated it overnight.
- **Leave dev running:** Chrome (if relaunched), bridges, sidecar all stay warm. Tomorrow just verify with `/credits`. Machine keeps processes overnight.
