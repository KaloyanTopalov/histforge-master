---
status: accepted
date: 2026-05-17
---

# Two lifecycle modules along operator-mental-model lines

## Context

[Depth audit suggestion #4](../refactoring/depth-audit-2026-05-12.md) proposed pulling video lifecycle transitions into a single `videoLifecycle` module. Descriptive research in [docs/research/2026-05-17-video-lifecycle-state-machine.md](../research/2026-05-17-video-lifecycle-state-machine.md) inventories where composed transitions live today: orchestrator transitions in `worker/pipeline.ts`, multiple API routes (retry, restart, pause, resume, delete), six Flow webhook handlers in `submit-result/[token]/route.ts`, the cross-aggregate resume cascade in `queue-row` / `requeue-failed`, and the moderation batch in `worker/steps/google-flow-common.ts`. The research surfaced that "Flow-side" transitions almost never touch `videos.*` — they mutate accounts (`google_flow_accounts`), queue tasks (`google_flow_queue`), and banner settings. Treating the whole surface as one `videoLifecycle` module would mix two unrelated operator mental models behind the same import.

## Decision

Two lifecycle modules along the operator-mental-model split, both backed by the existing atomic repos, both with their own predicate module for derived rules.

1. **Two modules, not one.** `src/lib/lifecycle/video.ts` (VideoLifecycle) owns orchestrator + dashboard-operator transitions. `src/lib/lifecycle/flow.ts` (FlowLifecycle) owns Flow webhook + Flow-fleet-operator transitions. The split mirrors the existing [CONTEXT.md](../../CONTEXT.md) separation between the video pipeline and the Flow fleet "Coordination vocabulary."

2. **Three layers per aggregate.** `lib/repos/{videos,steps,google-flow}.ts` continue to expose atomic helpers. `lib/lifecycle/predicates/{video,flow}.ts` expose pure derived rules (`isPausable`, `isRetryable`, `accountIsDispatchable`, etc.) consumed by both the lifecycle modules' guards AND by dashboard/route consumers. `lib/lifecycle/{video,flow}.ts` expose named multi-write transactional transitions composed from the atomic helpers.

3. **Cross-module composition via better-sqlite3 savepoint nesting.** The one transition that genuinely crosses the module boundary — the resume cascade in `queue-row` / `requeue-failed` — lives in FlowLifecycle as `requeueFailedTask`, which conditionally calls `videoLifecycle.unfailToQueued(videoId)` lifecycle-to-lifecycle. Better-sqlite3's `db.transaction(fn)` is reentrant; the inner call becomes a savepoint, so the cascade commits atomically without shared-transaction-context plumbing. **Rule for any future cross-module transition: lifecycle-to-lifecycle calls only; never reach into the other module's repos.**

4. **Narrow modules — only multi-write transactions earn a place.** Single-statement transitions (`markInProgress`, `setDeferredUntil` / `clearDeferredUntil`, `setDeleteRequested`, `videosRepo.markDone` finalize, `stepsRepo.markDone`, `gfRepo.failTask` from `handleContentPolicy`, `gfRepo.requeueTask` from `handleAuth`, single-field account PATCH writes) stay as direct repo calls in callers. Result: VideoLifecycle exposes ~8 methods, FlowLifecycle ~11. The audit's "wide" reading was rejected on Ousterhout-depth grounds — pass-through wrappers around single repo calls would be shallow.

5. **Banner setSetting writes stay inline.** The three fleet-level banner setting keys (`flow_create_project_failed`, `flow_service_overload_until`, `google_flow_relogin_needed`) are centralized in `src/lib/lifecycle/flow-banner-keys.ts` as a 5-line shared constants file, but the actual `setSetting()` writes stay inline at their existing sites (inside FlowLifecycle transitions for the set side; in dismiss routes for the clear side). The audit-log future-proofing this gives up is captured in `docs/plans/2026-05-17-video-lifecycle-followups.md`.

6. **Internally-transactional repo helpers stay in repos.** `createNewVideo`, `updateVideoDraft`, `transitionNewToQueued`, `deleteVideoFullyRemoved`, `takeNextTaskForAccount` are already multi-write transactions inside the atomic repos. They stay where they are; the repo docstrings are corrected to read "atomic single-statement OR a single conceptual write that intrinsically spans tables" instead of the current "atomic SQL wrappers" lie.

## Considered options (rejected)

**One lifecycle module** (the audit's literal proposal). Rejected because half the transitions are Flow-side and naming the module `videoLifecycle` would mislead a reader scanning imports. The "single chokepoint for invariants" argument loses to the "two unrelated operator mental models" cost.

**Per-aggregate state machines** (4 modules: videos, steps, accounts, queue + thin coordinator). Rejected because per-aggregate "transitions" are mostly single-column updates with too-thin cohesion to justify a module each; the interesting compositions are cross-aggregate and would all live in the coordinator anyway — same shape as the chosen two-module split with extra ceremony.

**Wide modules** (every named state change including single-statement transitions). Rejected per Ousterhout's deletion test — pass-through wrappers (`videoLifecycle.finalize` calling `videosRepo.markDone`) would not earn their keep. The SOLID arguments for wide (SRP/OCP/DIP all favor a single chokepoint) lost on the depth tradeoff for transitions that aren't compositions.

**Banner writes through FlowLifecycle methods**. Rejected because dismiss routes are single-`setSetting` calls and wrapping them adds ~15 lines of indirection across `flowLifecycle.dismissXxxBanner` methods for no atomicity payoff. The discoverability cost ("where does `google_flow_relogin_needed` get cleared?" becomes a double-grep) outweighs the chokepoint discipline. The audit-log future-proofing this gives up is captured as a known gap in the followups doc.

**Shared transaction context plumbing** for cross-module composition. Rejected because better-sqlite3 already supports reentrant transactions via savepoints; FlowLifecycle calling `videoLifecycle.unfailToQueued(...)` from inside its own `db.transaction()` block nests correctly with full rollback propagation. No need to introduce a "composable variant" of every VideoLifecycle method.

## Consequences

- **`src/lib/lifecycle/` mirrors `src/lib/repos/`** — same convention (a layered-concern directory under `lib/`). Predicates nested under `lib/lifecycle/predicates/` make the subordinate relationship visible.
- **CONTEXT.md gains "Lifecycle vocabulary"** with three entries: Video lifecycle, Flow lifecycle, Transition. The operator-mental-model split criterion is recorded in the Video lifecycle entry.
- **The repo docstrings change semantics, not structure.** Atomic-only is no longer the rule; the actual rule is "atomic single-statement OR a single conceptual write that intrinsically spans tables (create, full-delete, take-from-queue)." Callers should not reach into repos for multi-write transitions — those go through the lifecycle modules.
- **The DB-backed lifecycle audit log is out of scope.** The lifecycle module's existence is the seam that makes adding it later a one-line-per-transition change. Known gaps (banner setSetting calls outside the module, single-statement transitions under narrow) captured in [docs/plans/2026-05-17-video-lifecycle-followups.md](../plans/2026-05-17-video-lifecycle-followups.md).
- **The `videos.current_step` denormalization is out of scope.** It is the only reason `enterStep` qualifies as multi-write (and therefore for inclusion in VideoLifecycle); dropping the column would shrink the module by one. Captured in the followups doc for future re-evaluation.
- **No spec change required.** `docs/histforge-spec.md` describes the pipeline contract in terms of step modules and DB tables, not in terms of lifecycle composition layer. The refactor is internal to the lib/ layer.
- **Cancellation watcher (`src/worker/cancellation.ts`), runner `pickNextVideo`, `flow-auth.ts` `updateAccountLastSeen`, and `ready-script.ts` are explicitly unchanged.** These do not own multi-write transitions and don't belong in the lifecycle modules under the narrow scope.
