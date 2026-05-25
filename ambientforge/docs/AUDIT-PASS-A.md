# Audit Pass A — Findings

Read-only architecture review, 2026-04-28 (pre-first-30-track-run). No code was changed; nothing was executed. Findings are grouped by severity. Each entry has `file:line` evidence, a one-line symptom, repro (or "code-trace only"), and a one-line suggested fix or "needs investigation."

Audit covers commits up to `798684b` (session 10 handoff), schema v5, no scheduler shipped yet (PLAN.md S9 still pending).

---

## Critical (Blocker)

Would crash a real album, lose data, leak secrets, or silently misreport release state. Fix before any 30-track run.

### C1. Runner overwrites step 11's terminal `failed` with `done` after retry-branch=B
- File: `src/worker/runner.ts:100`
- Symptom: When `retryBranchOnly='B'` runs against an album where `distrokidStatus='failed'` and branch B succeeds, step 11 correctly patches `status='failed'` (per `computeFinalStatus` in `src/worker/steps/11-finalize.ts:36-42` which requires both branches OK), but the runner unconditionally patches `status='done'` immediately after `runPipeline` returns (no failures thrown because the skipped branch resolves successfully). Album reports `status='done'` while `distrokid_status='failed'`. Documented as the "Album E retry-B → status=done bug" in `docs/SESSION-4.6-HANDOFF.md:203` and `docs/SESSION-4.7-HANDOFF.md:307` and acknowledged as pre-existing.
- Repro (code-trace): Album with prior failure (distrokid_status='failed', video_status='failed', status='failed'). POST `/api/albums/{id}/retry-branch` body `{branch:'B'}` → branch A skipped (resolves clean), branch B runs and succeeds → `pipeline.ts:240-244` Promise.allSettled returns both fulfilled, `failures=[]` → step 10 + step 11 run, step 11 sets status='failed' (correctly) → `runPipeline` returns cleanly → `runner.ts:100` overwrites to 'done'. Operator sees the album as deliverable when DistroKid actually never accepted it.
- Fix: Read the post-pipeline status before overwriting; respect `step11`'s terminal verdict. Cheapest patch: `if (after?.status !== 'failed') albumsRepo.patch(album.id, { status: 'done' })`. Better: stop writing terminal status from runner entirely — let step 11 own it.

### C2. `distrokid_dry_run` PATCHable from API with no double-confirm or live-mode guard rail
- File: `src/app/api/settings/route.ts:30` (PATCHABLE_KEYS), `src/worker/steps/06-distrokid-submit.ts:67-76` (the gate)
- Symptom: `distrokid_dry_run` is in the patchable settings list. Any localhost client (any process on the machine, any browser tab on `http://localhost:3003`) can `PATCH /api/settings {distrokid_dry_run: false}`. The hard gate at step 06 catches this in v0 — line 68 throws `DISTROKID_LIVE_MODE_DISABLED` whenever `distrokid_dry_run !== 'true'` — but the gate is the ONLY thing standing between an API write and live submission. Session 13 plans to lift the gate; at that point the spec says "Live mode requires double-confirm in dashboard" (`CLAUDE.md` Forbidden section: "Submitting to DistroKid when distrokid_dry_run=true"). Currently no double-confirm logic exists in the API; the dashboard would need to enforce it client-side.
- Repro (code-trace): Read `src/app/api/settings/route.ts:78-103` PATCH handler — accepts any boolean. No special-casing for `distrokid_dry_run`. The hard gate in step 06 saves us until S13 removes it.
- Fix: Before S13 lifts the gate, add API-level enforcement: require a second confirm field (e.g., `acknowledgeIrreversible: 'I_UNDERSTAND'`) on PATCHes that flip `distrokid_dry_run` to `false`, and rate-limit the change. Document the gate's role in CLAUDE.md so a future S13 PR doesn't drop it without replacement.

### C3. `mark-uploaded` API does not enforce `safe_to_upload_after` Content-ID hold
- File: `src/app/api/albums/[id]/route.ts:9-43` (PATCH handler)
- Symptom: Spec § 7 (`PLAN.md:212`) declares `UPLOAD_HOLD_ACTIVE (409 — now() < safeToUploadAfter)`. The route's Zod schema only validates `youtubeVideoId` (11-char regex) and `uploadedAt` (positive int). It does not read the album's `safeToUploadAfter` and refuse the update. Anyone with localhost access can mark an album uploaded the same minute DistroKid was submitted → YouTube Content ID flags the operator's own video against the licensed copy. The spec calls this out as risk #7 (`docs/ambientforge-spec.md:239`) and mitigation is described as "Operator cannot click 'Mark as uploaded' until the hold expires."
- Repro (code-trace): Album with `distrokidSubmittedAt` = now and `safeToUploadAfter` = now+14d. POST `/api/albums/<id>` with `{youtubeVideoId: "11charABCD-", uploadedAt: <now>}` → 200 OK, album row updated. Dashboard would have a disabled button but the API itself is open.
- Fix: In the PATCH handler before line 41, add `if (album.safeToUploadAfter && Date.now() < album.safeToUploadAfter) return errorJson('UPLOAD_HOLD_ACTIVE', ..., 409)`.

