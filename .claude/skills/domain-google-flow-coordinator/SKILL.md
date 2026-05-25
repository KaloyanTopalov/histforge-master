---
name: domain-google-flow-coordinator
description: Guide for HistForge's server-side Google Flow coordinator — the dumb-runner contract, account fleet, queue, webhook routes, reaper, per-(video, account) project mapping, content-policy moderator, lifecycle module, and the Google Flow image/video providers consumed by the workflow registry. Use when modifying any of the Flow webhook routes, the Flow coordination libraries, the Google Flow repo helpers, the FlowLifecycle module, the Google Flow settings UI, or the Google Flow image/video provider modules. Pair with `domain-youforge-flow` (the extension side of the same contract).
---

# Google Flow Coordinator (Server Side)

## Anchors

Contract names for this domain. Resolve against the current codebase.

- **Auth + reaper + wait**: `resolveFlowAccount`, `runReaperTick`, `startReaper`, `waitForFlowQueue`, `DeferSignal`
- **Lifecycle (multi-write txns)**: `flowLifecycle`, `claimNextTask`, `handleStaleProjectId`, `handleQuota`, `handleCaptcha`, `handleCreateProjectFailed`, `handleServiceOverload`, `handleTransient`, `editAccount`, `requeueAllOnAccountDeletion`, `recordModerationBatch`, `requeueFailedTask`
- **Predicates + presentation**: `accountIsDispatchable`, `accountIsPaused`, `accountNeedsRecovery`, `getAccountStatus`, `buildFlowSummary`, `FlowBannerKeys`
- **Concurrency + bucket dispatch**: `FlowBucket`, `FLOW_BUCKET_MODES`
- **Content-policy + moderator**: `classifyError`, `isContentPolicyError`, `extractContentPolicyTag`, `CONTENT_POLICY_REASONS`, `PUBLIC_ERROR_FILTER_RE`, `PromptModerator`, `createPromptModerator`
- **Step-side runner + factories**: `runGoogleFlowStep`, `GoogleFlowStepDeps`, `makeGoogleFlowImageProvider`, `makeGoogleFlowVideoProvider`, `imageProviders`, `videoProviders`
- **Media download**: `downloadToProjectPath`, `isAllowedResultHost`
- **DB tables**: `google_flow_accounts`, `google_flow_queue`, `google_flow_video_projects`, `moderation_events`
- **Behavior-driving columns**: `google_flow_queue.status`, `google_flow_queue.external_task_id`, `google_flow_queue.moderation_round`, `google_flow_queue.google_operation_id`, `google_flow_accounts.last_seen_at`, `google_flow_accounts.paused_until`, `google_flow_accounts.recovery_reason`, `google_flow_accounts.enabled`

## Architecture

HistForge is the brain of the Google Flow integration; the YouForge Flow Chrome extension is a dumb runner. This skill covers the brain. Four layers compose:

1. **Webhook surface.** Extension-facing routes (`next-task`, `submit-result`, `status`, `project`, `operation-started`) plus operator-facing routes called by the dashboard. Every per-account route embeds the account's secret token in the URL path and re-validates it against the body's `accountToken`.
2. **Coordination libraries.** Cross-route helpers that own the contract's invariants: the unified auth/validation gate, the reaper, the worker-side queue drain, the queue-progress builder for the dashboard, the SSRF-defended atomic downloader, the UI status derivation, the content-policy classifier, the pure account predicates, and a browser-safe constants module.
3. **Lifecycle module.** A single module of named, transactional multi-write transitions over `google_flow_accounts` + `google_flow_queue` + the banner-key settings — one per submit-result error category, plus the claim flow, the moderation batch, account deletion, and the operator manual-edit cascade. Each method opens its own transaction and composes the repo's atomic helpers; better-sqlite3 nests inner transactions as SAVEPOINTs, so cross-module cascades (e.g. `requeueFailedTask` → `videoLifecycle.unfailToQueued`) roll back together. See ADR-0007 for the design rationale and the scope rule that keeps single-statement transitions at their callers.
4. **Queue + provider integration.** Atomic SQL wrappers for accounts + queue + per-(video, account) project mapping; the shared "enqueue → wait → moderate → aggregate-failures" runner; and two thin provider factories that bind the runner to chunk kinds. The factories close over a `PromptModerator` built once per pipeline run by the coordinator.

