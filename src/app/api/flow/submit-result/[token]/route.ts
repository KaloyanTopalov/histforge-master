import { NextResponse } from "next/server";
import { z } from "zod";
import type { Database as DatabaseType } from "better-sqlite3";
import { getSetting } from "@/lib/settings";
import { resolveFlowAccount } from "@/lib/flow-auth";
import * as gfRepo from "@/lib/repos/google-flow";
import * as flowLifecycle from "@/lib/lifecycle/flow";
import {
  downloadToProjectPath,
  isAllowedResultHost,
} from "@/lib/flow-media";
import { classifyError } from "@/lib/flow-error-classify";
import type { GoogleFlowAccount, GoogleFlowQueueItem } from "@/types";

interface RouteCtx {
  params: { token: string };
}

/**
 * This route does NOT gate on account.enabled: a disabled account may
 * still have in-flight dispatched rows, and rejecting their results
 * would waste the compute we already paid for. All outcomes return
 * `{success: true}` (+ optional `duplicate`) — the extension treats
 * `success: false` as a retry trigger (upstream background.js:2247-2282)
 * and we never want retry storms.
 */
const ResultSubmissionSchema = z.object({
  type: z.literal("ResultSubmission"),
  accountToken: z.string().min(1),
  taskId: z.string().min(1),
  resultUrl: z.string().optional(),
  mode: z.string().min(1),
  error: z.string().optional(),
  mediaFiles: z.unknown().optional(),
  timestamp: z.string(),
  // v2 envelope fields the SW emits via webhook.js:226-243. All optional
  // for back-compat; `errorCategory` is the dispatch key consumed by
  // handleError below.
  errorCode: z.string().nullish(),
  errorCategory: z.string().nullish(),
  httpStatus: z.number().nullish(),
  retryable: z.boolean().nullish(),
  contentPolicyTag: z.string().nullish(),
  correlationId: z.string().nullish(),
  timings: z.unknown().optional(),
  schemaVersion: z.number().optional(),
});

type ResultSubmission = z.infer<typeof ResultSubmissionSchema>;

function projectsDirPath(): string {
  return process.env.PROJECTS_DIR ?? "./projects";
}

/**
 * Peel off the first URL from a comma-separated list. The extension
 * sends multiple URLs only for multi-output modes (we enqueue
 * outputCount=1 in v1, so there's really only ever one). data: URLs
 * legitimately contain a comma inside the encoding marker, so they're
 * passed through untouched — splitting would turn them into garbage.
 */
function firstResultUrl(raw: string): string {
  if (raw.startsWith("data:")) return raw;
  return raw.split(",")[0]?.trim() ?? "";
}

interface HandlerArgs {
  task: GoogleFlowQueueItem;
  account: GoogleFlowAccount;
  errorText: string;
  parsed?: ResultSubmission;
}

type CategoryHandler = (db: DatabaseType, args: HandlerArgs) => void;

function handleCreateProjectFailed(db: DatabaseType, args: HandlerArgs): void {
  const now = Math.floor(Date.now() / 1000);
  const flagPayload = JSON.stringify({
    errorCode: args.parsed?.errorCode ?? null,
    httpStatus: args.parsed?.httpStatus ?? null,
    taskId: args.parsed?.taskId ?? null,
    when: now,
    accountId: args.account.id,
  });
  flowLifecycle.handleCreateProjectFailed(
    db,
    args.task.id,
    args.account.id,
    now + 24 * 3600,
    flagPayload
  );
}

function handleAuth(db: DatabaseType, args: HandlerArgs): void {
  // The SW's notifySessionExpired StatusEvent already set
  // google_flow_relogin_needed via the status route. Intentionally a
  // no-op on that flag — just requeue without bumping retry budget.
  gfRepo.requeueTask(db, args.task.id);
}

function handleStaleProjectId(db: DatabaseType, args: HandlerArgs): void {
  const accountId = args.task.assigned_account_id ?? args.account.id;
  flowLifecycle.handleStaleProjectId(
    db,
    args.task.id,
    args.task.video_id,
    accountId
  );
}

function handleQuota(db: DatabaseType, args: HandlerArgs): void {
  const cooldownH = getSetting("google_flow_account_cooldown_hours", db);
  const now = Math.floor(Date.now() / 1000);
  flowLifecycle.handleQuota(
    db,
    args.task.id,
    args.account.id,
    now + cooldownH * 3600
  );
}

function handleServiceOverload(db: DatabaseType, args: HandlerArgs): void {
  const cooldownM = getSetting(
    "google_flow_service_overload_cooldown_minutes",
    db
  );
  const now = Math.floor(Date.now() / 1000);
  const pauseUntil = now + cooldownM * 60;
  flowLifecycle.handleServiceOverload(
    db,
    args.task.id,
    args.account.id,
    pauseUntil
  );
}

function handleCaptcha(db: DatabaseType, args: HandlerArgs): void {
  const now = Math.floor(Date.now() / 1000);
  flowLifecycle.handleCaptcha(db, args.task.id, args.account.id, now);
}

function handleTransient(db: DatabaseType, args: HandlerArgs): void {
  const max = getSetting("google_flow_max_retries", db);
  flowLifecycle.handleTransient(db, args.task, args.errorText, max);
}

function handleContentPolicy(db: DatabaseType, args: HandlerArgs): void {
  // Permanent fail — content-policy hits won't succeed on retry, and
  // the account is fine to keep using for other work.
  gfRepo.failTask(db, args.task.id, args.errorText);
}

