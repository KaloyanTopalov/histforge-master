# Cover-Pick Popup — Make It Actually Fire (Smoke-Driven)

## Overview

When step 05a's 4 medieval-path covers are ready, the operator should pick one in
the always-on-top PowerShell window (`pick-popup.ps1`) instead of clicking the
image in the Magnific browser tab. The relay is fully built but has **never once
fired** on a real run — every run so far fell back to the in-tab click and the
popup sat on "Waiting...". The goal: drive the offline **"AF smoke: test
cover-pick popup"** loop (zero Suno spend) until the popup reliably pops with the
4 images and the pick round-trips, fix whatever link breaks, then confirm on one
real launcher run and commit.

## RESOLUTION (2026-05-18) — root cause found & fixed

**Not Task 3 or Task 4. Root cause: a STALE service worker pinned by the
persistent profile.** MV3 + `launchPersistentContext(data/freepik-profile)`
re-injects `content.js` fresh (so the `2026-05-18a` marker was real) but Chrome
kept running an **old `background.js`** registered in the profile. Proof
(`scripts/debug-pick-probe3.ts` v4): live SW had `pollOnce`/`fetchAsBase64` but
`bridgeJson`/`fetchAsThumb`/`startPollLoop` were `undefined`, while the on-disk
`background.js` (13736 B) contained all of them. Hardened content.js sent
`freepik:pick-offer` → stale SW's handler called the undefined `bridgeJson` →
threw → `lastError: "The message port closed before a response was received."`
→ content saw `undefined` → popup never got the offer → "stuck on Waiting".
This explains BOTH prior production runs and why v2's keepalive never helped
(its `self.startPollLoop` was also a no-op against the stale SW).

**Fix (proven):** one `chrome.runtime.reload()` on launch re-registers the SW
from disk. After it, the SW typeof map was all `function`, and the full real
smoke path worked: `thumb[0..3] ok 420x235 ~25KB` → `offer assembled 4 ~134KB`
→ `pick-offer accepted attempt 1` → offer reached the bridge → `/pick-choice`
200 → `smoke RESULT: popup returned index 0`. Operator independently saw the
popup pop. Ported into `scripts/freepik-login.ts` (the launcher the `.bat`
runs); real `npm run freepik:login` logged `extension reloaded from disk — SW
refreshed (hardened)`.

So Tasks 3–7's conditional fixes are **moot** — the hardened relay was always
correct; only the SW was stale. Remaining: (a) one free human click of the
purple smoke button in the now-fixed launcher to see the popup *stay* and be
clickable by hand; (b) commit `scripts/freepik-login.ts` (+ this plan + memory).

## Current State

The chain (each link is a suspect):

1. `content.js:waitForOperatorPick` (`extensions/freepik-runner/content.js:551`)
   collects ≥4 new result image URLs via `collectResultImageUrls`
   (`content.js:526`, selector `img[src*="cdnpk.net"|"freepik"|"magnific"]`,
   ≥200px).
2. `assembleOfferImages` (`content.js:664`) asks the SW for a downscaled JPEG
   thumbnail per candidate: `freepik:pick-thumb` → `background.js:fetchAsThumb`
   (`background.js:252`, fetch CDN → `createImageBitmap` → `OffscreenCanvas` →
   JPEG q0.7, ~420px).
3. `postPickOfferWithRetry` (`content.js:693`, 3× / 800ms) → SW
   `freepik:pick-offer` (`background.js:152`) → bridge `POST /pick-offer`
   (`bridge.ts:198`) populates `pickOffer`.
4. `pick-popup.ps1` polls `GET /pick-state` every 2s (`pick-popup.ps1:123`,
   bridge `bridge.ts:216`), renders base64 thumbs, POSTs `/pick-choice`
   (`pick-popup.ps1:105`, bridge `bridge.ts:230`).
5. content.js polls the choice back: `freepik:pick-poll` → bridge
   `GET /pick-choice` (`bridge.ts:248`) → resolves `candidates[index]`
   (`content.js:638-647`).

Established facts (research + operator):

- **Last full `.bat` run: popup launched but stuck on "Waiting..."** → links 1–3
  never populated `pickOffer`; links 4–5 (popup poll, bridge contract) are fine.
- **That run used committed build `23800fa`, NOT the hardening.** The
  `2026-05-18a` build (SW-side thumbnails, `postPickOfferWithRetry`,
  `[freepik-runner][pick]` diagnostics, the purple smoke button) is
  **UNCOMMITTED**. Until `freepik-login.ts` is relaunched with the patched
  `content.js`, the operator is running pre-hardening code with a silent
  `catch` and the old 20–40MB full-4K offer that is the prime suspect for the
  production failure.
