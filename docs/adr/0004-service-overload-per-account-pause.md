---
status: accepted
date: 2026-05-14
---

# Per-account pause for Veo `PUBLIC_ERROR_HIGH_TRAFFIC`, with a fleet-level banner

## Context

A Google Flow generation surfaced `PUBLIC_ERROR_HIGH_TRAFFIC` — Veo signalling backend congestion. The empirical observation was narrow: one account, brief duration, a manual retry minutes later succeeded. Today the error misroutes: [`classifyError`](../../src/lib/flow-error-classify.ts) hits the `PUBLIC_ERROR_` catch-all on line 116 and returns `content_policy`, which routes to `handleContentPolicy` → `failTask`. So a transient Veo congestion event permanently fails the task AND invites the moderator to rewrite a perfectly fine prompt. The bug fix is non-negotiable; the structural question is what to put in its place.

## Decision

Treat `PUBLIC_ERROR_HIGH_TRAFFIC` as a **new error class with a per-account pause mechanism that mirrors quota structurally, but with its own cooldown duration**. Surface a **fleet-level banner backed by a global setting**, even though the dispatch-gating mechanism is per-account. Specifically:

1. **New `service_overload` ErrorClass + classifier branch.** [`src/lib/flow-error-classify.ts`](../../src/lib/flow-error-classify.ts): widen the `ErrorClass` union, add a `/HIGH_TRAFFIC/` branch in `classifyError` placed AFTER captcha and quota (preserving the load-bearing ordering documented at lines 102-111) and BEFORE the `PUBLIC_ERROR_` content-policy catch-all (which is the current bug site). The new branch uses bare-substring matching to mirror the existing quota branch's style; the server operates on free-form `errorText` where regex is the right precision tool.

2. **Extension `_categorize` mirror, exact match.** [`extensions/youforge-flow/src/flow-error.js`](../../extensions/youforge-flow/src/flow-error.js): new branch `reason === 'PUBLIC_ERROR_HIGH_TRAFFIC' → 'service_overload'`, slotted between the existing quota check and `invalid_argument`. Exact-string match, not substring, because `_categorize` operates on the structured `error.details[].reason` enum value — every existing branch in this function uses `===`. The asymmetry with the server (substring vs exact) is deliberate and reflects what each side sees.

3. **`handleServiceOverload` is structurally `handleQuota` with its own cooldown setting.** [`src/app/api/flow/submit-result/[token]/route.ts`](../../src/app/api/flow/submit-result/[token]/route.ts): new handler that, in a single transaction, (a) pauses the account for `getSetting('google_flow_service_overload_cooldown_minutes') * 60` seconds, (b) requeues the task without bumping `retry_count`, (c) writes the `flow_service_overload_until` setting (banner backing). Registered in both `CATEGORY_HANDLERS["service_overload"]` and `LEGACY_HANDLERS["service_overload"]`. The write shape is intentionally a near-duplicate of `handleQuota` — they share the `paused_until + requeue + no retry bump` template — but the duration setting is distinct.

4. **New setting `google_flow_service_overload_cooldown_minutes`, default 15, range 1–60.** [`src/lib/db.ts`](../../src/lib/db.ts) + [`src/lib/settings.ts`](../../src/lib/settings.ts): `z.coerce.number().int().min(1).max(60)`. Default 15 matches the empirical "brief self-recovered" shape. The 60-min ceiling is deliberate — anything beyond an hour stops being "wait out the congestion" and starts being `handleQuota` territory (4h default). Operators who want >60 min are conflating two different errors; the schema pushes back.

5. **New setting `flow_service_overload_until`, defensive-parse only.** Empty-string default, `z.string()` schema. `handleServiceOverload` always-overwrites with `now + cooldown_minutes * 60`. Nothing ever proactively clears it: the banner parses defensively and renders only when `parsed > now`. Stale settings sit in the DB harmlessly — this is UI-only state, never consumed as a gate.

6. **`FlowServiceOverloadBanner` mounted on `/videos` and `/videos/[id]`.** New component patterned on [`FlowFailureBanner`](../../src/app/videos/flow-failure-banner.tsx) — defensive `parseInt`, returns `null` when empty/NaN/past, amber palette (transient, self-clearing), no Dismiss button. Banner copy is informational: "Veo is reporting high backend traffic. Affected accounts will resume automatically." Wired through `BannerFlags.flowServiceOverloadUntil` in [`src/lib/videos-page-state.ts`](../../src/lib/videos-page-state.ts).

