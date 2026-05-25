# Ultra Review — 2026-04-30

Audit of the most recent 10 commits on `main`, focused on the rap-pipeline groundwork (steps 09-rap + per-track style rotation) and the 5-commit Suno auto-recovery feature.

| commit  | summary                                                                  |
| ------- | ------------------------------------------------------------------------ |
| 5fded68 | rap-channel: dynamic mock-response placeholders + b-roll resolution audit |
| 4c551d9 | step 09-rap: scale broll to 1920x1080 + fix audio-stream selection       |
| 9e63225 | suno: per-track style rotation across album tracks (v8)                  |
| f76b026 | suno: pause-and-resume on bridge / sidecar / Chrome disruption (phase 1) |
| bb63022 | suno: Chrome auto-respawn watchdog in bridge (phase 2)                   |
| d60db24 | suno: worker auto-resume on bridge recovery (phase 3)                    |
| 473567f | suno: fix bridge-recovery to also probe Chrome CDP (phase 3 fix)         |
| 7c0a933 | suno: chrome-manager lands on /create + ensureSunoCreatePage helper     |
| 76abaa0 | channels: dropdown for Suno model (mv) instead of free-text input        |
| 5196643 | validation: first real rap album end-to-end + step-09-rap 1080p scaling  |

Severity tags:

- **Critical** — would corrupt data, leak secrets, or crash production
- **Major** — would cause intermittent failures or recovery issues; fix before scaling
- **Minor** — quality-of-life, polish, future-bitrot
- **Observation** — architecture notes worth knowing, no fix needed

---

## Critical findings

None.

The first 10 tracks ran end-to-end on real Suno; `final.mp4` is 1920×1080 H.264 + AAC 192k with the audio fingerprint matching `concat.wav` (i.e., the `-map` fix does work). No data-loss path was found.

---

## Major findings

### M1. `ensureChromeRunning` does not call `ensureSunoCreatePage` when Chrome is already alive
**File:** `extensions/suno-runner/chrome-manager.ts:193-205`

```ts
export async function ensureChromeRunning(): Promise<boolean> {
  if (await isChromeAlive()) {
    console.error(`[chrome-manager] Chrome already alive on port ${CDP_PORT}`);
    return true;            // <-- returns without ensuring /create
  }
  try {
    await spawnChrome();    // spawnChrome DOES call ensureSunoCreatePage
    return true;
  } ...
}
```

`spawnChrome()` calls `ensureSunoCreatePage()` after Chrome reports alive (chrome-manager.ts:118), so respawns post-crash land on /create. But the early-return branch when Chrome is *already* alive (the common case on bridge boot after `npm run suno:login` lands the operator on `/discover`) skips it entirely.

This is exactly the bug 7c0a933 was meant to close, and it still leaves a hole: bridge startup doesn't re-navigate. The standalone `scripts/ensure-chrome.ts` does call all three (`ensureChromeRunning → refreshCookieFromChrome → ensureSunoCreatePage`), but the bridge itself doesn't.