### C4. Step 04 (Suno download) silently swallows poll auth failures and times out 10 min per dead track
- File: `src/worker/steps/04-suno-download.ts:71-77`, `sidecars/suno/sidecar.py:214-235` (handle_poll)
- Symptom: When Suno cookie expires mid-album (e.g., during a long 30-track run), `client.poll(taskId)` raises a `SunoError('SUNO_AUTH', …, retriable=false, status=401)` from `src/lib/suno/client.ts:192`. Step 04's poll loop catches `err`, logs the message, and **resets `pollStatus = 'pending'`** (line 76). The loop continues for the full `pollTimeoutMs` (default 10 min in prod) before giving up and marking the track failed. With 30 tracks, the worst case is 30 × 10 min = 5 hours of dead polling on an expired cookie before the album fails. Worse, the sidecar's `handle_poll` silently catches the SunoError too (`sidecar.py:223-225` returns `{status: 'failed', error: '...'}` instead of propagating SUNO_AUTH up the JSON-RPC envelope), so the bridge never returns a 401 — the worker only sees "task failed" responses.
- Repro (code-trace): Stub bridge returning 401 on `/poll/*` → step 04 polls every 15s for 10min → marks track failed → moves to next track → also dies → … 30 tracks × 10min wasted. Operator sees "all tracks failed" with no `SUNO_AUTH` banner.
- Fix (two parts): (a) In `sidecar.py:handle_poll`, on a 401-shaped exception raise `SidecarError('SUNO_AUTH', ...)` so the bridge returns 401 and the worker sees it. (b) In step 04's poll loop, distinguish auth failures from transient errors — if the err is a `SunoError` with `code === 'SUNO_AUTH'` or `status === 401`, propagate it to fail the step (not the track) so the runner's catch sets album=failed and surfaces the banner.

### C5. `validate-broll` API allows any localhost caller to enumerate filesystem directories and trigger arbitrary ffprobe spawns
- File: `src/app/api/channels/validate-broll/route.ts:17-33`, `src/lib/broll/preflight.ts:41-147`
- Symptom: `GET /api/channels/validate-broll?path=<urlencoded-absolute-path>` accepts any string and passes it to `preflightBrollFolder()` which `fs.readdirSync(absPath)` and then `ffprobe`s every video file. There is no path validation — no allowlist, no traversal check, no membership in any project root. Any localhost client (browser tab, Chrome extension content script reaching `localhost:3003`, any other process on the machine) can use this to (a) confirm existence of arbitrary directories, (b) enumerate `.mp4/.mov/.webm/.mkv` files anywhere on the filesystem, (c) trigger ffprobe subprocess spawns on those files. The `ffprobe` invocation uses `execFile` (no shell), so no command injection — but the disclosure of filesystem layout + the spawn-load amplification are real.
- Repro (code-trace): `curl 'http://localhost:3003/api/channels/validate-broll?path=C:%5CUsers%5CUser%5CDesktop'` → returns whether folder exists, video count, sample filenames, codecs.
- Fix: Validate `path` against an allowlist (e.g., must start with one of: configured B-roll roots, `process.cwd()`-rooted paths). Or restrict the route to require the same album-creation cross-field validation context (i.e., only accept paths the operator has actually saved on a channel). At minimum, reject path-traversal sequences and require absolute paths.

---

## Major (Reliability)

Would cause intermittent failures or hard-to-recover state. Fix before scaling beyond ~5 channels.

### M1. `retry-branch` skips workflow preflight checks
- File: `src/worker/pipeline.ts:209-237`
- Symptom: When `retryBranchOnly` is set, the orchestrator skips both preflight checks AND steps 01-05b (line 237 conditional). For a rap-compilation album that originally passed preflight (B-roll folder valid), this is fine. But if the operator deletes/moves the B-roll folder, then triggers `retry-branch=B`, branch B runs without preflight and step 09-rap re-runs preflight as defense-in-depth (`src/worker/steps/09-rap-broll-mux.ts:107-113`) — so it still fails loudly there, *but the failure is at step 09 rather than at the preflight gate*, which is more disruptive (worse log location, runs partial setup before failing). Also, if the operator changed `channel.workflow` between the original run and the retry, `runner.ts:73` resolves the NEW workflow, so a retry of an "ambient" album could try to run rap branch B (or vice versa). The album's snapshotted `workflow` column (per `domain-workflows.md` "immutable per album") is ignored.
- Repro (code-trace): Album E originally workflow='ambient' fails branch B. Operator switches channel to workflow='rap-compilation' (legal — channel PATCH lock only blocks `in_progress`, queued/failed channels can be edited). Operator hits retry-branch=B → runner resolves channel.workflow='rap-compilation' → injects `workflow.branchB = branchBRap` → preflight skipped → step 07-rap runs but album row says `workflow='ambient'`. Mixed-workflow run.
- Fix: (a) Add preflight to retry path too (a one-line change in pipeline.ts). (b) `runner.ts:73` should prefer `inProgress.workflow` (the album snapshot) over `channel.workflow` so retries match what the album was created for. The current "defense-in-depth" comment justifying channel-precedence is backwards — the spec/CLAUDE.md says albums.workflow is immutable per album.

