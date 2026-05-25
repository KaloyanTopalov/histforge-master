# Per-Video, Per-Account Flow Project Folders — Implementation

## Overview

Replace the operator-opens-a-Flow-project-in-the-tab coupling with a per-(video, account) Flow project mapping. Each enabled account creates its own Flow project per video on first dispatch, named after the video; HistForge stores the mapping in a new `google_flow_video_projects` table and feeds it back to the extension on each subsequent dispatch.

**The design doc at `docs/plans/2026-04-25-per-video-flow-projects.md` is the source of truth for *why* and *how* every change works** — race-condition analysis, error taxonomy, captured trpc envelopes, defensive parsing branches, the deleteProject appendix, and operator-confirmed constraints all live there. This file is the task tracker; each task points back to the relevant section.

## Current State

References below are line-verified against current code:

- `src/lib/db.ts:84` — `db.pragma("foreign_keys = ON")` (the new FK CASCADE will fire)
- `src/lib/repos/google-flow.ts:241` — `takeNextTaskForAccount` (account-agnostic claim — drives the multi-account model)
- `src/types.ts:33-43, 57-78` — `GoogleFlowAccount`, `GoogleFlowQueueItem` (place the new interface near these)
- `src/app/api/flow/next-task/[token]/route.ts:31, 90-102` — `shapeTaskForExtension`, transaction block
- `src/app/api/flow/submit-result/[token]/route.ts:25-34, 52, 81` — `ResultSubmissionSchema`, `classifyError`, `handleError`
- `src/app/api/flow/status/[token]/route.ts` — pattern to mirror for the new project webhook
- `src/lib/repos/videos.ts:341-349` — `deleteVideoFullyRemoved` (cascade trigger)
- `extensions/youforge-flow/src/auth.js:19-22, 116` — `getProjectIdCached` + cache vars (to delete)
- `extensions/youforge-flow/src/executors/index.js:50` — current `getProjectIdCached(tabId)` call site
- `extensions/youforge-flow/src/webhook.js:22-46, 226-243` — `postStatusEvent`, v2 failure fields
- `extensions/youforge-flow/src/settings.js` — three URL getters (poll/result/status); add a fourth alongside
- `extensions/youforge-flow/popup.html:24-33`, `popup.js:140, 197-205` — three webhook rows, `histforgeOrigin()`, `refreshEnabled()`
- `extensions/youforge-flow/background.js:20-21` — auth.js then account-tier.js (insert project-mgmt.js between)
- `extensions/youforge-flow/src/messages.js:30-37, 61-68` — `stopAllProcessing` and `autoStopped` cases
- `extensions/youforge-flow/src/self-test.js:88-90` — `pingHistForge` pattern
- `extensions/youforge-flow/src/page-call.js:118` and `flow-api.js:39-47` — `parseFlowApiError` call sites for stale-project override
- All test files exist: `__tests__/unit/lib/db.test.ts`, `__tests__/unit/lib/repos/google-flow.test.ts`, `__tests__/api/flow/{next-task,submit-result,status}/[token]/route.test.ts`, `__tests__/unit/youforge-flow/{auth,page-call,self-test}.test.ts`. The `getProjectIdCached` describe block is at `auth.test.ts:304` (~8 assertions); the mock at line 9.

## Phase mapping (impl plan ↔ design doc)

The design doc and this impl plan both use the word "Phase" but they number differently. Translation:

| Impl plan phase | Design doc phase | Scope |
|---|---|---|
| Phases 1-6 (impl) | Design doc Phase 1 + Phase 2 | The end-to-end create flow. Design-doc Phase 2 ("local cleanup on hard-delete") has no code beyond the FK CASCADE in impl Task 1.1. All ships in **one PR**. |
| Phase 7 (impl) | Design doc Phase 3 | Dashboard banner for `flow_create_project_failed`. Ships in a **separate PR** any time after Phases 1-6 land. |

When tasks reference "the design doc's §Phase N", they mean the design doc's numbering — never this file's.

## Scope

**Doing in PR 1 (impl Phases 1-6)**: schema + types + repo helpers + two route changes (next-task, project webhook) + one route extension (submit-result classifier) + extension SW project-creation module + executor switch + auth.js cleanup + popup project-URL field & gate + self-test 8th check + setup docs update.

**Doing in PR 2 (impl Phase 7)**: dashboard banner for `flow_create_project_failed` and its dismiss endpoint.

