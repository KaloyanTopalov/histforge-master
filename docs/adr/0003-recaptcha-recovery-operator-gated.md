---
status: accepted
date: 2026-05-14
---

# Operator-gated reCAPTCHA recovery for Google Flow accounts

## Context

Google Flow generations occasionally hit `HTTP 403: reCAPTCHA evaluation failed` against `aisandbox-pa.googleapis.com`. The failure rate is low at current volume (once in days at ~5 short videos/day) but is expected to grow with throughput. HistForge uses an extension-based dumb-runner architecture; reCAPTCHA v3 Enterprise tokens are minted by Google's official `grecaptcha.enterprise.execute` in the live `labs.google` tab (site key `6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV`, action `IMAGE_GENERATION`), then submitted with each generation request from the user's Chrome session. Today, RECAPTCHA failures classify as `"quota"` in [`src/lib/flow-error-classify.ts`](../../src/lib/flow-error-classify.ts) and route to `handleQuota` — a time-based account pause that auto-resumes after `google_flow_account_cooldown_hours`.

Pre-research: [`docs/research/2026-05-14-google-flow-captcha-integration.md`](../research/2026-05-14-google-flow-captcha-integration.md). Empirical spike result captured below.

## Decision

Treat reCAPTCHA failures as **operator-gated recovery state** per-account, not as a time-based pause. Specifically:

1. **Split RECAPTCHA out of the quota bucket.** `classifyError` adds a new `"captcha"` class (checked before the quota regex so `/RECAPTCHA/` does not fall through). A new `handleCaptcha` in [`src/app/api/flow/submit-result/[token]/route.ts`](../../src/app/api/flow/submit-result/[token]/route.ts) is registered in `LEGACY_HANDLERS["captcha"]` AND wired via a captcha override at the top of `handleError` that consults the legacy classifier before the v2 `errorCategory` dispatch. The override is necessary because the YouForge Flow service worker's `_categorize` in [`extensions/youforge-flow/src/flow-error.js`](../../extensions/youforge-flow/src/flow-error.js) maps the HTTP 403 + JSON envelope that `aisandbox-pa` returns for RECAPTCHA to `category: 'auth'`, so submissions arrive at submit-result with `errorCategory: 'auth'` and the v2 path's `CATEGORY_HANDLERS['auth']` = `handleAuth` would intercept them before the legacy classifier ran — leaving `LEGACY_HANDLERS["captcha"]` as dead code on its own. The legacy classifier retains the signal (Google's envelope embeds the literal "reCAPTCHA evaluation failed" message body), so the override greps `errorText` via `classifyError` and routes to `handleCaptcha`. The `CATEGORY_HANDLERS["captcha"]` registration is deferred until/unless the extension is updated to emit the new category directly — at that point the registration becomes the primary path and the override becomes a synthetic-call-site fallback.

2. **Two new columns on `google_flow_accounts`.** `recovery_reason TEXT NULL` (`null | 'captcha' | <future reasons>`) gates dispatch; `recovery_required_at INTEGER NULL` is the timestamp the flag was set. Added via the inline boot-time migration pattern at [`src/lib/db.ts:437-480`](../../src/lib/db.ts). `paused_until` stays orthogonal — it remains time-based-only.

3. **Indefinite pause until operator action.** `handleCaptcha` sets both new columns and requeues the failed task (so another account in the pool can pick it up). It does *not* set `paused_until`. Dispatch logic checks `recovery_reason IS NOT NULL` in addition to the existing `paused_until > now` and `!enabled` gates.

4. **A new dispatchable account status: `recovery_needed`.** Added to [`src/lib/flow-account-status.ts`](../../src/lib/flow-account-status.ts) `getAccountStatus()` check order (first match wins): `!enabled` → `stopped(disabled)`; else `recovery_reason !== null` → `recovery_needed`; else `paused_until > now` → `paused`; else `last_seen_at` stale → `stopped(polling stopped)`; else `online`. Label: `reCAPTCHA recovery needed (47m)` using the existing `relative()` helper.

5. **Severity-ramped visual scheme** across both account-state surfaces (the video-detail strip in `flow-accounts-strip.tsx` and the settings accounts table in `google-flow-accounts-table.tsx`). The current binary green-dot / hollow-dot is replaced by green=online, amber=paused, red+alert-icon=recovery_needed, grey=stopped/disabled — with status text colored to match the dot for non-online states. Both surfaces share `getAccountStatus()` output and stay in sync automatically.

6. **Dedicated banner on `/videos` and `/videos/[id]`.** Title `reCAPTCHA recovery required`; lists affected accounts with per-account `Open labs.google` link and `Mark recovered` button. Operator-facing copy is precise and technical (no friendliness or emojis); recovery instructions tell the operator to interact with `labs.google/fx/tools/flow` for ~30 seconds in the account's Chrome profile.

7. **Dedicated clear-recovery route.** `POST /api/flow/accounts/[id]/clear-captcha-recovery` matches the existing `clear-relogin-needed` / `clear-create-project-failed` precedent. Clears both new columns. No probe task. If the operator clicked prematurely, the next dispatched task fails and `handleCaptcha` re-fires — the system is self-correcting at zero code cost.

## Considered options (rejected)

**Path A — migrate generations to useapi.net.** Their API solves reCAPTCHA on their backend because they control the full request flow (mint + submit in the same session). Rejected: adds a recurring SaaS dependency and per-call cost, reshapes the documented dumb-runner contract (most of `src/app/api/flow/`, the `google_flow_accounts` semantics, the `domain-google-flow-coordinator` and `domain-youforge-flow` skills), and exposes us to their downtime. Disproportionate to current failure rate. Can reconsider if observed RECAPTCHA rate climbs above ~5% sustained even with multi-account pool rotation.

**Path C — pre-solve reCAPTCHA server-side, inject into extension's submission.** Empirically tested 2026-05-14 with 2captcha legacy `in.php` API. Same Google account where baseline live-tab generations succeed, same site key, same action, same Chrome session — only the token source changed. Both attempts (min_score 0.7, then min_score 0.9) returned `HTTP 403: reCAPTCHA evaluation failed`. The token's issuance session (solver-farm browser, solver IP/fingerprint) differs from the submission session (user's Chrome), and Google's anti-abuse stack appears to score this mismatch against `aisandbox-pa.googleapis.com` requests. useapi.net works around this because they own both sides; Path C does not.

**Auto-recovery via time-based cooldown specific to captcha.** Rejected: reCAPTCHA score recovery is not time-driven — it is session-engagement-driven. A timer ending does not re-engage Google's trust scoring; only operator interaction with `labs.google` does. A timed approach would silently consume retry budgets across each cooldown without ever recovering.

**Probe-on-recovery (synthetic test task dispatched on `Mark recovered`).** Rejected as scope creep. The natural pipeline already validates: if recovery was not successful, the next real task fails and `handleCaptcha` re-fires. A probe would cost a real Google generation per click for no architectural gain.

**Tiered detection (first failure → short auto-cooldown, second → operator-gated).** Rejected: filtering one-off flakes is the wrong objective when flakes that auto-resolve in 30 min without operator action are rare for this failure class. The 30-min auto-retry would just hit the same 403 and end up operator-gated 30 min later.

## Consequences

- **Banner placement** is on `/videos` and `/videos/[id]`, not `/settings/google-flow` — the row badge there is already prominent enough; a banner would be redundant.
- **Operator workflow becomes documented:** open `labs.google/fx/tools/flow` in the account's Chrome profile → interact for ~30 seconds → click `Mark recovered`. This is the canonical recovery loop and the banner copy spells it out.
- **Account pool sizing matters more.** Single-account operators see a full throughput stall while the operator is away. Multi-account operators see degraded but non-zero throughput because rotation absorbs single-account stalls. Operational guidance: at higher generation volume, run ≥2 Google Flow accounts.
- **Existing `google_flow_relogin_needed` (global setting) is unchanged.** The new `recovery_reason` column is structurally capable of absorbing it later (`recovery_reason = 'relogin'`), but migrating the existing relogin pattern is explicitly out of scope here — it works today and coupling two unrelated refactors would be churn.
- **Schema and test rewrites** are minor — two columns, one new error class + handler, one new route, one new banner component, modest changes to `getAccountStatus()` and `FlowAccountsStrip`. The existing `handleQuota` and `flow-error-classify.ts` tests need updates to reflect the RECAPTCHA → captcha split.
- **Out of scope:** extension-side heartbeat that auto-tests reCAPTCHA capability; bulk "Mark all recovered" action; refactor of `google_flow_relogin_needed` into per-account state.