### M2. Step 03 silently marks tracks `failed` and continues; album proceeds with partial Suno output
- File: `src/worker/steps/03-suno-generate.ts:74-117`
- Symptom: When a track's submit fails with a non-retriable error (e.g., `SUNO_AUTH` from expired cookie), the inner attempts loop breaks, the track is patched to `status='failed'`, and the outer for-loop moves to the next track. The step itself does NOT throw — it logs `done submitted=N/30 failed=M`. The pipeline proceeds to step 04 (downloads only the submitted ones), then step 05a (cover image), step 05b (thumbnail), and finally step 06, where `DISTROKID_TRACK_FILES_MISSING` is thrown (`06-distrokid-submit.ts:153-159`) because playable count ≠ expected. Hours of Flow image gen + audio concat may have run before failing. With cookie-expiry on track 1, all 30 submissions fail in ~30 retries × 10s = 5 minutes; bad but bounded. With Suno rate limits on track 15, the album silently downgrades to a 14-track release.
- Repro (code-trace): Stub `client.submit` to throw `SUNO_AUTH` once → track 1 fails → step 03 returns `done submitted=29/30 failed=1` → pipeline continues → step 06 throws.
- Fix: After the per-track loop, throw if `failedCount > 0` so the album fails at step 03 instead of after step 05b. Or add a setting `allow_partial_track_loss` for the operator who explicitly wants to tolerate it.

### M3. Step 02 deletes existing tracks (with `sunoTaskId`s) when track-count expectation changes
- File: `src/worker/steps/02-track-briefs.ts:40-48`
- Symptom: Step 02 calls `resolveTracksPerAlbum(channel, workflow)` which honors `settings.tracks_per_album_override` first. If that setting changes between album creation and step 02 execution (or between a partial step 02 and a re-run after worker crash), step 02 sees a count mismatch (`existing.length !== N`), runs `tracksRepo.deleteByAlbum(album.id)`, and re-inserts. Any tracks that already had `sunoTaskId` populated by step 03 are wiped — those Suno credits are gone. The runner's `recoverInProgress()` (`runner.ts:42-47`) sets crashed albums back to `queued`, which means step 01 + step 02 re-run on the next pickup. If the operator changed `tracks_per_album_override` since the original step 02, the deletion fires.
- Repro (code-trace): Album mid-run (12 of 30 Suno tracks submitted, worker crashes). Operator restarts dev. Worker recovers album to queued. Operator simultaneously sets `tracks_per_album_override=3` for testing. Worker picks up, step 01 noops (album_title already set), step 02 sees existing 30 tracks vs N=3 → deletes all 30 → inserts 3 → step 03 runs against 3 fresh tracks → the 12 already-submitted Suno tasks become orphans (credits lost, no rows reference them). 12 wasted Suno credits.
- Fix: In step 02 line 45-48, refuse to delete when any existing track has a non-null `sunoTaskId`. Surface a clear error (`STEP_02_TRACK_COUNT_LOCKED`) so the operator must explicitly delete the album first. Or: snapshot `tracksPerAlbum` onto the album row (like `workflow` is) so the value is fixed at album creation.