**Local-only cleanup on hard-delete** is the FK `ON DELETE CASCADE` declared in Task 1.1 — no separate task.

**Deployment runbook** (rollout sequence + migration posture) is sourced from design doc §"Sequencing" and §"Phase 1, migration strategy"; goes into the PR 1 description at PR-creation time, not as a code task.

**Not doing**:
- Google-side `deleteProject` calls (captured in design-doc appendix; operator policy is to leave Flow-side projects forever).
- FK from `google_flow_video_projects.account_id` to `google_flow_accounts(id)` — no FK precedent (see `google_flow_queue.assigned_account_id`); operator wants account-deletion to leave orphan rows.
- `videos.flow_project_id` column (the multi-account model needs the join table, not a single column).
- Cookie-switching defenses inside a Chrome profile (operator constraint: one Google identity per profile, never switched).

## Tasks

### Phase 1 — HistForge backend: schema, types, repo helpers

- [x] **Task 1.1: Add `google_flow_video_projects` table + schema tests**
  **Files**: `src/lib/db.ts`, `__tests__/unit/lib/db.test.ts`
  **What**: New `CREATE TABLE IF NOT EXISTS google_flow_video_projects` block alongside the other tables. Composite PK `(video_id, account_id)`. FK on `video_id → videos(id) ON DELETE CASCADE`. **No FK on `account_id`**. Tests: table exists on fresh DB, composite PK rejects duplicate inserts, ON DELETE CASCADE fires on video hard-delete.
  **Context**: Exact DDL and rationale in design doc §"Phase 1 / `src/lib/db.ts`". FK enforcement already on at line 84 — cascade will fire automatically. `CREATE TABLE IF NOT EXISTS` is idempotent; no migration needed.

- [x] **Task 1.2: Add `GoogleFlowVideoProject` interface**
  **Files**: `src/types.ts`
  **What**: Export an interface mirroring the table columns, placed near `GoogleFlowAccount` and `GoogleFlowQueueItem`. No change to `Video`.
  **Context**: Design doc §"Phase 1 / `src/types.ts`".