7. **No new dispatch gate in `next-task`.** The existing per-account `paused_until > now` gate (line 124) does the work. Service_overload-paused accounts return the same `Retry-After`-bearing empty response as quota-paused accounts.

## Considered options (rejected)

**A — Reclassify as `transient`, route to `handleTransient`.** ~5 lines, fixes the immediate bug. Rejected because `handleTransient` bumps `retry_count`; a sustained congestion event burns the default 3-retry budget quickly and ends in `failTask` anyway. The empirical "brief self-recovered" shape doesn't show this, but the design has to handle the sustained case too.

**B — New ErrorClass, no pause, just requeue without retry bump.** ~15 lines. Rejected because it relies entirely on the extension's polling cadence as backoff; the row sits as `pending` and gets re-claimed in seconds. In a real congestion event, we slam Veo with the same task across all accounts in rapid succession. Aggressive in exactly the wrong direction.

**C.1 — Route to `handleQuota` directly (pure reuse).** ~5 lines. Rejected because the quota cooldown defaults to 4 hours — sized for Google's rate-window refresh — and the empirical service_overload event clears in minutes. Forcing a 4h pause for a minutes-long event wastes one account's capacity disproportionately (with a 2–3 account fleet, that's 33–50% throughput loss for an event that would have self-resolved). The write shape is identical but the *duration measurement* is incommensurate.

**D — Fleet-wide global pause with new dispatch gate.** ~80 lines. Rejected because the empirical evidence is "one account, brief, self-recovered" — the fleet-wide assertion isn't earned. Adding a fourth pause kind (after time-based-per-account, operator-gated-per-account, operator-set-global `queue_state`) is a structural commitment we shouldn't make on intuition alone. Per-account pause + fleet-level banner gives us 80% of D's operator visibility at ~30% of the surface area. Escalation path is open: if HIGH_TRAFFIC starts landing on multiple accounts in the same window, the gate can be added.

**B.2 — Per-account `pause_reason` column on `google_flow_accounts`.** Would let the banner list affected accounts with per-account countdowns (like `FlowRecoveryBanner`). Rejected because the banner is purely informational — no operator action is possible — so per-account detail is redundant with the existing account-status badges. The global setting is the simpler model: "Veo is congested right now" is a fleet-level observation, the per-account pause is the local consequence.

## Consequences

- **Vocabulary gains "Service overload pause"** in [`CONTEXT.md`](../../CONTEXT.md). Documented as a distinct named state under the broader Time-based pause family (parallel to how "reCAPTCHA recovery" sits under Operator-gated pause). The CONTEXT.md "Avoid: 'cooldown' is overloaded" note is updated to call out that there are now two cooldown settings measuring two different things.
- **Settings UI gets one new row** (`google_flow_service_overload_cooldown_minutes`) under the existing Google Flow advanced knobs. Defaults are safe; most operators never touch it.
- **Banner stack on `/videos`** grows to three: `FlowFailureBanner` (create-project failed), `FlowRecoveryBanner` (reCAPTCHA recovery), `FlowServiceOverloadBanner` (Veo congestion). Visual weight stays acceptable because they're rare-event banners.
- **Wire vocabulary gains a category.** The extension's v2 envelope now emits `errorCategory: 'service_overload'` for `PUBLIC_ERROR_HIGH_TRAFFIC`; HistForge's `CATEGORY_HANDLERS` registers it. This is a coordinated change — the extension must be updated alongside the server, otherwise HISTforge falls back to the legacy classifier (which after this ADR also routes to `handleServiceOverload`, so the legacy path still works). The two-side update is required only for the v2 envelope path to be clean; the legacy path covers any old extension build until it's re-rolled.
- **`isContentPolicyError` keeps returning false for HIGH_TRAFFIC.** A test pins this. The moderator should never be invited to rewrite a backend-congestion failure — the prompt is fine, the backend isn't.
- **Out of scope:** operator dismiss button, telemetry/audit log of service_overload events, per-account banner detail. Each is a clear extension if observed need arises; none is load-bearing for the core bug fix.
- **Escalation path is open.** If the empirical signal shifts (multiple accounts simultaneously hitting HIGH_TRAFFIC), the fleet-wide gate from option D becomes the right addition — the setting `flow_service_overload_until` already exists and can be promoted from banner-driver to dispatch-gate-driver with a small follow-on change.