### M4. `chatCompletionJSON` has no request timeout — can hang the worker forever
- File: `src/lib/llm/openrouter.ts:158-218` (postOnce)
- Symptom: `fetch('https://openrouter.ai/api/v1/chat/completions', ...)` is called with no AbortController and no `signal`. If OpenRouter (or the operator's network) hangs, the fetch never resolves. The worker is stuck on step 01 (or 02, or 10) indefinitely. The runner has no per-step timeout. Step 02's malformed-JSON retry loop runs `chatCompletionJSON` twice — both could hang.
- Repro (code-trace): Block `openrouter.ai` at the firewall mid-step-01. Worker hangs. No timeout fires. Album stays in_progress forever until operator kills the process.
- Fix: Add an AbortController + 60-90s timeout to `postOnce`. Map abort errors to `OPENROUTER_NETWORK` (retriable) so the existing rate-limit retry loop handles it.

### M5. `runner.ts:73` reads channel.workflow at pipeline start, ignoring `albums.workflow` snapshot
- File: `src/worker/runner.ts:73`, `domain-workflows.md` "immutable per album" rule
- Symptom: The album row records `workflow` as a snapshot at create-time, per the explicit rule "albums.workflow is denormalized — albumsRepo.create() reads channel.workflow once and writes it onto the album row. NEVER write to albums.workflow from a step or any other place. Historical accuracy depends on this being immutable per album." But the runner reads `channel?.workflow ?? inProgress.workflow` — channel takes precedence. If channel.workflow changes between album creation and pickup, the album runs the new workflow despite its snapshot saying otherwise. This is opposite of the documented contract.
- Repro (code-trace): Create rap-compilation album. Worker is paused. Operator switches channel.workflow back to ambient (passes preflight because rap brollFolderPath remains valid). Worker resumes. Album with `workflow='rap-compilation'` snapshot runs ambient pipeline (step 08 loop-to-2h fires when it shouldn't).
- Fix: Use `inProgress.workflow ?? channel?.workflow` (snapshot wins). Update the misleading comment at runner.ts:67-72. If the spec's intent is actually "channel wins for runtime decisions," update the spec instead — but only after deliberate discussion, since the M1 retry-branch issue compounds with this.

### M6. `recoverInProgress` does not clear stale `retryBranchOnly` flags or settings sentinels
- File: `src/worker/runner.ts:42-47`
- Symptom: On startup, the runner resets `in_progress` albums to `queued`. But ancillary state isn't reset: `retry_branch_only` stays set, `force_branch_b_failure_for_album` (test setting) stays set, `distrokid_captcha_pending` stays set. If a worker died mid-retry-A, the next pickup re-runs branch A (which calls `start_release` and creates a new DistroKid draft — per design, but operator must clean up). If a worker died after a pause-on-captcha, `distrokid_captcha_pending` is still in settings and the dashboard banner persists; the album is back to queued and will re-fire step 06 from scratch (clean, but the banner is misleading until the run progresses past the captcha point).
- Repro (code-trace): Force-fail one album via `setSetting('force_branch_b_failure_for_album', albumId)`, then crash the worker. Recovery puts album in queued. The setting remains, fires again on retry, force-fails again. Loop until operator manually clears the setting.
- Fix: In `recoverInProgress`, also clear: `force_branch_b_failure_for_album` (test-only), `distrokid_captcha_pending`, `distrokid_artist_missing`, `suno_insufficient_credits`. Optionally also: warn if `retry_branch_only` is set on a recovered album so the operator knows the recovery preserved the partial-retry intent.

### M7. No scheduler exists; CLAUDE.md + spec describe one as if it does
- File: `src/worker/scheduler.ts` (does not exist), `CLAUDE.md` line ~9 in Architecture, `docs/ambientforge-spec.md:188-194`
- Symptom: Per `docs/PLAN.md` Session 9 is still pending. There is no `src/worker/scheduler.ts` (verified via Glob — `src/worker/**/*.ts` returns zero scheduler matches). Yet `CLAUDE.md` lists "scheduler.ts # Cron-style scheduler subprocess" in the Architecture diagram and "Scheduler not enqueuing: scheduler_enabled setting → true" in Troubleshooting. `package.json` likely has no `scheduler:*` script. An operator following the docs to enable the scheduler would set `scheduler_enabled=true` and see no effect. Manual album POST works (`/api/albums`).
- Repro: `Glob src/worker/**/*.ts | grep -i schedul` returns nothing. Operator who reads CLAUDE.md will be confused.
- Fix: Either (a) ship Session 9 (scheduler), or (b) edit CLAUDE.md + spec to mark the scheduler as "pending Session 9" so operators don't expect it to work yet.

### M8. Channel PATCH lock only blocks `in_progress`, not `queued`/`awaiting_captcha` albums
- File: `src/app/api/channels/[id]/route.ts:82-89`
- Symptom: `domain-channels.md` says "Channel rows are immutable while an album for that channel is in_progress." Code only blocks PATCH when `albums.some((a) => a.status === 'in_progress')`. A channel with a `queued` album OR an `awaiting_captcha` paused album can still be edited. Editing `distrokidArtistName` mid-pause means resume-captcha will use the new value. Editing `tracksPerAlbum` mid-queued is even worse — see M3 for the cascade.
- Repro (code-trace): Album in awaiting_captcha. PATCH /api/channels/<id> changes distrokidArtistName. Operator hits resume-captcha. Step 06 retry uses the new name (which the original release was not associated with). DK shows different artist.
- Fix: Extend the lock to include `queued`, `in_progress`, `awaiting_captcha`. Anything where the album is "live" in the pipeline.

---

## Minor (Polish)

Quality-of-life, future-bitrot risk, untested-but-likely-works.

### m1. Schema version drift between user prompt + CLAUDE.md + spec
- File: `src/lib/db.ts:5` (`DB_VERSION = 5`), `docs/ambientforge-spec.md:1` (calls itself v3.1), audit prompt mentions "migrations v1-v6"
- Symptom: User's audit prompt says "v1-v6" but DB_VERSION=5. Spec changelog lists v3.1 (the SCHEMA was bumped to v5 in Session 10 per `docs/SESSION-10-RESULT.md`, but spec front-matter version is its own thing — labeled "v3.1 — Session 10 multi-workflow"). Confusing — the spec doc-version and the DB schema-version are different counters.
- Fix: Add a section to `docs/ambientforge-spec.md` that clearly states the DB schema version (v5) separate from the spec version. Or rename one.

### m2. Dormant template-name columns still in DB schema + repo type
- File: `src/lib/db.ts:15-19` (`album_brief_template`, etc.), `src/lib/repos/channels.ts:23-27`, `CLAUDE.md` Forbidden section: "Reading the dormant template-name columns…"
- Symptom: Five columns are kept "for back-compat" but never read by code. They're in the SCHEMA_SQL, in the Channel TypeScript type, mapped in `fromRow`, listed in `COLS`. Future readers may think they're load-bearing.
- Fix: Drop them in a v6 migration when convenient. Until then, comment the schema with `-- DEAD COLUMN; never read; drop in v6` at each site.

### m3. `DistroKid bridge` exposes `/upload-screenshot/<actionId>` with no auth, allowing localhost-process write to operator-controlled paths
- File: `extensions/distrokid-runner/bridge.ts:243-264`
- Symptom: The bridge's CORS allow-origin is `http://localhost:3003`, but CORS only restricts BROWSER requests. A direct HTTP call from any process on localhost (e.g., a malicious script in another browser tab via XHR — wait, that IS browser, blocked by CORS — but a non-browser process on the same machine bypasses CORS). The screenshot path is constrained to whatever was in `action.payload.screenshotPath`, which the worker computes as `path.join(albumDir, 'distrokid-dryrun.png')`. So the blast radius is "overwrite the dryrun screenshot of an in-flight DK action." Limited but real. Action IDs are predictable (`dk-{Date.now().toString(36)}-{counter}`) so an attacker could enumerate them.
- Fix: Require a shared secret token in the upload-screenshot route (set on bridge startup, passed to extension via popup config). Or check the connection's source ip is loopback `127.0.0.1`/`::1` — already true for localhost binding but worth asserting.

### m4. Suno bridge `/download/{taskId}` reads from sidecar-controlled path
- File: `extensions/suno-runner/bridge.ts:321`
- Symptom: `const buf = await fs.promises.readFile(data.path);` where `data.path` is whatever the sidecar returned. Trust boundary is "we trust our own sidecar." If `suno_bot.py` upstream were ever compromised (e.g., import from a tampered SUNO_BOT_PATH directory), the path could be arbitrary. Currently the sidecar at `sidecars/suno/sidecar.py:303` writes to `DOWNLOAD_DIR / f"{task_id}.wav"` with task_id = `f"af-suno-{counter:06d}"` — controlled and safe.
- Fix: Validate the returned path is under `DOWNLOAD_DIR` before reading. One-line addition.

### m5. `data/suno-profile/.env` cookie file has no permission hardening
- File: filesystem; `data/suno-profile/.env` confirmed to exist
- Symptom: Default Windows file ACLs allow any process running as the same user to read. The `__client` cookie / SUNO_COOKIE is a long-lived JWT (~30 days). If leaked, an attacker can hit `studio-api.prod.suno.com` as the operator. Risk: another local process (e.g., a malicious npm package, browser extension with filesystem access) could read it. `.gitignore` excludes `data/`, so git leaks are mitigated. **Already in `.gitignore`** — confirmed `data/` line 16.
- Fix: On Windows, no easy ACL hardening from Node. Document the risk in `docs/suno-sidecar-plan.md` and remind operators not to run untrusted local processes during dev.

### m6. `tracksPerAlbum` API allows up to 50; settings override caps at 30; LLM may not produce 50 reliably
- File: `src/app/api/channels/route.ts:47` (max(50)), `src/lib/settings.ts:45` (`tracks_per_album_override` capped at 30), step 02 length-validates exactly N.
- Symptom: Operator can set `channel.tracksPerAlbum=50` via channel CRUD. Step 02 then requires the LLM to return exactly 50 tracks. Suno credits, DistroKid 30-track limit historically applied (DK accepts up to 35 per release), and the spec says "30 Suno songs" as the design point. 50 is unreasonable.
- Fix: Cap at 35 (matches DistroKid's `#howManySongsOnThisAlbum` 1-35 options per `SESSION-4.8-HANDOFF.md:46`). Match `tracks_per_album_override` cap to channel cap (or lift override to 35 for parity).

### m7. `targetVideoSeconds` has no upper bound
- File: `src/app/api/channels/route.ts:48`, `src/app/api/channels/[id]/route.ts:49`
- Symptom: `z.number().int().min(60).nullable()` — no upper bound. Operator could set 86400 (24h). Step 08 would loop audio for 24h, step 09 would render a 24h MP4. Disk fill (M-class), ridiculous render time. Also `safeSize(loop_full.wav)` intermediate at step 08 doubles disk during render.
- Fix: Cap at e.g. 4 hours (14400s). YouTube tolerates up to 12h videos but ambient compilations beyond 2h add little value.

### m8. `validate-broll` in API surface duplicates the workflow's preflight, runs ffprobe synchronously per page-load
- File: `src/app/api/channels/validate-broll/route.ts:24` (and also see C5 above for the security angle)
- Symptom: Per `docs/SESSION-10-RESULT.md:149`: "the B-roll preflight on the channel detail page runs ffprobe on every clip in the folder, every page load. For 100+ clips this could be slow." Each ffprobe is `execFile` spawn, ~50-200ms per clip, sequential.
- Fix: Cache result on disk for N seconds keyed by folder mtime. Or expose two endpoints: a cheap `cheapBrollSummary` (just readdir) for page-load and the full preflight only on operator click.

### m9. Many step-files have `STEP_07_NO_TRACKS` / `STEP_07_RAP_NO_TRACKS` / etc. — error code drift
- File: `src/worker/steps/07-audio-concat.ts:42`, `src/worker/steps/07-rap-audio-concat.ts:55`, similar patterns elsewhere
- Symptom: Mostly-the-same error codes in ambient and rap variants get a `_RAP` suffix per step. Future analytics that group by error code will see two codes for what is conceptually the same condition. Spec § 8 (PLAN.md:251-360) doesn't enumerate these.
- Fix: Drop `_RAP` from variant codes (just `STEP_07_NO_TRACKS`). Or hoist common errors (`NO_TRACKS`, `TRACK_AUDIO_MISSING`) into `src/lib/api/errors.ts`.

### m10. `mux.ts` libx264 fallback uses default GOP (no explicit -g flag); YouTube prefers ≤2s GOP
- File: `src/lib/render/mux.ts:44` (libx264 args)
- Symptom: `libx264 -preset medium -crf 20` defaults to GOP ~250 frames (8.3s at 30fps). YouTube transcodes anyway, but a tighter GOP reduces re-encode time and better seek thumbnails on the YouTube player.
- Fix: Add `-g 60` (2s GOP at 30fps) to both NVENC and libx264 args.

### m11. Step 08 intermediate `loop_full.wav` doubles disk usage during render
- File: `src/lib/audio/loop.ts:55-89`
- Symptom: For a 7200s target with 6000s concat input, repeats=2, intermediate is 12000s WAV (~2GB at 48kHz/16bit/stereo). Then trimmed to 7200s (~1.4GB). Both files exist briefly. With `keep_raw_audio_after_done=false` (default) cleanup happens later. Worst case during step 08 = 3.4GB.
- Fix: Either pipe the trim directly into the concat (one-pass `-t target` after `-f concat`), or `unlink` `concat.wav` once `loop.wav` is written. Confirm bit-identicality is preserved on a one-pass approach.

### m12. `pipelineLog.ts` writes synchronously to `data/pipeline.log` on every line
- File: `src/worker/pipelineLog.ts:30-37`
- Symptom: `fs.appendFileSync` blocks the event loop for each log line. ~50-100 lines per album is fine. But with verbose modes (e.g., step 09 progress at 10% intervals), this still adds up. Also `console.log` synchronously writes to stdout.
- Fix: Switch to `fs.createWriteStream` with batched writes. Low priority — log volume is low.

### m13. `extractMockResponse` parses operator-controlled JSON without sandbox
- File: `src/lib/prompts.ts:153-157`
- Symptom: When `apiKey === 'mock'`, the channel prompt's `<!-- mock-response: {...} -->` HTML comment is JSON-parsed. JSON.parse can't execute code, but it CAN throw, hang on huge inputs, or return objects that confuse the Zod schema. Operator-edited prompts (channel.prompt_album_brief etc.) that have a malformed mock-response → crash.
- Fix: Wrap the JSON.parse in try/catch that returns `null` (treating as no-mock) instead of bubbling the SyntaxError. Operator who sets `apiKey=mock` should never see a crashy stack trace.

### m14. Channel handle regex permissive — allows `@..`
- File: `src/app/api/channels/route.ts:35`, `src/app/api/channels/[id]/route.ts:36`
- Symptom: `regex(/^@[\w.-]+$/)` allows `@..`, `@.`, `@-foo`. YouTube handle rules disallow leading dots/hyphens. Worse, when the (future) handle resolver uses this in a URL, `@..` could path-traverse if the resolver naively concatenates.
- Fix: Tighten to `/^@[\w][\w.-]{2,29}$/` (must start with alphanumeric/_, length 3-30, matches YouTube's actual rules).

### m15. `drawText` filter escaping doesn't handle every FFmpeg metacharacter
- File: `src/lib/audio/ffmpeg.ts:294-317`
- Symptom: Escapes `\\`, `:`, `'` (curly-substituted). But FFmpeg drawtext filter has more dangerous chars: `,` separates filter chains within an arg, `[` `]` denote stream labels. Inside `text='...'` they should be safe (single-quoted), but operator-supplied font path with a `'` would break the fontfile arg.
- Fix: Reject font paths containing `'` or whitelist allowed chars in font path. Already deferred — tests pass with the supplied font.

### m16. Worker recovery for `awaiting_captcha` is not handled by `recoverInProgress`
- File: `src/worker/runner.ts:42-47`
- Symptom: `recoverInProgress` resets only `in_progress` to `queued`. An album in `awaiting_captcha` stays in that state across worker restarts. Recovery from a true mid-captcha worker crash (vs. the deliberate pause) is operator-driven via the resume-captcha API. That's the intended behavior, but combined with a missing `distrokid_captcha_pending` clear means the dashboard banner is correct but the operator may not realize the worker actually crashed (vs. an honest captcha pause).
- Fix: Document the recovery semantics in `domain-pipeline.md`. Optionally surface "recovered N in_progress albums to queued at start" in the dashboard health endpoint.

### m17. Tests rely on `:memory:` SQLite databases — production schema migration v4→v5 on a populated DB has not been runtime-verified
- File: `src/lib/__tests__/db.test.ts` (uses in-memory)
- Symptom: `docs/SESSION-10-HANDOFF.md` § 12: "production data/ambientforge.db was NOT migrated by tests" — schema v4 → v5 has been verified on `:memory:` DBs only. The first dashboard request after the merge triggers migrations. The migration is idempotent (`addColumn` swallows duplicate-column errors), so risk is low. But the migration adds 17 columns + an index-touch via SCHEMA_SQL re-run; on a multi-MB DB, this is fast on SQLite but has not been runtime-verified end-to-end on the operator's actual `data/ambientforge.db`.
- Fix: Run `node scripts/db-version-check.ts` (or `sqlite3 data/ambientforge.db 'SELECT value FROM settings WHERE key="db_version"'`) in CI / startup as a first-tick health check. Surface a warning banner if `db_version < DB_VERSION`.

---

## Observations (No fix needed)

Architecture notes worth knowing, code-vs-doc drift that's harmless, future-bitrot.

### O1. Path-traversal protection in `/api/projects/[...path]` is correctly implemented
- File: `src/app/api/projects/[...path]/route.ts:26,35`
- Note: Rejects `..`, `.`, empty segments, NUL bytes; resolved path must be under `PROJECTS_ROOT` (with `path.sep` boundary check). Allowed extensions whitelist: `.png/.jpg/.jpeg`. Read-only. Solid.

### O2. `open-folder` API uses `spawn('explorer.exe', [albumDir])` — no shell, no injection
- File: `src/app/api/albums/[id]/open-folder/route.ts:34`
- Note: `spawn` with array args means no shell expansion. Album dir is constructed from `process.cwd()` + DB ULID + DB ULID, both validated. Safe.

### O3. better-sqlite3 default `busy_timeout=5000ms` covers worker+dashboard write contention
- Note: `db.ts:166` sets WAL + foreign_keys, doesn't set busy_timeout. better-sqlite3's built-in default is 5s. With single-writer pattern (worker writes step results, dashboard writes settings PATCHes), 5s is more than enough on this hardware. No findings.

### O4. Suno sidecar tightly couples to `suno_bot.py` private members (`_auth`, `_session`, `_jwt`)
- File: `sidecars/suno/sidecar.py:255,258,261`
- Note: `# type: ignore[attr-defined]` annotations acknowledge the coupling. If `suno_bot.py` ever changes private API, sidecar.py breaks at runtime with AttributeError. Acceptable trade-off given the alternative is duplicating 1400 lines of auth+download logic. Document in domain-suno.md.

### O5. The 5 critical paths all have at least one finding
- Album lifecycle → C1 (status overwrite) + M2 (silent partial step 03)
- Suno auth → C4 (silent poll 401 swallow)
- DistroKid form fill → C2 (live mode flip via API), m3 (screenshot upload auth)
- Parallel fork retry → C1 (root cause) + M1 (preflight skip on retry)
- Multi-channel strict serial → M7 (no scheduler) + O3 (busy_timeout)

### O6. Spec Section 3 still describes only the ambient pipeline
- File: `docs/ambientforge-spec.md:163-186`
- Note: The 11-step table is ambient-specific (steps 07-08-09 are static-image-loop assumptions). Rap-compilation's 07-rap → 09-rap (no 08) is described in `docs/SESSION-10-HANDOFF.md` and `.claude/rules/domain-workflows.md` but spec § 3 doesn't show a workflow-aware view. Doc-drift; harmless because the rules + handoff cover it.

### O7. `domain-suno.md` says retired extension content scripts "should be deleted once verified end-to-end"
- File: `.claude/rules/domain-suno.md` first paragraph
- Note: Sessions 4.6/4.7/4.8 verified the sidecar end-to-end. The legacy `extensions/suno-runner/{content,background,popup}.*` scripts are still on disk. Per the rule they should now be deleted. Low priority — they're orphaned but not harmful. Glob for those files confirms they exist (Session 10 handoff doesn't explicitly mention deleting them).

### O8. Test coverage is real but uneven
- 44 test files. Strong coverage on: schema/migrations, repos, prompt resolution, audio concat/loop/mux, broll select/preflight, step 01/02/03/04/05a/05b/06/07/08/09, pipeline orchestration, runner. Missing or weak:
  - **Suno UI selector drift detection** (proven absent — Session 4.6 needed manual probe).
  - **B-roll codec mismatch + concat behavior** (`preflight.test.ts:5 cases` covers detection, but no test confirms what step 09-rap does with mixed-codec inputs that pass preflight at e.g. 11 of 12 clips uniform).
  - **Content ID hold expiry math under DST/timezone changes** (none — `Date.now() + N * 86400000` is wall-clock-naive; any DST jump in 14d window is a 1h drift, harmless but worth noting).
  - **Cookie expiry mid-album simulation** (none — the C4 finding above demonstrates this gap).
  - **Worker crash recovery mid-step** (`runner.test.ts` has `recoverInProgress` test, but no kill-9-mid-step-N test).
  - **`mark-uploaded` API hold enforcement** (none — and the C3 finding is that there's no enforcement to test).
  - **Settings PATCH validation** (none — implicit only).
  - **Path-traversal in `/api/projects/[...path]`** (none — protection is correct per O1, but no test asserts it).
  - **Step 11 retry-B-only-with-failed-A scenario** (the C1 documented bug — no test catches it).
  - **LLM timeout scenario** (none — M4).
  - **Step 02 partial-track-deletion with non-null `sunoTaskId`** (none — M3).
  - **`/api/settings` distrokid_dry_run patch** (none — C2).
  Where each test should live: `runner.test.ts` for C1, `step-04.test.ts` for C4, `albums-api.test.ts` for C3, `settings-api.test.ts` (new file) for C2, `step-02.test.ts` for M3.

### O9. `domain-distrokid.md` "STUB / PARTIAL" markers
- File: `.claude/rules/domain-distrokid.md`
- Note: Per `SESSION-4.7-HANDOFF.md` PART 4, those markers were supposed to be dropped post-Session-4.7. Confirmed: rules file has no STUB/PARTIAL markers in current state. Cleanup applied as expected.

### O10. Schema `albums.workflow` and `channels.workflow` have NOT NULL DEFAULT 'ambient' — no nullability gap
- File: `src/lib/db.ts:33,85`
- Note: Both columns can never be NULL due to schema defaults; Zod-coerced reads via `repos/channels.ts:170-173` and `repos/albums.ts:142-145` fall back to 'ambient' if the value is somehow malformed. Cross-product `workflow='rap-compilation'` × `broll_folder_path=NULL` IS structurally possible at the schema level (broll_folder_path is nullable), but four prevention layers exist: POST channel API, PATCH channel API, workflow.preflightChecks, and step 09-rap defense-in-depth. Repo-level enforcement is missing but the four layers above cover it for legitimate API-driven flows.

### O11. The "v5/v6" wording in the audit prompt does not match the code
- Note: User's audit prompt said "every nullable column added across migrations v1-v6." Code is at v5 (`db.ts:5`). Likely a typo; relevant migrations are v1→v5 only. No action needed — Phase 3 covered v1-v5.

---

## Summary

- **Critical: 5 findings** (C1-C5). All have file:line evidence, all reproducible by code-trace; C1 is documented in 2 prior session handoffs as a known issue, others are newly surfaced.
- **Major: 8 findings** (M1-M8). Most are reliability/recovery edges — retry semantics, partial step failures, lock scopes, missing scheduler.
- **Minor: 17 findings** (m1-m17). Mostly polish, hardening, and one dev-quality issue (spec drift).
- **Observations: 11** (O1-O11). Architecture confirmations + test coverage map.

The single highest-leverage fix is **C1**: a one-line check in `runner.ts:100` prevents misreporting a half-failed album as `done`. C2 (gate live mode against direct API write) and C3 (enforce content-ID hold in API) are next — both are server-side enforcement of UX-only safeguards. C4 (Suno auth swallow) and C5 (broll path disclosure) are independent and should be tackled when the relevant components are next touched.

No code was changed. No tests were run. This is the result of static reading + cross-referencing docs + tracing the 5 critical paths described in the audit prompt.