The image and video provider registries mix shapes: ComfyUI registers a stateless singleton, Google Flow registers a factory keyed on `{ moderator }`. The registry getters dispatch on the entry's type, so callers always receive a built provider regardless of the underlying shape. The registries' `Object.keys` are the schema endpoint's source of truth for provider names — adding a Flow-adjacent provider means registering it on those records, not bolting it into the worker steps. See `domain-workflows` for how a workflow row chooses between them.

The coordinator is the *server side* of the dumb-runner contract that `domain-youforge-flow` describes from the extension side. Anything that crosses the wire is a contract; the extension assumes specific response shapes (especially the `{success: true}` invariant) and HistForge assumes the extension's polling cadence.

The Google Flow worker steps are not Google-Flow-specific anymore. The pipeline runs provider-agnostic `generate_images` and `generate_clips` steps; whether a video uses ComfyUI or Google Flow is decided by its workflow row, which binds an `imageProvider` / `videoProvider` into `StepContext`. Adding a new chunk-kind step that goes through Flow means writing a new provider module that adapts `runGoogleFlowStep` (mirroring the two existing factory modules), then wiring it through the registry — see `domain-workflows`. Provider-side `cleanup` is intentionally a no-op for the Flow providers because deleting the output directory mid-flight would orphan dispatched-but-unfetched queue rows keyed off the directory contents.

The queue and moderation enums use **asset-type vocabulary**: the `kind` columns are `"image" | "clip"` (post-Phase-2 rename from `"main_image" | "hook_video"`). The shared runner filters `chunks.json` by the provider spec's `chunkKind` against `Chunk.kind`. Any new asset type would mean a third `kind` value plus a new chunker variant that emits it — see `domain-workflows` on `chunker_step`.

## The Dumb-Runner Contract

The extension polls `next-task`, executes one Flow API call, posts to `submit-result`, and fires advisory `status` events. It also fires `project` (after creating a per-video Flow project on `labs.google`) and `operation-started` (right after a successful submit returns a Google operation name). It does *not* keep its own queue, classify errors business-wise, or decide retry policy — all of that is HistForge's job.

Two invariants drive the contract:

- **All extension-facing routes return `200 {success: true}` on every outcome** (errors included). The extension's webhook poster treats `success: false` and non-200 statuses as retry triggers; returning a hard error from a server-side bug would send the extension into a retry storm. Errors are surfaced through DB writes (failed rows, account pauses, banner settings) — never through HTTP status codes on these routes. Operator routes are different — those use real status codes because the dashboard handles them.
- **`last_seen_at` is the account's liveness signal**, bumped on every authenticated POST regardless of subsequent gating. If the body validates and the URL token matches a row, we bump `last_seen_at` *before* checking `enabled` — a disabled account is still alive if its extension is reporting in, and the dashboard's "polling stopped" label depends on this signal being honest.

## Auth Gate

`resolveFlowAccount` is the single entry point for every per-account route. Routes never inline its sequence; they call the gate, return its response on failure, and continue with the resolved account / parsed body. The two invariants worth knowing:

- **`last_seen_at` is bumped before the `enabled` gate.** A disabled account is still alive if its extension is reporting in. `submit-result` (in-flight rows must complete), `status` (observability), `project` (a disabled account can still report a project it just created), and `operation-started` (record the live operation for a row that may still resume) deliberately skip the `requireEnabled` check.
- **401 vs 404 split.** A token mismatch (URL token present, body's `accountToken` differs) is 401 — the caller is authenticated-but-inconsistent. An unknown token is 404 — the resource doesn't exist.

## Reaper

A periodic tick started from the worker entry point, alongside the boot dance that resets stale running steps and dispatched rows before starting the run loop. Three stages per tick, in this exact order:

1. **Account-level salvage.** Requeue any `dispatched` row whose assigned account has gone silent (stale `last_seen_at`) or is disabled. Catches a Chrome profile that crashed mid-task or was disabled with work in flight.
2. **Per-dispatch age timeout.** Requeue any `dispatched` row older than the configured timeout regardless of account liveness. Catches the case where the Flow backend silently dropped the job, or the extension's retry loop never POSTed back. Runs *after* stage 1 by design — stage 1 has already pulled the rows under dead accounts, so stage 2 only catches rows under still-live accounts.
3. **Wake deferred videos.** When any account is available, clear `videos.deferred_until` for any video that still has pending Flow rows. This is what lets a video resume the moment a cooldown lifts instead of waiting out the full deferral.

The tick is a pure function of `(db, now, thresholds)` so tests freeze time. `startReaper` carries an `isReaping` re-entrancy guard as belt-and-braces in case the tick ever goes async.

**Worker-boot recovery.** Every `dispatched` row is flipped back to `pending` on startup. The submit-result handler is state-tolerant — if an extension submits a result after the worker restarted, the row lookup misses (the new claim minted a fresh `external_task_id`) and the handler returns the duplicate-success shape.

## Queue Lifecycle

Status field is the source of truth: `pending → dispatched → done | failed`, with `requeueTask` flipping back to `pending`. A few rules tie this together:

- **`external_task_id` minted fresh on every claim.** The extension's in-memory `processedJobIds` dedup would otherwise skip a requeued row that reuses an old id. Every requeue path clears it for this reason.
- **`retry_count` is decoupled from requeue.** Reaper recovery and account-fleet salvage do *not* bump retry_count — only `flowLifecycle.handleTransient` does. `bumpRetryCount` is its own repo function for this reason.
- **`google_operation_id` resume hint.** When the SW posts to `operation-started`, HistForge stamps the Google operation pair on the row. The next dispatch's `googleOperationId` tells the SW to resume-poll instead of re-submitting (which would create a duplicate gallery entry). `requeueTask` clears the operation pair *only* when the row's prior status is `failed` — a failed operation on Google's side is terminal, so resume-polling it just returns the same failure forever. Dispatched-row requeues (reaper, transient) keep the pair so the SW can resume a live operation. `requeueWithNewPrompt` *always* clears the pair because a different prompt is by definition a different operation.
- **Pickup gated by paused video.** The claim query filters out paused videos. In-flight `dispatched` rows are unaffected — the extension finishes them and submits results normally; only NEW dispatches are gated.
- **Pickup gated by global queue pause.** `next-task` short-circuits to an empty body when `queue_state` is paused. No body, no Retry-After — the extension's polling cadence is the throttle.
- **Pickup gated by per-account state, in order.** The route checks `queue_state` → `recovery_reason !== null` → `paused_until > now`. The recovery branch sits *before* the time-pause clearance so a stale past `paused_until` cannot trigger the resume-and-claim path while operator-gated recovery is still owed. Account pause clears on first successful claim — `claimNextTask` resumes the account in the same transaction as the claim. There is no separate cron for it.
- **Concurrency-bucket dispatch.** The extension declares which bucket has free capacity via `wantBucket` on `next-task`; the server narrows the claim to the modes in `FLOW_BUCKET_MODES[bucket]`. The two buckets are independent slot counters on the extension and map to disjoint subsets of queue modes on the server — this is the canonical contract noun for "image runner vs video runner". Pre-bucket-split extensions omit `wantBucket` (legacy "any mode" behavior).

## Error Classification (`submit-result`)

Every error path is one transaction so partial state can't survive a mid-branch crash. The `errorCategory` field on the v2 envelope is the dispatch key. Routing summary:

| Category | Action |
|---|---|
| `create_project_failed` | account pause + requeue (no retry bump) + set the create-project-failed banner |
| `auth` | requeue only (no retry bump). The SW already flipped the relogin banner via `status`. |
| `stale_project_id` | clear the `(video, account)` row in `google_flow_video_projects` + requeue (no retry bump). The next dispatch's `flowProjectId` comes back null and the SW creates a fresh project. |
| `rate_limit` | account cooldown + requeue (no retry bump) |
| `service_overload` | minute-scale per-account pause + requeue (no retry bump) + stamp the service-overload-until banner (ADR-0004) |
| `transient` | bump retry count → if under cap requeue, else fail the task |

When `errorCategory` is missing or unrecognized (synthetic errors like download failure, empty submission, or pre-v2 extensions), fall through to the legacy free-form `classifyError`. The order inside `classifyError` is load-bearing — captcha first, then quota, service-overload, content-policy, then transient. Quota and service-overload sit *before* the `PUBLIC_ERROR_` catch-all because Google emits `PUBLIC_ERROR_QUOTA`, `PUBLIC_ERROR_UNUSUAL_ACTIVITY`, and `PUBLIC_ERROR_HIGH_TRAFFIC` that must route to throttling/backpressure paths, not the permanent-fail path.

**Captcha override.** The extension's `parseFlowApiError` maps every HTTP 403 to `errorCategory: "auth"`, so RECAPTCHA failures arrive labeled `auth`. The dispatch shape is: if `classifyError` says `captcha` it overrides the v2 category and routes through `handleCaptcha` (stamp `recovery_reason`/`recovery_required_at`, requeue without retry bump). Captcha is operator-gated (ADR-0003): there is no time cooldown that can clear it; only the dashboard's "Mark recovered" button resets the columns. The `next-task` gate keeps the account silent until the operator confirms.

The `submit-result` handler is also a salvage path: a result that arrives for a `failed` row is still accepted (downloads + completes) because the compute already happened. A result for an unknown `external_task_id` returns the duplicate-success shape — covers both worker-restart races and reaper-requeue-then-late-submit.

## Per-(Video, Account) Flow Project

`google_flow_video_projects` maps each `(video_id, account_id)` to a `flow_project_id`. The SW posts to the project route after creating a Flow project on `labs.google`; HistForge upserts the row with first-writer-wins (composite PK + `ON CONFLICT DO NOTHING`). On dispatch, `next-task` looks up the row and feeds `flowProjectId` back so the SW knows whether to create a new project (`null` → create) or reuse an existing one.

The first-writer-wins shape means a different `projectId` posted for an already-recorded pair logs a warning and returns 200 — never 4xx, because the SW can't recover from one. The `stale_project_id` error path in `submit-result` is the real recovery channel: when the operator deletes the project in `labs.google`'s UI, the SW gets a 404 from a `/projects/<id>/...` URL, posts back with `errorCategory: "stale_project_id"`, and `handleStaleProjectId` wipes the row so the next dispatch hands back `flowProjectId: null`.

## Banner Settings

Three operator-attention banner strings are owned by the coordinator and rendered by the dashboard (see `domain-dashboard`). All writes go through `FlowBannerKeys`; reads stay on string literals across the dashboard's view layer by design (ADR-0007 scope rule).

- **`flow_create_project_failed`** — written from `handleCreateProjectFailed`, dismissed by the operator endpoint. Operator-cleared only; never auto-clears. It's the one create-project signal the SW can't surface itself.
- **`google_flow_relogin_needed`** — flipped to `true` by `status` on a `session_expired` event, auto-cleared inside `claimNextTask` on the next successful claim. The operator-facing Dismiss endpoint is a snooze: it clears the flag but the next `session_expired` event re-flips it. Don't change the auto-clear point — making the banner sticky on the operator means a successful login doesn't visibly recover, which is worse than the snooze.
- **`flow_service_overload_until`** — Unix-seconds string set by `handleServiceOverload`, auto-clears when the timestamp elapses (the dashboard parses and hides the banner). Always overwritten on a fresh event — a new overload event pushes the timestamp forward rather than queueing.

## Operator-Gated Captcha Recovery

`recovery_reason` and `recovery_required_at` on `google_flow_accounts` carry operator-gated recovery state. The dispatch gate in `next-task` short-circuits while `recovery_reason !== null`, and `accountIsDispatchable` (the pure predicate consumed by lifecycle methods) honors the same order. The values are written by `handleCaptcha` and cleared symmetrically (both columns at once to keep the invariant tight). The per-video recovery-accounts endpoint exists as a thin poll slice so the per-video page doesn't have to pull the full videos-list payload just to render the banner.

The dispatch gate ordering is mirrored in two places: the runtime gate in `next-task` and the presentation mapper `getAccountStatus`. The predicates module is the shared truth for both — inlining `account.recovery_reason !== null` etc. in either place is what the predicates exist to prevent (the "polling stopped" label and the dispatch gate must never disagree on what dispatchable means).

## Step-Side Flow

`makeGoogleFlowImageProvider` and `makeGoogleFlowVideoProvider` are factory functions registered in the image / video provider registries. Each builds a thin adapter over `runGoogleFlowStep`, closing over the run's `PromptModerator`. The moderator is built once per pipeline run in the orchestrator so the moderation seam lives at the coordinator boundary rather than leaking through the image/video provider opts surface.

The shared runner pipeline is **enqueue → wait → moderate → aggregate**. Two invariants worth knowing:

- **Three skip checks before enqueue, in order:** output file exists on disk → open queue row exists for `(video, kind, chunk_id)` → *revivable failed* row exists (a failed-content-policy row the upcoming moderation pass will rewrite). The third check is what prevents double-enqueue when re-entering the step before moderation runs. A null-prompt chunk is logged and skipped. Zero enqueueable chunks AND zero existing outputs is a hard throw — better to surface a bug than hand the render step an empty directory.
- **Failure aggregation reads disk, not the `failed` table.** Stale `failed` rows from a previous run that were later replaced by a successful retry must not trip the throw. The runner filters `failed` rows by `output_path` non-existence on disk.

The defer signal pattern is what lets the orchestrator move on to other videos while one is parked waiting for accounts. Reaper stage 3 wakes it. `DeferSignal` is owned by `domain-pipeline`; this skill is one of its producers.

`waitForFlowQueue` returns one of `ok | stalled | paused | deleted | timeout`:
- `ok` → all rows are `done`/`failed`; the moderation loop runs before failure aggregation.
- `stalled` → no row is dispatched and no account is available. `retryAfter` falls back to the earliest paused-account timestamp, or a fixed window from now when nothing is paused.
- `paused` → global or per-video pause. `retryAfter = now()` so the defer clears the moment pause lifts.
- `deleted` → the orchestrator's between-step delete hook needs to run; the wait yields immediately on either an aborted `signal` or a DB-polled `delete_requested` flag.
- `timeout` → a wall-clock cap per re-entry (not cumulative across defers); throws.

## Content Moderation Loop

When a Flow chunk fails for content-policy reasons (Google's safety filters), HistForge can rewrite the prompt via a moderator LLM and requeue it instead of letting the step throw. The loop sits between `waitForFlowQueue` and failure aggregation inside the shared runner. Four things compose:

1. **Reachability.** Only `failed` rows reach the moderator. The submit-result error matrix never marks `quota / auth / rate_limit / stale_project / create_project_failed / service_overload / captcha` as `failed` — those all requeue. So the `failed` set is either content-policy or transient-exhausted, and `isContentPolicyError` discriminates between them. `classifyError` and `isContentPolicyError` answer different questions and intentionally diverge for one shape: an ambiguous `MEDIA_GENERATION_STATUS_FAILED` is classified `transient` (Veo's backend may have genuinely hiccuped — burn the retry budget first) but treated as content-policy *once it reaches the failed state* (the retries are exhausted, so the row is almost certainly deterministic and the moderator deserves a shot). New entries to `CONTENT_POLICY_REASONS`, the inline branch in `classifyError`, or `PUBLIC_ERROR_FILTER_RE` must preserve the empty intersection with the transient-exhausted family.

2. **Round budget on the row, not the video.** Each queue row carries a `moderation_round` column that increments every time the moderator rewrites it. Round numbering is per-row because different chunks may need different numbers of rewrites — the cap prevents one stubborn chunk from running the loop forever, while letting easier chunks succeed in round 1.

3. **wait → moderate → wait re-entry.** The first wait runs unconditionally. After it returns `ok`, the loop moderates, requeues rewritten rows via `recordModerationBatch`, and re-enters the wait. This re-entry is what actually consumes the new rounds — moderation only matters if the queue is given another chance to drain. A belt-and-suspenders iteration cap protects against arithmetic bugs in the round counter; the configured max-rounds setting is the real bound.

4. **Atomicity contract.** Per moderation round, `recordModerationBatch` inserts every `moderation_events` row and requeues every queue row in a single SQLite transaction. The `chunks.json` write happens *after* the txn commits, because filesystem writes have no business inside a SQLite transaction. A crash between the txn and the disk write leaves `chunks.json` slightly stale (missing the new `prompt_history` entry), which is harmless — the queue rows already carry the new prompt and `moderation_events` is the canonical record. Don't move the file write inside the txn to "fix" this.

**Tag extraction priority.** `extractContentPolicyTag` matches `PUBLIC_ERROR_FILTER_RE` (the broader `PUBLIC_ERROR_*_FILTER*` family) *before* the bare-code list in `CONTENT_POLICY_REASONS`. The order is load-bearing: a string like `PUBLIC_ERROR_SAFETY_FILTER_FAILED` would otherwise return `"SAFETY"` and lose information the moderator wants. The tag becomes the moderator's `reason_tag` field; when nothing matches, the loop falls back to the full `error_reason` string.

**Cross-component canonical list.** `CONTENT_POLICY_REASONS` mirrors the extension's `FLOW_CONTENT_POLICY_REASONS` Set. The extension is the canonical source — it sees errors first, on the live wire — so the HistForge list is downstream and must follow. A divergence test fails loudly when they drift; respect it instead of editing one side and leaving the other.

**Off-switch and model fallback.** The moderation-enabled toggle is the single operator-visible off switch — when off, the loop short-circuits before constructing the rewrite batch. The `moderator` dep on `GoogleFlowStepDeps` is required (TypeScript-enforced), so "no moderator passed" is structurally impossible; the coordinator builds it once per pipeline run. The moderation-model setting is optional — when empty, the moderator omits the model and the injected chat (the pipeline's `visualPromptChat` wrapper) falls back to the workflow-pinned provider's visual model. The chat closed over by the moderator is the same `visualPromptChat` the rest of the pipeline uses, with the run's `AbortSignal` folded in upstream, so the moderator inherits both the visual-model default and cancellation latency automatically.

**`prompt_history` accumulation.** Each rewrite appends the previous (non-null) prompt to `Chunk.prompt_history` before overwriting `Chunk.prompt`. This is the one place chunks accumulate state across rounds; the rest of the pipeline treats `chunks.json` as freshly produced from the chunking step. If you add a new field that should follow rewrites, decide explicitly whether it accumulates or resets.

## Operator Manual Edit

The video-detail page surfaces every failed row as an always-visible "Needs your review" card, plus any in-flight row whose `moderation_round > 0` so the operator can override an automatic rewrite mid-flight. Two modes, keyed off whether the request body carries a `prompt`:

- **Edit + retry.** Replace the row's prompt, install it into the matching chunk in `chunks.json`, reset `moderation_round` to 0 (the operator's edit doesn't count against the automatic budget — it's a fresh start, not another round), write a `moderation_events` row tagged `manual_edit`, and flip the row back to `pending`. Queries that count automatic rewrite attempts must filter `manual_edit` rows out.
- **Plain retry.** Requeue in place — same prompt, `moderation_round` preserved, no audit row. The "give the current prompt another attempt" affordance the operator needs while an automatic rewrite is in flight.

The route delegates to `flowLifecycle.requeueFailedTask`, which is the only lifecycle method that crosses aggregate boundaries: when the parent video is in `failed`, the same transaction also delegates to `videoLifecycle.unfailToQueued` to reset the failed step row and flip the video back to `queued`. The cross-module hop goes lifecycle-to-lifecycle (never lifecycle-to-repo) — better-sqlite3 nests the inner transaction as a SAVEPOINT so a throw rolls the whole cascade back. The `chunks.json` write happens *after* the SQLite transaction commits, matching the moderation-loop convention.

**`dispatched` is editable on purpose.** Rows in `dispatched` accept the edit even though the SW may submit a result for the old prompt before re-dispatch lands. `requeueWithNewPrompt` clears `external_task_id` *and* the `google_operation_id` pair (always, regardless of source status — a different prompt is a different operation), so a late `submit-result` post for the old id falls through to the duplicate path. Worst case is a wasted dispatch — never a corrupted output.

## Bulk Requeue

The dashboard's bulk "Retry failed step" path. Acts on two row sets: `failed` rows whose `retry_count` is under the cap (a force flag bypasses), and `dispatched` rows the extension can drop silently when its stop flag fires mid-task. Failed rows additionally pick up any operator edit that landed in `chunks.json` since the row was enqueued — divergent prompts trigger the same edit-and-retry path as the per-row endpoint (reset `moderation_round`, write a `manual_edit` audit row). Dispatched rows are intentionally NOT prompt-synced: the extension may submit a result for the old prompt before re-dispatch lands, and the submit-result handler would then store an old-prompt result against the new row.

Coupling with the failed-step retry mirrors the per-row path: when at least one row is requeued and the video is in `failed`, the same outer transaction also resets the failed step row and clears failure metadata via `videoLifecycle.unfailToQueued`. Without this, requeued rows sit pending forever — the runner only picks `in_progress`/`queued` videos, so a `failed` video never re-enters the step that would consume them.

## Media Download

`downloadToProjectPath` is the only sanctioned way to materialize a Flow result on disk. Two non-negotiables:

- **SSRF allowlist.** `isAllowedResultHost` accepts `data:` URLs plus a small set of Google-owned host patterns (exact hosts, suffix matches, and a `fife.*.googleapis.com` carve-out). Anything else is rejected before a request is issued. The `submit-result` route *also* validates with `isAllowedResultHost` before calling the helper — defense in depth.
- **Atomic write.** Stream into a sibling `.tmp` then rename to the final path. Partial fetches can never be mistaken for finished artifacts. On any throw, unlink `.tmp` (best-effort).

Result URLs from the extension can be a comma-separated list (multi-output modes); the submit-result route peels off the first internally. `data:` URLs are passed through untouched — splitting them on commas would turn the payload into garbage.

## Settings UI Surface

The `Settings > Google Flow` tab lists accounts (mints new ones, which generates the webhook URLs the operator pastes into the extension), exposes the model / aspect-ratio / hook-clip-seconds selectors that ride on every dispatch, and groups advanced knobs (account cooldown, max retries, dispatch timeout, content-moderation knobs) under a collapsible. Account status labels come from `getAccountStatus` — the same helper the video-detail accounts strip uses, so both surfaces agree on `online | paused | recovery_needed | stopped`.

## Common Pitfalls

- **Never return `success: false` (or a 4xx/5xx) from an extension-facing route.** The extension's webhook poster treats those as retry triggers and the runaway storm is hard to recover from. Surface errors via DB state, not HTTP. Operator routes use real status codes.
- **Don't add a per-account route without going through `resolveFlowAccount`.** It's the only place `last_seen_at` is bumped, and inlining the auth sequence drifts the routes apart. The 401-vs-404 split and the bump-before-enabled-gate ordering are easy to lose.
- **Don't bump `retry_count` in reaper or salvage paths.** Only `flowLifecycle.handleTransient` should bump. Reaper requeues are recovery, not retries — conflating them silently exhausts the retry budget on rows that never ran.
- **Don't enqueue without checking both `findOpenTaskForChunk` and `findRevivableFailedTaskForChunk`, and never reuse `external_task_id` on requeue.** Step re-entry (defer wake, worker restart, bulk retry) double-enqueues otherwise — a failed-content-policy row the moderator is about to revive isn't settled in spirit, and a parallel new row would race on the same `output_path`. The extension's `processedJobIds` dedups on `external_task_id`, so reusing it silently drops the row.
- **`google_operation_id` reset rules are asymmetric.** `requeueTask` clears the pair only when the prior status is `failed`; `requeueWithNewPrompt` always clears it. A failed operation on Google's side is terminal — resume-polling it just returns the same failure. A dispatched-row requeue (reaper, transient) keeps the pair so the SW resumes the live op instead of duplicating. A prompt rewrite *is* a different operation, regardless of prior state.
- **Captcha is operator-gated, quota is timed.** Quota's pause clears with elapsed `paused_until`; captcha clears only via the explicit "Mark recovered" route. The dispatch gate orders `recovery_reason` *before* `paused_until`, so a stale past `paused_until` cannot flip a recovery-needed account back into dispatchable. The presentation mapper, the predicate module, and the gate all share this ordering — keep them in lockstep or the dashboard's status label will silently disagree with whether dispatches actually happen.
- **Don't add a content-policy reason on one side only.** `CONTENT_POLICY_REASONS` mirrors the extension's `FLOW_CONTENT_POLICY_REASONS`; the extension is canonical because it sees errors first. The divergence test fails loudly if they drift — fix it by syncing both lists, not by deleting it. Same invariant applies to anything new in `PUBLIC_ERROR_FILTER_RE` or the inline transient regex: they must keep empty intersection with the content-policy match shapes, or a transient error will get permanently failed (or vice versa).
- **Don't drop the SSRF allowlist for a custom Flow gateway.** The two-layer check (in `submit-result` + in the downloader) is deliberate defense in depth. If a new host is genuinely required, extend the allowlist so the dual check still passes; weakening one side leaves a hole.