**Symptom:** first Suno submission after `npm run dev` fails with `advanced_tab_not_found` if Chrome happened to be on `/discover`. Phase 1 pauses the album. Phase 3 probes find Chrome alive (because `/json/version` doesn't care about URL), auto-resumes. Step 03 fails again. Loop until operator runs `scripts/ensure-chrome.ts` or restarts.

**Fix:** call `ensureSunoCreatePage()` in the early-return branch too, e.g.:

```ts
if (await isChromeAlive()) {
  console.error('[chrome-manager] Chrome already alive on port ${CDP_PORT}');
  await ensureSunoCreatePage();   // belt-and-suspenders
  return true;
}
```

Same logic applies inside the watchdog respawn path (bb63022 chrome-manager.ts:333-342) — `spawnChrome` already calls it, but if Chrome dies and the SAME-process recovery races (next finding M2), one of the spawnChrome calls might short-circuit.

### M2. Watchdog can spawn Chrome twice when respawn takes longer than the tick interval
**File:** `extensions/suno-runner/chrome-manager.ts:318-343` (introduced in bb63022)

`watchdogTick` is `async` but `setInterval` fires regardless of whether the previous tick is still pending. `spawnChrome`'s polling loop runs up to `SPAWN_WAIT_TIMEOUT_MS = 60_000` while the watchdog tick interval is `30_000`.

Scenario:

1. t=0:    tick — Chrome alive, ok.
2. t=30s:  Chrome died at t=29s. `isChromeAlive()` false. `consecutiveFailures = 1`. Below threshold (2). Returns.
3. t=60s:  tick — Chrome still down. `consecutiveFailures = 2 → 3`. Threshold met. Calls `await spawnChrome()`. Spawn polls for up to 60s.
4. t=90s:  *previous spawnChrome still polling*. New tick fires concurrently. `isChromeAlive()` may still be false (new Chrome warming up). `consecutiveFailures = 4`. Threshold met. Calls `spawnChrome()` AGAIN — **second concurrent spawn**.

There is no guard for "already spawning." On Windows, Chrome detects a profile lock on `--user-data-dir` and forwards the URL to the existing instance, so it's mostly silent — but it wastes a 60s spawn attempt and leaves zombie processes if the lock detection ever fails.

**Fix:** either an `isSpawning` boolean guard, a `Promise<void> | null` lock, or reset `consecutiveFailures` BEFORE the spawn to suppress the next tick.

```ts
let inFlightSpawn: Promise<void> | null = null;
async function watchdogTick(opts: WatchdogOptions): Promise<void> {
  if (inFlightSpawn) return; // already recovering
  ...
  inFlightSpawn = spawnChrome().finally(() => { inFlightSpawn = null; });
  await inFlightSpawn;
  ...
}
```

### M3. CLAUDE.md still claims "schema v5"; current `DB_VERSION` is 8
**File:** `CLAUDE.md:12`

> Forked from HistForge. Single Windows machine, RTX 4070, Node 20, TypeScript, Next.js 14, SQLite (better-sqlite3, schema **v5**), Tailwind.

`src/lib/db.ts:6` has `export const DB_VERSION = 8;`. The Project Overview line was last updated when the schema was v5 and three subsequent migrations (v6, v7, v8) didn't bump it.

This is documentation drift, not a runtime bug, but CLAUDE.md is the source of truth referenced by every contributor. Easy fix: change `**v5**` → `**v8**` and consider replacing the literal version with "see `DB_VERSION` in `src/lib/db.ts`" so future bumps don't repeat the drift.

### M4. `chrome-manager` cookie refresh requires Chrome respawn — won't catch Clerk in-place rotation
**File:** `extensions/suno-runner/chrome-manager.ts:269-302`

`refreshCookieFromChrome()` is only called inside `spawnChrome` (after a fresh spawn) and the watchdog's recovery branch (after a respawn). If Chrome stays alive and Clerk rotates `__client` in place (which Clerk does periodically without bouncing the SPA), the sidecar's `data/suno-profile/.env` keeps the old value. Next Suno API call returns 401, step pauses with `awaiting_suno_relogin` + `suno_cookie_rotated`, and the operator has to manually run `npm run suno:login`.

The CLAUDE.md spec acknowledges that "Cookie rotation pauses are intentionally NOT auto-resumed," so this is partially a deliberate design choice. But the cookie file could be refreshed on a slower cadence (e.g., once per hour) without needing Chrome to die — that would close the gap when Clerk rotates the cookie inside an otherwise-healthy Chrome.

**Suggested fix:** add a separate periodic timer that runs `refreshCookieFromChrome()` and, when the cookie value actually changed, asks the sidecar to restart. Cheap probe (~1ms) so 1h interval is plenty.

### M5. `recover-failed-album.js` operates directly on production DB with hard-coded path
**File:** `scripts/recover-failed-album.js:18`

```js
const db = new Database('data/ambientforge.db');
```

The script writes to the production DB without any dry-run flag, confirmation, or environment override. Mistyping the album ID can't corrupt the DB (the WHERE clause is targeted), but a script run during an active worker tick races with the runner's own writes — there's no transactional fence.

This is a one-shot recovery helper and should probably be replaced or supplanted by Phase 1 (which already turns submission failures into `awaiting_suno_relogin` instead of `failed`). Once Phase 1 is in production, this script is dead code; consider deleting it or moving it to `scripts/legacy/`.

If kept, add:
- env override for DB path (parity with `rap-validation-run.ts`)
- a sanity prompt when running against `data/ambientforge.db` specifically
- abort if `albums.status = 'in_progress'` (worker is mid-run)

---

## Suno auto-recovery system (commits f76b026 → 7c0a933) — focused audit

This is a 5-commit feature that introduces fully hands-off recovery from Chrome death / sidecar crash / bridge-port disruption. The four files involved:

- `src/lib/suno/bridge-disruption.ts` (new — phase 1)
- `extensions/suno-runner/chrome-manager.ts` (new — phase 2; extended in 7c0a933)
- `extensions/suno-runner/bridge.ts` (extended — phase 2)
- `src/worker/bridge-recovery.ts` (new — phase 3, fixed in 473567f)

### Race / deadlock analysis

#### R1. **Recovery loop on healthy bridge but bad Chrome URL** — addressed but not airtight
Phase 3's original implementation (d60db24) probed `/health` + `/credits`, neither of which exercise Chrome. 473567f added a `/json/version` probe to catch dead Chrome, but `/json/version` is true regardless of which page Chrome is on. M1 above is the residual hole: if Chrome is alive on `/discover`, every probe returns healthy → auto-resume → step 03 fails → pause → repeat indefinitely. The 30s probe throttle keeps the loop slow but doesn't stop it.

**Recommendation:** add a fourth probe that checks the Suno tab's URL (or, less brittle, asks the sidecar to do a no-op form-fill probe). Or fix M1 so the URL is always `/create` post-recovery.

#### R2. **`pauseAlbumForBridgeDisruption` doesn't throw**
**File:** `src/lib/suno/bridge-disruption.ts:34-50`

The helper sets the flag + patches the album, then returns. The caller (step 03 / step 04) is expected to throw the underlying SunoError so the orchestrator's catch records it. This contract is documented in the docstring but enforced only by convention. A future caller that forgets to re-throw would silently swallow the error and let step 03 continue submitting (with a paused-album state), producing inconsistent track-status writes.

**Fix:** make the helper throw, or add a return type that forces the caller to deal with it (e.g., `never` / `throw new SunoBridgePauseError(err)`).

#### R3. **Module-level `consecutiveFailures` and `lastProbeAt` leak across tests**
**Files:** `extensions/suno-runner/chrome-manager.ts:316`, `src/worker/bridge-recovery.ts:33`

Both modules use module-level mutable state for throttling. `bridge-recovery.ts` exposes `__resetBridgeRecoveryThrottle` which the test suite calls in `beforeEach`. `chrome-manager.ts` does NOT expose a reset for `consecutiveFailures` — but it has no tests, so this is latent rather than active. If/when chrome-manager gets unit tests, the helper will need a reset.

**Recommendation:** export `__resetChromeWatchdogState` even if unused right now, so the test layer is ready when added. Match the bridge-recovery pattern for parity.

#### R4. **Phase-3 probe order: bridge → sidecar → Chrome → /credits**
**File:** `src/worker/bridge-recovery.ts:88-130`

Looks correct. Each probe is a dependency of the next: if bridge is down, no point probing sidecar; if sidecar is down, no point probing Chrome; if Chrome is down, no point probing /credits. Latency budget: 2s + 2s + 5s = 9s worst case before a result. Throttled to once per 30s. All probe failures preserve `awaiting_suno_relogin`.

The `attempted: true` semantics are slightly inconsistent: a probe that fires and returns `bridge-down` is `attempted: true`, but a `cookie-rotation-takes-precedence` skip is `attempted: false`. That distinction is meaningful for telemetry (we want to count actual network probes separately from no-ops) but the field name is ambiguous. Consider renaming `attempted` → `probed` or adding `probedHttp: boolean` for clarity.

#### R5. **`malformed-flag-cleared` leaves album in `awaiting_suno_relogin` with no flag**
**File:** `src/worker/bridge-recovery.ts:130-146`

When the flag's JSON fails to parse:

```ts
} catch {
  setSetting('suno_bridge_disrupted', '', db);
  return { attempted: true, resumed: 0, reason: 'malformed-flag-cleared' };
}
```

The album that was paused stays at `awaiting_suno_relogin` with no flag pointing to it. There's no automatic recovery — the next probe sees `no-flag` and short-circuits. Operator must manually re-queue.

This is mostly defensive (corrupt JSON shouldn't happen), but the failure mode is "stuck album, no banner." Better: scan for any album in `awaiting_suno_relogin` and patch back to `queued` when the flag goes away mid-recovery, or log loud enough that the dashboard surfaces a "no-flag-but-paused-album" warning.

#### R6. **Sidecar `restart()` relies on an exit-handler respawn instead of inline spawn**
**File:** `extensions/suno-runner/bridge.ts:177-196` (introduced bb63022)

```ts
restart(): void {
  if (this.child) {
    this.child.kill('SIGKILL');   // exit handler respawns via setTimeout
    this.respawnAttempts = 0;     // reset backoff
  } else {
    this.start();
  }
}
```

The `exit` handler schedules a respawn via `setTimeout` (the existing logic), so there's a brief window after `restart()` returns where `this.child === null`. Any `/submit` arriving in that window fails with SIDECAR_INTERNAL → Phase 1 pauses → Phase 3 probes will see `sidecarAlive: false` → no auto-resume yet → next 30s probe sees it healthy → resume. So it self-heals, but the bounce is visible to inflight requests.

Acceptable trade-off because Phase 1+3 catches it. Note for future: an `await this.start()` inside `restart()` would close the gap if you wanted hard atomicity.

### Observations on the recovery system

- **The flag → status pairing is the right primitive.** A single boolean wouldn't be enough because we need to know which album was paused (so Phase 3 can patch the right row). The JSON-encoded `{albumId, channelId, code, detail, at}` payload is sized appropriately and serves as both diagnostic and recovery key.
- **Cookie-rotation precedence is documented and tested.** Good. The reasoning (cookie rotation needs human intervention) is captured in code AND CLAUDE.md AND the test name.
- **The Chrome respawn → cookie refresh → sidecar restart sequence is the right order.** Chrome must be alive before we can read cookies; cookie must be on disk before sidecar starts so it picks up the fresh value. Documented in chrome-manager.ts comments.
- **No tests for the watchdog itself** (acknowledged in commit message bb63022). The recovery flow is covered end-to-end via Phase-3 tests, but the Chrome process-management is integration-only. This is a reasonable trade-off for a development-host-specific component.

---

## Minor findings

### Mn1. `chrome-manager.ts` `getSunoCookies` falls back to `tabs[0]` when no suno.com tab found
**File:** `extensions/suno-runner/chrome-manager.ts:217-219`

```ts
const tab = tabs.find((t) => t.url.includes('suno.com')) ?? tabs[0];
```

`Network.getAllCookies` returns the entire cookie jar regardless of which tab the WS is opened against, so this is functionally fine. But the fallback is misleading — if all suno.com tabs were closed, we'd still extract `__client` from the universal jar (which could be empty). The check downstream (`!client || client.value.length < 50`) catches the empty case, so no functional issue. Worth a comment explaining the fallback is just for the WS endpoint, not which jar.

### Mn2. `audio-fingerprint.js` assumes 16kHz sample rate for zero-crossing normalization
**File:** `scripts/audio-fingerprint.js:24`

```js
return Math.round(count / (n / 16000));
```

The PCM extraction (not in the script — done via the prior ffmpeg invocation that writes `final-audio.raw` etc.) sets the sample rate. If the operator changes that to 44.1kHz, the per-second ZC counts will be off by 2.75x. Relative comparisons still work, but the "440 ≈ 220Hz" hint in the script's print is misleading.

Either accept a sample rate argument or document the implicit pre-step.

### Mn3. `broll-resolution-audit.js` hardcodes a Windows-specific operator path
**File:** `scripts/broll-resolution-audit.js:15`

```js
const BROLL_DIR = 'E:\\Projects\\RAP SUNO\\assets\\broll';
```

For a one-shot audit this is fine, but if you want to re-run it against another channel's broll folder you'd have to edit the source. Take the path from `argv[2]` with the current as default.

### Mn4. Hard-coded rap channel ULID in two scripts
**Files:** `scripts/patch-prod-rap-prompts.js:18`, `scripts/patch-yt-metadata.js:4`

```js
const RAP_CHANNEL_ID = '01KQEWE6ABBET01YJHXSDV7WVB';
```

These are one-shot patch scripts and the comment at the top of each acknowledges the limitation. Acceptable, but the redundancy means a future channel ID change requires touching both files. Could consolidate via `process.argv[2]` or a tiny shared constants file.

### Mn5. `chirp-custom:b24fbc2b-04b8-4838-8029-8e9489db3d4b` is operator-specific
**File:** `src/lib/suno/models.ts:31`

The "Kane Victor (custom)" entry is the operator's specific custom-trained Suno model UUID. It's hard-coded into the source-of-truth registry, which means:

1. Anyone who clones the repo and uses the dropdown sees a phantom option pointing to your model UUID.
2. Sharing the repo / sample data / open-sourcing is a leak (it's not a secret, but it's account-identifying).

**Recommendation:** move per-operator custom models out of `models.ts` and into a per-channel field or a runtime config (settings table or `.env`). The two stock models (`chirp-fenix`, `chirp-crow`) can stay in the registry; everything else is data.

### Mn6. `capture-suno-create-payload.ts` race on `ws.once('message')`
**File:** `scripts/capture-suno-create-payload.ts:80-100`

`ws.send(getRequestPostData)` then `ws.once('message')` — the listener is attached AFTER the send. If the response arrives between `ws.send` and `ws.once`, it'd be missed. In practice the round-trip is on the order of milliseconds and there's no way the response comes back before the next event-loop tick, so this never fires in practice. But it's a smell. Bind the listener first:

```ts
const reply = new Promise<void>((res) => ws.once('message', (d) => { ...; res(); }));
ws.send(JSON.stringify(...));
await reply;
```

### Mn7. `patch-prod-rap-prompts.js` patch-2 silently no-ops while patch-1 hard-exits
**File:** `scripts/patch-prod-rap-prompts.js:114-125`

If patch-1's regex misses, the script `process.exit(1)`s. If patch-2's `String.split(target).join(...)` produces no change, it logs a warning and keeps going. The asymmetry is documented (patch 1 already applied), but in practice you'd usually want to know if either patch missed. Consider symmetric: both warn, neither exits.

### Mn8. `final.mp4` re-render on stale 360p file is intentional but undocumented for ambient
**File:** `src/worker/steps/09-rap-broll-mux.ts:362` (commit 4c551d9)

```ts
if (probe.width !== 1920 || probe.height !== 1080) return false;
```

This is rap-only logic. The ambient pipeline doesn't have an equivalent dimension check in `09-mux-video`. If a future ambient album was rendered at the wrong size (unlikely with the static-image step 09, but not impossible if `cover.png` ever drifted), the idempotency check would skip the re-render. Not a current bug — flagging as a parallel-pipeline consistency note.

### Mn9. `bridge-recovery.test.ts` uses `Date.now()` in `setPaused` even when `nowMs` is passed to the probe
**File:** `src/worker/__tests__/bridge-recovery.test.ts:42-54`

The flag's `at` field is stamped via `Date.now()` while throttle uses `opts.nowMs`. Tests that fast-forward via `nowMs` could see flags that are "from the future" relative to throttle clock. Currently the probe doesn't compare these so it's harmless, but if anything ever does (e.g., "skip albums with stale flags older than X"), the tests would silently pass with bogus state.

### Mn10. `tracks-per-album` resolution adds a write that didn't exist pre-v8
**File:** `src/lib/suno/select-prompt.ts:204-214` (legacy single-style branch)

```ts
if (albumHasBinding) {
  const sel = await selectSunoPromptForAlbum(...);
  for (const t of tracks) {
    tracksRepo.patch(t.id, {sunoPromptId: ..., sunoPromptResolvedText: ...}, db);
  }
  return tracks.map(() => sel);
}
```

For every v7-album resume, we now write to N track rows even if step 03 isn't going to call submit (e.g., all tracks already have `sunoTaskId`). The early-return in step 03 (`if (pending.length === 0) return;`) happens AFTER `selectSunoPromptRotation`. So a no-op resume of a fully-submitted v7 album now writes to N tracks before deciding it's a no-op. Inconsequential at the row count we're at, but minor write amplification.

**Fix (optional):** call `selectSunoPromptRotation` AFTER the `pending.length === 0` early-return.

---

## Observations (no fix needed)

### O1. The 5-commit auto-recovery feature is well-architected
The phase-by-phase split — pause + flag (1) → respawn watchdog (2) → poll-and-resume (3) → fix the probe miss (3-fix) → ensure landing on `/create` (post-fix) — is exactly how this should be shipped. Each phase is independently shippable, each commit message describes the failure mode that motivated it (often with a real-run log line), and each fix is small enough to audit. This is a model for how to land a complex resilience feature.

### O2. The `-map 0:v:0 -map 1:a:0` fix is the kind of bug that only shows up via end-to-end validation
The audio-fingerprint comparison (`scripts/audio-fingerprint.js`) caught that the broll's AAC was leaking into `final.mp4` instead of the song's AAC. Nothing in the type system, the unit tests, or even ffprobe's metadata would have surfaced this — the file looked correct, the duration was correct, but the audio was wrong. The validation script's RMS + ZC comparison is the right approach: cheap, specific to the actual concern.

Worth keeping `audio-fingerprint.js` (or a polished version of it) as a recurring sanity check for any future mux-pipeline change.

### O3. `selectSunoPromptRotation` is well-factored
The four-mode resolution (resume FK / resume snapshot / fresh rotation / fallback to legacy) is documented in the helper's docstring AND mirrored in the test cases. The 14 tests cover the corners I would have wanted exercised: cascade delete, single-prompt degeneration, legacy-column fallback, v7-album migration, and id-sort determinism. The persistence pattern (`tracks.suno_prompt_id` FK + `suno_prompt_resolved_text` snapshot) is the same shape as `albums.*` from v7, which keeps the audit story consistent across schema generations.

### O4. `models.ts` is the right shape for a curated registry
A `readonly` array of `{value, label, hint}` plus an `isCustomSunoModel(value)` predicate is exactly what the dropdown needs. Adding a new model = one entry in the array + redeploy. The type also leaves room for a future per-channel default (if `chirp-crow` becomes the obvious default for new channels, the registry can grow a `default: true` flag).

### O5. The validation-run script (`scripts/rap-validation-run.ts`) is a good template
Setting all the `*_MODE=mock` env vars before any imports, using a separate `data/session-rap-validation.db`, and looping `runOnce` until terminal status — that's the pattern any future validation harness should follow. The hard timeout (10 minutes) and the explicit "should never happen in mock mode" exit code (4) for `awaiting_*` statuses are good defensive checks.

Worth canonicalizing this into `scripts/lib/validation-harness.ts` once a third workflow lands.

### O6. The `tracks.suno_prompt_id` FK + cascade-delete contract is a notable invariant
`channel-suno-prompts.ts:remove()` now nulls BOTH `albums.suno_prompt_id` and `tracks.suno_prompt_id` in a single transaction. The snapshots (`*_resolved_text`) are the audit trail. Anyone adding a new repo that references `channel_suno_prompts.id` needs to extend this transaction. Worth noting in `domain-suno.md` if not already.

---

## Test coverage summary

| Area                                          | Coverage status                                             |
| --------------------------------------------- | ----------------------------------------------------------- |
| Phase 1: bridge-disruption pause              | 3 step-03 + 1 resume-API tests (commit f76b026)            |
| Phase 2: Chrome watchdog                      | NONE (acknowledged in commit message — integration-only)   |
| Phase 3: auto-resume probe                    | 9 tests covering all reason codes (commits d60db24+473567f) |
| Phase 3 fix: Chrome CDP probe                 | 1 new chrome-down test + 4 mappings updated                 |
| Per-track style rotation                      | 14 tests (rotation, resume, single-prompt, legacy, v7→v8)   |
| step-09-rap 1080p scaling                     | NO unit test added; commit relies on real-run RMS+ZC fingerprint |
| `-map 0:v:0 -map 1:a:0` fix                   | NO unit test; same real-run validation                       |
| Suno model dropdown                           | NO test; UI-only change                                      |
| Validation scripts                            | N/A (one-shot tools)                                          |

**Coverage gaps worth filling:**

1. **Watchdog re-entrance** (M2): a unit test that calls `watchdogTick` concurrently and asserts `spawnChrome` only fires once.
2. **`ensureChromeRunning` calls `ensureSunoCreatePage`** (M1): once the bug above is fixed, regression-test the early-return branch.
3. **step 09-rap dimension regression**: a fixture test that hands `09-rap-broll-mux` a 360p input and asserts the output is 1920×1080. Given the file would re-render anyway, this is a 5-second test.
4. **Audio-stream selection**: a fixture test that builds a `full-video.mp4` with a junk AAC track and asserts the final mux's audio matches `concat.wav`, not the broll AAC.

The first two are low-effort and would catch the exact regressions M1/M2 describe.

---

## Operational observations

1. **Recovery flow is now genuinely hands-off** post-first-login, modulo M1 + M2. The 5-commit arc moves the operator from "Chrome died → manually restart everything" to "Chrome died → wait 30-90s → album resumes." Significant ergonomics win.
2. **The `pipeline.log` filtering in `watch-album.js`** is a clever lightweight tail: filter by `albumId` substring after stripping the timestamp prefix. Worth either (a) generalizing to a `tools/tail-album.js` or (b) considering whether the dashboard should expose this view directly.
3. **Phase-3 telemetry** via the `reason` field (`bridge-down` / `sidecar-down` / `chrome-down` / `auth-down` / etc.) is granular enough to drive a dashboard "what's the recovery state" panel. Currently the only consumer is the test suite.
4. **`rap-validation-run.ts`'s exit-code contract** (0=done, 1=failed, 2=hard timeout, 4=unexpected pause, 5=fatal) makes it CI-friendly. Add to `package.json` as `npm run validate:rap` once the rap pipeline ships to staging.

---

## Summary

No critical findings. Two major findings (M1, M2) are in the auto-recovery system itself and would cause the recovery to either not engage (M1: bridge-startup Chrome-on-/discover) or waste cycles (M2: overlapping watchdog ticks). Three additional major findings (M3, M4, M5) cover spec drift and operational hygiene.

The 5-commit Suno auto-recovery system is solidly architected and well-tested at the worker layer; the test gap at the watchdog layer is the main weakness. The step 09-rap 1080p fix is correct and validated end-to-end with real audio fingerprinting. Per-track style rotation is well-factored and conservatively backward-compatible.

The 8 untracked validation/recovery scripts in 5196643 are appropriate one-shot operator tools. None are production code; most have hard-coded paths that should be parameterized if they're going to stick around past next session.