// V2 envelope dispatch — keys match the `errorCategory` strings the SW
// emits via webhook.js. Adding a new SW category means adding an entry
// here.
const CATEGORY_HANDLERS: Record<string, CategoryHandler> = {
  create_project_failed: handleCreateProjectFailed,
  auth: handleAuth,
  stale_project_id: handleStaleProjectId,
  rate_limit: handleQuota,
  service_overload: handleServiceOverload,
  transient: handleTransient,
};

// Legacy free-form classifier dispatch — fallback when the v2 envelope
// is absent (synthetic callers) or its category isn't recognized.
// `classifyError` returns exactly
// `content_policy | quota | transient | captcha`.
const LEGACY_HANDLERS: Record<string, CategoryHandler> = {
  content_policy: handleContentPolicy,
  quota: handleQuota,
  service_overload: handleServiceOverload,
  transient: handleTransient,
  captcha: handleCaptcha,
};

/**
 * Multi-write handlers run as one atomic transaction so partial state
 * (e.g. account paused but task not requeued) can't survive a mid-
 * handler crash; single-statement handlers rely on SQLite's per-
 * statement atomicity.
 *
 * Dispatch ordering:
 *   (0) captcha override on errorText — the extension's
 *       parseFlowApiError maps every HTTP 403 to `errorCategory: 'auth'`
 *       (extensions/youforge-flow/src/flow-error.js), so RECAPTCHA
 *       failures arrive labeled 'auth' and would otherwise be silently
 *       requeued by handleAuth. The override gives the legacy
 *       classifier's `captcha` verdict precedence over v2 dispatch so
 *       the account gets flagged for operator-gated recovery.
 *   (1) v2 errorCategory — the SW envelope sets `parsed.errorCategory`;
 *       when present and registered in CATEGORY_HANDLERS we dispatch on
 *       it directly.
 *   (2) legacy classifier — synthetic call sites (download failure,
 *       empty submission) pass only `errorText` and have no v2
 *       envelope; an unknown v2 category also falls through here so a
 *       quota-shaped errorText still routes to quota even when the SW
 *       labelled it something we don't recognize.
 *   (3) handleTransient fallback.
 */
function handleError(db: DatabaseType, args: HandlerArgs): void {
  const legacyClass = classifyError(args.errorText);
  if (legacyClass === "captcha") {
    handleCaptcha(db, args);
    return;
  }
  const v2Handler = args.parsed?.errorCategory
    ? CATEGORY_HANDLERS[args.parsed.errorCategory]
    : undefined;
  const legacyHandler = LEGACY_HANDLERS[legacyClass];
  const handler = v2Handler ?? legacyHandler ?? handleTransient;
  handler(db, args);
}

/**
 * Download the result into the video's project dir and mark the task
 * done. Download failures are surfaced to the caller, which routes
 * them through the retry pipeline so rows can't sit stuck.
 *
 * The download is async and happens outside any DB transaction; only
 * the post-download `completeTask` write is a single statement
 * (inherently atomic).
 */
async function acceptResult(
  db: DatabaseType,
  args: { task: GoogleFlowQueueItem; resultUrl: string }
): Promise<void> {
  const first = firstResultUrl(args.resultUrl);
  if (!isAllowedResultHost(first)) {
    gfRepo.failTask(db, args.task.id, `invalid result host: ${first}`);
    return;
  }
  await downloadToProjectPath(
    args.task.video_id,
    args.task.output_path,
    first,
    projectsDirPath(),
    isAllowedResultHost
  );
  gfRepo.completeTask(
    db,
    args.task.id,
    first,
    Math.floor(Date.now() / 1000)
  );
}

export async function POST(
  req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const auth = await resolveFlowAccount(req, ctx, ResultSubmissionSchema);
  if (!auth.ok) return auth.response;
  const { account, parsed, db } = auth;

  const task = gfRepo.findTaskByExternalId(db, parsed.taskId);
  if (!task) {
    // Stale submission — row has since been requeued and reclaimed.
    return NextResponse.json({ success: true, duplicate: true });
  }

  if (task.status === "done") {
    return NextResponse.json({ success: true, duplicate: true });
  }

  // Salvage: the reaper gave up on this row but the extension actually
  // finished the work. Accept the result — don't discard the compute.
  if (task.status === "failed") {
    if (parsed.resultUrl) {
      try {
        await acceptResult(db, { task, resultUrl: parsed.resultUrl });
        console.log(
          `[flow] salvaged failed task ${task.id} (ext=${task.external_task_id}) → done via ${parsed.accountToken.slice(-4)}`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(
          `[flow] salvage of failed task ${task.id} failed to download: ${msg}`
        );
      }
    }
    return NextResponse.json({ success: true });
  }

  // task is dispatched or pending (reaper may have requeued) — both
  // are state-tolerant entry points.
  if (parsed.error) {
    handleError(db, { task, account, errorText: parsed.error, parsed });
    return NextResponse.json({ success: true });
  }

  if (parsed.resultUrl) {
    try {
      await acceptResult(db, { task, resultUrl: parsed.resultUrl });
    } catch (err) {
      // Download failure routes through the retry pipeline so the row
      // doesn't sit stuck in dispatched.
      const msg = err instanceof Error ? err.message : String(err);
      handleError(db, {
        task,
        account,
        errorText: `download_failed: ${msg}`,
      });
    }
    return NextResponse.json({ success: true });
  }

  // No error and no resultUrl — treat as transient so the row
  // doesn't sit in dispatched forever.
  handleError(db, {
    task,
    account,
    errorText: "empty submission (no error, no resultUrl)",
  });
  return NextResponse.json({ success: true });
}
