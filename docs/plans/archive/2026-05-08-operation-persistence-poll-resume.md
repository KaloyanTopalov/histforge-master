# Operation Persistence + Poll Resume

**Status**: in-progress
**Created**: 2026-05-08
**Branch**: `chatterbox-parallelism` (continuing on existing branch)

## Problem

When Google Flow's status endpoint (`batchCheckAsyncVideoGenerationStatus`) returns a 403 anti-abuse page, the extension throws and never tells HistForge that a Google operation was successfully kicked off. Today the operation name only lives in memory inside the poll loop, so:

1. Google generates the video successfully (visible in the Flow gallery).
2. The poll fails → no webhook to HistForge → operation name lost.
3. After 30 min the reaper requeues with a fresh `external_task_id`.
4. Extension submits **again** → another operation → another duplicate gallery entry.

## Goal

Persist the Google operation name when submit succeeds, then on requeue let the extension resume polling instead of blindly resubmitting. This kills duplicates and recovers compute that already finished.

## Out of scope

- Multi-operation tasks. We persist the *first* mediaId per task; image-gen modes are synchronous and unaffected.
- Cooldown escalation (separate concern from earlier conversation).
- Forced re-submit after operator action — if needed later, an explicit "force resubmit" button can clear `google_operation_id`.

## Phases

### Phase 1 — HistForge schema + repo

- [x] 1.1 Migrate `google_flow_queue`: add `google_operation_id TEXT`, `google_operation_project_id TEXT`. Idempotent ALTER pattern (catch duplicate-column-name).
  **Files**: `src/lib/db.ts`
  **Test**: `__tests__/unit/lib/db.test.ts` — schema test asserting columns exist.
- [x] 1.2 Extend `GoogleFlowQueueItem` type with the two new fields.
  **Files**: `src/types.ts`
- [x] 1.3 Add `setOperationStarted(db, id, operationId, projectId)` repo helper. Idempotent — last-writer-wins (a fresh-submit retry overwrites stale ids).
  **Files**: `src/lib/repos/google-flow.ts`
  **Test**: `__tests__/unit/lib/repos/google-flow.test.ts` (new file or existing) — set + read back.

### Phase 2 — HistForge route + dispatch payload

- [x] 2.1 New route `POST /api/flow/operation-started/[token]` with body `{ type: "OperationStarted", accountToken, taskId, operationName, projectId }`. Resolves the task by `external_task_id`, no-ops when task is missing or not in `dispatched` (state-tolerant). Returns `{ success: true }` always.
  **Files**: `src/app/api/flow/operation-started/[token]/route.ts` (new)
  **Test**: `__tests__/api/flow/operation-started/route.test.ts` (new)
- [x] 2.2 `next-task` payload: include `googleOperationId` and `googleOperationProjectId` when the claimed row carries them.
  **Files**: `src/app/api/flow/next-task/[token]/route.ts`
  **Test**: extend `__tests__/api/flow/next-task/route.test.ts`

### Phase 3 — Extension webhook + URL plumbing

- [x] 3.1 Schema entry: `{ key: 'operationStartedUrl', default: '', kind: 'string' }` in `settings-schema.js`.
  **Files**: `extensions/youforge-flow/src/settings-schema.js`
- [x] 3.2 Cache + `getOperationStartedUrl()` getter; thread through `updateWebhooks`.
  **Files**: `extensions/youforge-flow/src/settings.js`
  **Test**: `__tests__/unit/youforge-flow/settings.test.ts` (extend)
- [x] 3.3 Popup: derive URL from `${domain}/api/flow/operation-started/${token}`, include in webhooks message.
  **Files**: `extensions/youforge-flow/popup.js`
- [x] 3.4 `webhook.js`: `postOperationStarted({ taskId, operationName, projectId })`. One-shot, no retry (next dispatch can re-discover via fresh submit).
  **Files**: `extensions/youforge-flow/src/webhook.js`
  **Test**: `__tests__/unit/youforge-flow/webhook.test.ts` (extend)

### Phase 4 — Extension submit→post and poll-resume

- [x] 4.1 In `runVideoGeneration` (`executors/shared.js`), after submit returns mediaIds and before `pollVideo`, fire-and-forget `postOperationStarted` with the first mediaId.
  **Files**: `extensions/youforge-flow/src/executors/shared.js`
  **Test**: `__tests__/unit/youforge-flow/executors-shared.test.ts` (extend or new)
- [x] 4.2 In `runVideoGeneration`, when `task.googleOperationId` is set, skip submit and build `mediaIds = [{ name, projectId }]` from the task fields.
  **Files**: `extensions/youforge-flow/src/executors/shared.js`
- [x] 4.3 On poll-resume, NOT_FOUND from Google → null out `task.googleOperationId` in memory and fall back to fresh submit path (catch and retry once). Clearing the in-memory id is required so the retry doesn't re-enter the resume branch and loop.
  **Files**: `extensions/youforge-flow/src/executors/shared.js`

## Notes

- **No clear on completeTask.** `google_operation_id` is left set on `done` rows. The row won't be re-dispatched, so there's nothing to clean up — keeping the value also preserves a useful audit trail for "which Google op produced this output."