- [x] **Task 1.3: Add video-projects repo helpers + tests**
  **Files**: `src/lib/repos/google-flow.ts`, `__tests__/unit/lib/repos/google-flow.test.ts`
  **What**: Append a "video projects" section after the existing queue helpers with: `findFlowProjectForAccount`, `upsertFlowProjectForAccount` (returns `{inserted, existingProjectId}` via `INSERT ... ON CONFLICT DO NOTHING` + read-back), `clearFlowProjectForAccount`, `listFlowProjectsForVideo`. Cover with the 9 test cases listed in the design doc.
  **Context**: Function signatures, SQL, and the 9-test list in design doc §"Phase 1 / `src/lib/repos/google-flow.ts`" and §"Phase 1, test plan / Repo tests". **First-writer-wins is by design** — do not switch to `ON CONFLICT DO UPDATE` (rationale at §"Phase 1, race-condition analysis" #5).

### Phase 2 — HistForge backend: routes

- [x] **Task 2.1: Extend next-task payload with per-account project fields**
  **Files**: `src/app/api/flow/next-task/[token]/route.ts`, `__tests__/api/flow/next-task/[token]/route.test.ts`
  **What**: After `takeNextTaskForAccount` claims a row, do two reads inside the same transaction (lines 90-102): `videosRepo.findById` and `gfRepo.findFlowProjectForAccount(db, claimed.video_id, account.id)`. Extend `shapeTaskForExtension` (line 31) with three fields: `flowProjectId` (the per-account row's id, or `null`), `videoId` (= `row.video_id` — distinct from the existing `id` field, which is `task.id`; do NOT conflate), `projectTitle`. Add the four dispatch tests from the design doc — including the cross-account isolation case (account A must not receive account B's projectId).
  **Context**: Design doc §"Phase 1 / `src/app/api/flow/next-task/[token]/route.ts`" and §"Phase 1, test plan / Next-task route".

- [x] **Task 2.2: New `POST /api/flow/project/[token]` webhook**
  **Files**: `src/app/api/flow/project/[token]/route.ts` (NEW), `__tests__/api/flow/project/[token]/route.test.ts` (NEW)
  **What**: Mirror the structure of `src/app/api/flow/status/[token]/route.ts` — same `resolveFlowAccount` gate (does NOT require `account.enabled`), Zod-then-handle. Schema: `{type: "ProjectCreated", accountToken, videoId, projectId, projectTitle}`. Handler: 404 if video missing, else `gfRepo.upsertFlowProjectForAccount(db, parsed.videoId, account.id, parsed.projectId, Math.floor(Date.now() / 1000))` (Unix-seconds — same convention as `submit-result/route.ts:96`), log a warning if `inserted=false` AND existing id differs from posted id, return 200 either way. Tests: 401/404 cases, first-write persists, idempotent repost (same id), first-writer-wins on different id (warning path), separate rows per account on same video.
  **Context**: Design doc §"Phase 1 / NEW `src/app/api/flow/project/[token]/route.ts`" and §"Phase 1, test plan / Project webhook". The single-attempt no-retry posture on the SW side means this route MUST stay 200-on-conflict — design doc explains why.

- [x] **Task 2.3: Submit-result classifier — v2 fields, create-project / stale-project / auth handling, and `flow_create_project_failed` setting registration**
  **Files**: `src/app/api/flow/submit-result/[token]/route.ts`, `src/lib/settings.ts`, `src/lib/db.ts`, `__tests__/api/flow/submit-result/[token]/route.test.ts`
  **What**:
  1. **Register the new setting first** so `setSetting` won't throw on the unknown key: add `flow_create_project_failed: z.string()` to `SETTING_SCHEMAS` in `src/lib/settings.ts` (around line 12+) and `flow_create_project_failed: ""` to `DEFAULT_SETTINGS` in `src/lib/db.ts:11`. This also makes the value visible via `GET /api/settings` so Phase 7's banner and Task 6.2's manual check can read it.
  2. Extend `ResultSubmissionSchema` (lines 25-34) with the v2 optional fields the SW already sends per `webhook.js:226-243`: `errorCode`, `errorCategory`, `httpStatus`, `retryable`, `contentPolicyTag`, `correlationId`, `timings`, `schemaVersion`.
  3. Change `handleError` signature from `{task, account, errorText}` to `{task, account, errorText, parsed?}` (keep `errorText` as a required free-form fallback string; `parsed` is the optional Zod-parsed body). **The route has THREE callers of `handleError`**, not one: line 188 (primary error path — pass the full `parsed` object), line 199 (download-failure synthetic — pass only `errorText: "download_failed: ..."`, no `parsed`), and line 210 (empty-submission synthetic — pass only `errorText: "empty submission ..."`, no `parsed`). Inside `handleError`, if `parsed?.errorCategory` is one of the new categories, take the new branch; otherwise fall through to legacy `classifyError(errorText)`. The synthetic-error sites stay on the legacy path by design — they describe HistForge-side failures that have no v2 extension envelope.
  4. New branches (each a single `db.transaction(() => { ... })()` wrapper, mirroring the existing `quota` branch at line 97 and `transient` branch at line 106 — atomic-on-crash semantics):
     - **`create_project_failed`**: pause account 24h (compute `now + cooldownH * 3600` like the existing quota branch does at line 96-98) + `requeueTask` (no `bumpRetryCount`) + `setSetting("flow_create_project_failed", JSON.stringify({errorCode, httpStatus, taskId, when, accountId}))` — the Phase 7 banner reads this exact shape. **Three writes, must be in one transaction.**
     - **`auth`**: just `requeueTask` (no `bumpRetryCount`, no flag write — the relogin flag is set by the StatusEvent path in `src/app/api/flow/status/[token]/route.ts`, which is a separate route the SW calls via `notifySessionExpired`; this branch is intentionally a no-op on that flag). Single statement, no transaction needed.
     - **`stale_project_id`**: `clearFlowProjectForAccount(db, task.video_id, task.assigned_account_id)` + `requeueTask` (no `bumpRetryCount`). **Two writes, must be in one transaction.** Verify the queue-row passed to `handleError` carries `assigned_account_id`; if not, fall back to `account.id` from `resolveFlowAccount`.
     - `rate_limit` and `transient` route to existing branches; missing/other → legacy `classifyError(errorText)`.
  5. Tests for the four new behaviors as listed in the design doc.
  **Context**: Full mapping table in design doc §"Phase 1 / `src/app/api/flow/submit-result/[token]/route.ts`". Rationale (why `create_project_failed` doesn't burn retry budget; why the `auth` branch is intentionally a no-op on the relogin flag) in §"Phase 1, error taxonomy". The setting registration in step 1 is plan-level, not in the design doc — necessary because HistForge's settings system gates `setSetting` on `assertKnownKey` and `getAllSettings` only parses known keys. The signature-keep-`errorText` and three-caller correction in step 3 are plan-level — the design doc said "single caller", which is wrong about the current code.

### Phase 3 — Extension SW: project creation module + supporting plumbing

**Note on dependencies within this phase**: Task 3.1 declares the forward refs `getProjectUrl` and `postProjectCreated` that Task 3.3 implements; Task 3.2 wires `clearInFlight` from Task 3.1 into messages.js. Implement in numeric order (3.1 → 3.2 → 3.3 → 3.4) so the SW is loadable at every commit. Task 3.4 (stale-project-id detection) is grouped here because it lives in SW files near the existing error-classification path; it is independent of project-mgmt.js and could land in any order.

- [x] **Task 3.1: New `project-mgmt.js` SW module**
  **Files**: `extensions/youforge-flow/src/project-mgmt.js` (NEW)
  **What**: Implement the per-videoId mutex (`_inFlight: Map<videoId, Promise<string>>`), `getOrCreateProjectId(task, ctx)` (**call `assertNotStopped()` at entry, per the auth.js / page-call.js convention**), `_createFlowProject(tabId, projectTitle)` (**also `assertNotStopped()` at entry**; runs `project.createProject` in MAIN world via `chrome.scripting.executeScript`, mirrors the `apiCallViaPage` envelope shape from `page-call.js:73-99`, **no timeout wrapping**), `_sanitizeProjectTitle(raw)` (strip CRLF, collapse whitespace, 250-char cap, "Untitled video" fallback — small unit test recommended), and top-level `clearInFlight()`. Defensive parsing: every branch in the design doc's HTTP-status table must be implemented and must `safeLog` truncated body. On 429, call `triggerRateLimitCooldown(err)` at the throw site (mirrors `flow-api.js:_throwFlowApiError`).
  **Known orphan path (do NOT try to fix)**: if dispatch N+1 arrives carrying a stored `flowProjectId` while dispatch N's create-promise is still in flight, step 2 of `getOrCreateProjectId` short-circuits and returns the stored id; dispatch N's promise resolves to a *different* projectId, posts it to HistForge, loses the first-writer-wins race, and leaves a Google-side orphan. Acceptable per operator policy ("no Google-side cleanup"); flagged here so an implementer doesn't add coordination that isn't needed.
  **Context**: Full module spec, mutex semantics, error-branch table, sanitization rules, and `assertNotStopped()` placement in design doc §"Phase 1 / NEW `extensions/youforge-flow/src/project-mgmt.js`". Forward refs resolved at call time (per leaves-first SW convention): `safeLog`, `assertNotStopped`, `parseFlowApiError`, `makeFlowApiError`, `getAccountToken`, `getProjectUrl`, `postProjectCreated`, `triggerRateLimitCooldown`. The defensive-parsing table is non-negotiable — it is the operator's stated "Google trpc API may drift" risk surface.

- [x] **Task 3.2: Wire project-mgmt into background SW + cleanup hooks**
  **Files**: `extensions/youforge-flow/background.js`, `extensions/youforge-flow/src/messages.js`
  **What**: Add `importScripts('src/project-mgmt.js')` in `background.js` between `src/auth.js` (line 20) and `src/account-tier.js` (line 21). In `messages.js`, add `clearInFlight();` to both the `stopAllProcessing` case (alongside existing `clearCachedTier()`) and the `autoStopped` case. Sanity-check: the messages.js `stopAllProcessing` case currently calls `forceStopAllTabs` and `clearCachedTier` — keep both; just append `clearInFlight();`.
  **Context**: Design doc §"Phase 1 / `extensions/youforge-flow/background.js`" and §"Phase 1 / `extensions/youforge-flow/src/messages.js`".

- [x] **Task 3.3: Add `projectUrl` setting + `postProjectCreated` webhook**
  **Files**: `extensions/youforge-flow/src/settings.js`, `extensions/youforge-flow/src/webhook.js`
  **What**: In `settings.js`: add `projectUrl` to the cache, add `getProjectUrl()`, extend `updateWebhooks(message)` to read `message.projectUrl` (mirror existing pollUrl/resultUrl/statusUrl pattern). In `webhook.js`: add `postProjectCreated({videoId, projectId, projectTitle})` next to `postStatusEvent`. Single `fetchWithTimeout(..., 15_000)` no-retry attempt; if `getProjectUrl()` is empty, log via `safeLog` and skip.
  **Context**: Design doc §"Phase 1 / `extensions/youforge-flow/src/settings.js`" and §"Phase 1 / `extensions/youforge-flow/src/webhook.js`". The single-attempt no-retry posture is intentional — failed posts re-create the project on the next dispatch (Flow-side orphan acceptable per operator policy).

- [x] **Task 3.4: Stale-project-id detection at SW call sites**
  **Files**: `extensions/youforge-flow/src/page-call.js`, `extensions/youforge-flow/flow-api.js`, `__tests__/unit/youforge-flow/page-call.test.ts`
  **What**: Apply the override at **both** call sites (not just one): `page-call.js` `apiCallViaPage` after `parseFlowApiError(fakeResponse, result.body)`, AND `flow-api.js` `_throwFlowApiError` after its `parseFlowApiError` call. In each: if `parsed.httpStatus === 404` AND the request URL matches `/\/projects\/[^/]+\//`, set `parsed.category = 'stale_project_id'` *before* passing to `makeFlowApiError`. Tests: 404 from `/projects/<uuid>/...` → `category === 'stale_project_id'`; 404 from a non-projects URL → category unchanged.
  **Context**: Design doc §"Phase 1 / `src/app/api/flow/submit-result/[token]/route.ts`" — "Stale-project-id recovery" subsection. The override goes at the call site (not in `parseFlowApiError`) because the parser doesn't have the URL in scope.

### Phase 4 — Extension SW: executor switch + auth.js cleanup

- [x] **Task 4.1: Replace `getProjectIdCached` with `getOrCreateProjectId` in executor**
  **Files**: `extensions/youforge-flow/src/executors/index.js`
  **What**: In `buildExecutorContext` (around line 50), replace `const projectId = await getProjectIdCached(tabId);` with `const projectId = await getOrCreateProjectId(task, { tabId });`. Place after `getSessionTokenFromPage` for ordering parity. The existing comment block can be replaced with a short pointer to the design doc.
  **Context**: Design doc §"Phase 1 / `extensions/youforge-flow/src/executors/index.js`". Per the phase-ordering note, this lands after Phase 3 (project-mgmt.js exists) and before Task 4.2 (auth.js still has `getProjectIdCached` at this point — extension stays loadable).

- [x] **Task 4.2: Remove `getProjectIdCached` and its test block**
  **Files**: `extensions/youforge-flow/src/auth.js`, `__tests__/unit/youforge-flow/auth.test.ts`
  **What**: Delete `getProjectIdCached` (line 116) and the four cache vars `cachedProjectId`, `cachedProjectIdUrl`, `cachedProjectIdExpiry`, `PROJECT_ID_TTL_MS` (lines 19-22). Delete the entire `describe("getProjectIdCached", ...)` block at `auth.test.ts:304` (~8 assertions) and the `getProjectIdCached` mock entry at `auth.test.ts:9`. Run `npm run test` after; verify no other tests transitively depend on the helper. Do not touch `getRecaptchaTokenFromPage`, `getSessionTokenFromPage`, `clearAuthCache`, `_isSessionExpiredErrorMessage`.
  **Context**: Design doc §"Phase 1 / `extensions/youforge-flow/src/auth.js`".

### Phase 5 — Extension popup + self-test

- [x] **Task 5.1: Project URL input + Start-button gate**
  **Files**: `extensions/youforge-flow/popup.html`, `extensions/youforge-flow/popup.js`
  **What**: Add a fourth webhook input row labeled "Project URL" alongside the three existing rows (popup.html:24-33). In `popup.js`: extend `saveConfig` to include `projectUrl` in the `updateWebhooks` payload; extend `histforgeOrigin()` (line 140) to include `els.projectUrl.value` in the URL list it walks; extend `refreshEnabled()` (lines 197-205) to add `els.projectUrl.value.trim()` to the `fieldsFilled` check.
  **Context**: Design doc §"Phase 1 / `extensions/youforge-flow/popup.html` + `popup.js`". The `refreshEnabled` gate closes the migration window — operator literally cannot Start without all four URLs.

- [x] **Task 5.2: Self-test 8th check for `projectUrl`**
  **Files**: `extensions/youforge-flow/src/self-test.js`, `__tests__/unit/youforge-flow/self-test.test.ts`
  **What**: After the existing `pingHistForge` triplet (lines 88-90), add `pingHistForge('projectUrl', getProjectUrl, checks)`. Tests: pass when configured + reachable; skip when not configured.
  **Context**: Design doc §"Phase 1 / `extensions/youforge-flow/src/self-test.js`" and §"Phase 1, test plan / Self-test".

### Phase 6 — Documentation + manual verification (ships in PR 1)

- [x] **Task 6.1: Update `docs/setup-google-flow.md`**
  **Files**: `docs/setup-google-flow.md`
  **What**: Add the fourth URL (Project URL → `/api/flow/project/<token>`) to the webhook configuration section; note the Start button is gated on all four; remove/replace the prior instruction to manually open a Flow project tab before pressing Start (no longer required).
  **Context**: Design doc §"Sequencing / Documentation". Currently three webhooks are documented at lines 17-20.
  **Deviation taken during impl**: The dashboard account-creation modal and `POST /api/flow/accounts` only emitted three URLs — operators had no way to copy `projectUrl`. Extended the API to emit `projectUrl` and the modal to display + include it in **Copy all**. Updated `route.test.ts` and `google-flow-accounts.test.tsx` accordingly.

- [ ] **Task 6.2: Manual end-to-end verification before merge**
  **Files**: none (smoke test — record results in the PR description)
  **What**: Run the three checks from the design doc §"Phase 1, test plan / Manual end-to-end checks": (a) one-account, one-video happy path — confirm a Flow project is created and named after the video; (b) two-account, one-video happy path — pause B, dispatch via A → project P_A; resume B + pause A, dispatch → project P_B; confirm two distinct Flow projects exist with the same name; (c) API-drift simulation — temporarily mutate the parser in `project-mgmt.js` to look for a wrong field path; dispatch; verify (i) the `flow_create_project_failed` setting was written via `GET /api/settings` (works because Task 2.3 step 1 registered the key), (ii) the account is paused 24h, (iii) `retry_count` unchanged on the requeued task. (The Phase 7 banner is **not** in scope here — Phase 7 ships in PR 2.)
  **Context**: Vitest covers schema/repo/route correctness; manual checks are the only signal that the trpc envelope and MAIN-world execution work end-to-end against live Google Flow.

### Phase 7 — Dashboard banner for create-project failures (PR 2, ships after PR 1)

- [x] **Task 7.1: `flow_create_project_failed` banner + dismiss endpoint**
  **Files**: `src/app/videos/videos-client.tsx` (the home-dashboard client island; `src/app/page.tsx` redirects to `/videos`), `src/app/videos/page.tsx` (server component — pass the setting through alongside `initialQueueState`), `src/app/api/flow/clear-create-project-failed/route.ts` (NEW), corresponding test files
  **What**: Add a red banner to the videos-list dashboard that reads the `flow_create_project_failed` setting (registered in `SETTING_SCHEMAS` and `DEFAULT_SETTINGS` by Task 2.3 step 1, so already exposed via `getAllSettings` / `GET /api/settings` and readable via `getSetting()` server-side from `videos/page.tsx`). The setting value is JSON of shape `{errorCode, httpStatus, taskId, when, accountId}` written by Task 2.3 — parse it and surface `errorCode`, `when` (timestamp), and `accountId` in the banner per the design-doc copy. Dismiss button calls `POST /api/flow/clear-create-project-failed`, which sets the setting to "" — **no token gate** (dashboard-internal route, same posture as `/api/flow/accounts`). Tests: route clears the setting; banner renders/hides correctly on setting state; banner gracefully handles malformed JSON (defensive parse).
  **Context**: Design doc §"Phase 3". Independent of PR 1's schema changes — can ship any time after PR 1 lands. The JSON shape is shared with Task 2.3 — keep them in sync if either changes. Do **not** include `google_flow_relogin_needed` in this banner; that flag is currently surfaced as a read-only field in `src/app/settings/settings-form.tsx:50-52` and conflating the two would muddle the operator's mental model (rationale at the start of design-doc §"Phase 3").

## References

- **Primary design doc**: `docs/plans/2026-04-25-per-video-flow-projects.md` — read this for *all* "why" decisions, the race-condition analysis (§"Phase 1, race-condition analysis"), full error-taxonomy table, captured trpc envelopes, and the deleteProject appendix.
- HistForge spec: `docs/histforge-spec.md`
- Operator-facing setup: `docs/setup-google-flow.md` (updated in Task 6.1)