- **The offline smoke button has never been clicked** — zero signal from the
  hardened path yet.
- **Bridge half LIVE-PROVEN 2026-05-18.** A running `bridge.ts` was exercised
  with a 17-point HTTP contract: `/pick-offer`→offerId, `/pick-state` returns
  offerId + thumb data-URLs **verbatim** (the exact payload `pick-popup.ps1`
  renders), `/pick-choice` POST+GET round-trips the index, `/pick-clear` empties
  both, and `NO_IMAGES`(400)/`STALE_OFFER`(409)/`BAD_INDEX`(400) all correct. So
  the failure is provably **upstream of the bridge** — in the
  content.js→SW→`/pick-offer` leg under live Chrome. **Tasks 5 & 6 are RULED
  OUT** (bridge-state and pick-readback are server-side correct). When the
  operator's capture lands, the fix is **Task 3 (SW thumbnail) or Task 4
  (SW→bridge relay)**. The bridge is already running in the background — do NOT
  start a second one (port 7344 clash).
- Bridge relay is internally consistent and curl-verified (the
  `/pick-offer→/pick-state→/pick-choice` contract works); the **unproven** part
  is the SW thumbnail generation and SW↔bridge messaging under a live
  Playwright-launched Chrome (not curl).
- The launcher already starts every piece: bridge (`make-medieval-video.bat:53`),
  freepik Chrome (`:57`), popup (`:60`), startup `/pick-clear`
  (`make-medieval-video.ts:58`).

Iteration mechanics (no Suno bill) are documented in the memory note
`reference-freepik-step08-validation` and `project-ambient-video-magnific`.

## Scope

**Doing**: prove + fix the offline cover-pick smoke relay end-to-end; one gated
real-run confirmation of the live `waitForOperatorPick` path; commit the
hardening.

**Not doing**: redesigning the relay; touching the in-tab click fallback
(`content.js:617-632` — it works, it is the safety net, leave it untouched); the
step-08 `TIMEOUT_WAITING_FOR_VIDEO_RESULT` video gap (separate, tracked
elsewhere); removing the smoke tooling (decide after it's proven).

## Tasks

### Phase 1: Load the hardened build and capture the baseline

- [x] **Task 1: Confirm `2026-05-18a` is the live build** — DONE via
  `scripts/debug-pick-driver.ts` (marker confirmed; content.js was never the
  problem — the SW was).
  **Files**: `extensions/freepik-runner/content.js:26`
  **What**: Operator closes the `npm run freepik:login` Chrome, relaunches it
  (`scripts/freepik-login.ts`) so the patched `content.js` loads, opens the
  Magnific `/app/ai-image-generator` tab's DevTools console, and confirms the
  line `[freepik-runner] content.js build 2026-05-18a` is printed. Also confirm
  the purple **"AF smoke: test cover-pick popup"** button is visible
  (bottom-left, `left:340px`, `content.js:721`).
  **Context**: Content-script logs appear in the *page* console, not the SW
  console. If the marker is absent the operator is on stale code and every later
  observation is meaningless — block here until it shows. `freepik-login.ts`
  force-drives the SW every 7s; ignore the cosmetic popup-badge state.

- [x] **Task 2: Capture the offline smoke baseline with REAL on-page images** —
  DONE via the driver (4 real cdn images; isolated the stale-SW root cause).

  **Files**: `extensions/freepik-runner/content.js:748-816`,
  `scripts/pick-popup.ps1`, `extensions/freepik-runner/bridge.ts`
  **What**: With the freepik bridge (`npm run freepik:bridge`) and
  `pick-popup.ps1` both running, ensure **4 real generated images are on the
  Magnific page** (do one manual Seedream generation in the tab, or open a page
  that already has 4 results) — then click the purple smoke button. Capture: (a)
  every `[freepik-runner][pick]` line from the page console, (b) the freepik
  bridge stdout, (c) what the popup window does, (d) the final button label/color.
  **Context**: This is the single decisive diagnostic — it names the broken
  link. **Critical caveat**: on a blank page the smoke synthesizes 4 solid-color
  tiles via `makeSolidTileDataUrl` (`content.js:823`, same-origin page canvas)
  which **bypasses the real SW `freepik:pick-thumb` path** — the exact path that
  failed in production. A green smoke on a blank page only proves bridge+popup,
  NOT thumbnails. Must run with real `cdnpk.net` images present. Expected log
  spine: `render`/`smoke: N on-page image(s)` → `thumb[i] ok …KB` ×4 → `offer
  assembled …KB total` → `pick-offer accepted on attempt N` → (operator picks) →
  `smoke RESULT: popup returned index …`.

### Phase 2: Fix the broken link (pick the task matching Phase 1's signature)

- [ ] **Task 3: Thumbnail stage fails — `thumb[i] FAILED` / `DECODE_FAILED` / `HTTP nnn`**
  **Files**: `extensions/freepik-runner/background.js:252` (`fetchAsThumb`),
  `background.js:145` (`freepik:pick-thumb` handler)
  **What**: If the `[pick]` log shows thumbs failing (HTTP error fetching the
  CDN URL inside the SW, `createImageBitmap` `DECODE_FAILED`, `NO_2D_CONTEXT`,
  or all 4 are placeholders), make the SW thumbnail path succeed for real
  `cdnpk.net` result URLs.
  **Context**: SW *does* get host_permissions CORS bypass (unlike content
  scripts) so the fetch should work — if it 401/403s the result `<img>.src` may
  be a blob:/transformed URL not the raw CDN file; reconsider what
  `collectResultImageUrls` (`content.js:526`) hands to the thumb path. Empty
  thumbs are tolerated by the bridge (index stays aligned, popup shows
  placeholders, still pickable) — only treat this as the break if it blocks the
  offer or makes the popup useless.

- [ ] **Task 4: Offer never reaches the bridge — `pick-offer FAILED after all retries` / `/pick-offer relay failed`**
  **Files**: `extensions/freepik-runner/background.js:152` & `:206`
  (`bridgeJson`), `background.js:1` (BRIDGE_URL const), `bridge.ts:198`
  **What**: If thumbs assemble but `postPickOfferWithRetry` exhausts retries (SW
  → bridge POST never returns an `offerId`), make the SW→bridge relay land.
  **Context**: Check `BRIDGE_URL` in `background.js` is `http://localhost:7344`,
  the bridge is actually listening, and the SW isn't dying between the
  `sendMessage` and the `fetch` (MV3 recycle mid-relay — the 3× retry should
  cover a single recycle but verify the heartbeat at `content.js:35` is keeping
  it warm). Bridge `/pick-offer` rejects only on empty `images`
  (`bridge.ts:203` `NO_IMAGES`) — 4 (even empty-string) thumbs pass.

- [ ] **Task 5: Bridge has the offer but popup stays "Waiting..." — `pick-offer accepted` logged, `/pick-state` still `{}`**
  **RULED OUT (bridge live-verified 2026-05-18):** the 17-point contract proved
  `/pick-state` returns the offer + thumb data-URLs verbatim and the `data:`
  prefix round-trips. This branch is logically impossible — skip it. (A *second*
  bridge on a stale port remains the only residual risk; the running background
  bridge makes that the operator's "don't start another" note, not a code fix.)
  **Files**: `extensions/freepik-runner/bridge.ts:198-227`,
  `scripts/pick-popup.ps1:123-146`
  **What**: If the log confirms the offer was accepted but the popup never
  renders, reconcile the bridge state / popup poll. Curl `GET
  http://localhost:7344/pick-state` immediately after the accept to see if
  `pickOffer` is actually held.
  **Context**: `PICK_OFFER_TTL_MS` is 15min (`bridge.ts:89`) — not a factor in a
  fast smoke. Suspect: a second bridge process on a stale port, the launcher's
  startup `/pick-clear` racing the offer (`make-medieval-video.ts:58` — N/A in
  the offline smoke since the worker isn't running, but verify no other
  `/pick-clear` fires), or the popup's `Invoke-RestMethod` swallowing a non-200.
  The popup parses `data:image/jpeg;base64,…` via `New-BitmapFromData`
  (`pick-popup.ps1:44`) — confirm the bridge stores/returns the `data:` prefix
  the thumb path emits (`background.js:280`).

- [ ] **Task 6: Pick made but content.js never resolves — popup says "generating…", smoke button never goes green**
  **RULED OUT (bridge live-verified 2026-05-18):** GET `/pick-choice` provably
  returns `{index}` while the offer is live and `{}` after clear. The
  server-side read-back is correct — skip unless the operator capture shows the
  popup POSTing a choice that GET `/pick-choice` then fails to surface (it
  didn't in the contract test).
  **Files**: `scripts/pick-popup.ps1:105-121`,
  `extensions/freepik-runner/background.js:161` (`freepik:pick-poll`),
  `bridge.ts:230` & `:248`, `content.js:638-647`
  **What**: If the operator picks (popup flips to "Picked #N - generating…") but
  content.js never logs `resolved via popup #N` / `smoke RESULT`, fix the
  choice read-back.
  **Context**: Popup POSTs `{ offerId, index }` to `/pick-choice`
  (`pick-popup.ps1:110`); content polls SW `freepik:pick-poll` → bridge `GET
  /pick-choice` which only returns `{ index }` while `pickChoice.offerId ===
  pickOffer.offerId` (`bridge.ts:252`). A `/pick-clear` between the POST and the
  poll (or an offerId mismatch) yields `{}` forever. Verify the smoke's own
  `finally` clear (`content.js:808`) isn't firing before the poll loop reads it.

### Phase 3: Re-smoke until green

- [ ] **Task 7: Iterate the offline smoke to a clean pass**
  **Files**: `extensions/freepik-runner/content.js:26` (build marker)
  **What**: After each fix, bump the build marker (e.g. `2026-05-18b`,
  `2026-05-18c`…), relaunch `freepik-login.ts`, reconfirm the marker, re-click
  the smoke button **with 4 real images present**, repeat until: popup pops to
  front with a sound showing 4 real thumbnails, a click resolves, console logs
  `smoke RESULT: popup returned index N`, button turns green
  `popup OK ✓ picked #N`. Run it 2–3 times consecutively to rule out a flaky
  SW-recycle race.
  **Context**: Build-marker bump + close/relaunch Chrome is the deterministic
  reload (chrome://extensions Reload also works but is less reliable under
  Playwright). Zero Suno, zero generation, zero pipeline — pure relay.

### Phase 4: Confirm the live path on one real run (gated, operator-initiated)

- [ ] **Task 8: One real `.bat` run to exercise `waitForOperatorPick` Phase 1**
  **Files**: `make-medieval-video.bat`, `extensions/freepik-runner/content.js:551-582`
  **What**: ONLY after Phase 3 is green: the operator runs `make-medieval-video.bat`
  (real Suno bill — their decision, their trigger). Confirm the popup fires from
  the real step-05a path (the in-tab `clickHandler` is registered only *after*
  `offerSent`, so a watched popup should always win), the operator picks in the
  window, and the run proceeds to step 08 without anyone touching the Magnific
  tab.
  **Context**: This is the only link the offline smoke can't cover — Phase 1 of
  `waitForOperatorPick` (waiting for 4 *freshly generated* results, then the
  serial thumb assembly racing nothing because the operator watches the popup).
  Per the stop-and-gate memory, do NOT initiate this run during dev — it is the
  operator's explicit, deliberate action. If it regresses, fall back to the
  in-tab click (still wired) and return to Phase 2 with the new `[pick]` log.

### Phase 5: Commit

- [ ] **Task 9: Commit the proven hardening + record the outcome**
  **Files**: `extensions/freepik-runner/content.js`,
  `extensions/freepik-runner/background.js`,
  `extensions/freepik-runner/bridge.ts`, `scripts/pick-popup.ps1`,
  `scripts/make-medieval-video.ts`, `make-medieval-video.bat`
  **What**: Commit only the cover-pick relay files (mirror the surgical-commit
  discipline used for `9afe2dd`/`4060b53` — leave unrelated repo churn out).
  Decide whether to keep the smoke button (recommended: keep until a *second*
  clean real run) or strip it; note the decision in the commit body. Update the
  `project-ambient-video-magnific` memory: popup PROVEN (offline + real),
  superseding the "code-complete, never confirmed" status.
  **Context**: tsc has 3 known pre-existing unrelated errors
  (dk-probe/manual-rap) — green means "no *new* errors in changed files", not
  zero. Commit message style: `feat(freepik-runner): …` per recent log.

## References

- `extensions/freepik-runner/content.js:551` — `waitForOperatorPick` (dual-path resolve)
- `extensions/freepik-runner/content.js:721` — offline smoke button
- `extensions/freepik-runner/background.js:252` — `fetchAsThumb` (SW OffscreenCanvas)
- `extensions/freepik-runner/bridge.ts:195-266` — pick relay endpoints
- `scripts/pick-popup.ps1` — always-on-top WinForms picker
- `make-medieval-video.bat:53-65` — launcher wiring
- memory `reference-freepik-step08-validation` — offline iteration runbook
- memory `project-ambient-video-magnific` — full history (popup never fired)
