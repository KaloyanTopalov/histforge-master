import { NextResponse } from "next/server";
import { z } from "zod";
import { getSetting, type SettingValue } from "@/lib/settings";
import { resolveFlowAccount } from "@/lib/flow-auth";
import * as gfRepo from "@/lib/repos/google-flow";
import * as flowLifecycle from "@/lib/lifecycle/flow";
import { resolveHookVideoModelKey } from "@/lib/video/google-flow-models";
import type { GoogleFlowQueueItem, Video } from "@/types";

interface RouteCtx {
  params: { token: string };
}

const TaskRequestSchema = z.object({
  type: z.literal("TaskRequest"),
  accountToken: z.string().min(1),
  mode: z.string().min(1),
  // The extension declares which concurrency bucket it has free slots
  // for; the dispatcher narrows the claim to matching modes. Omitted by
  // pre-bucket-split extensions — absence means "any mode" (legacy
  // behaviour). The `mode` field above is a separate legacy carry-over
  // and stays a no-op.
  wantBucket: z.enum(["image", "video"]).optional(),
});

interface DispatchExtras {
  flowProjectId: string | null;
  imageModel: SettingValue<"google_flow_image_model">;
  // For clip rows this is the variant model key resolved from the
  // base model × `google_flow_hook_clip_seconds`; for non-clip rows this
  // is the raw base model string. Both forms are valid Veo videoModelKey
  // values, so the field stays a string at the DTO boundary.
  videoModel: string;
  // Per-request URL pieces used to project `row.reference_image` (a
  // path under the per-video project root) into an absolute artifact
  // URL the youforge-flow extension can GET. Origin comes from the
  // incoming request; token is the URL [token] segment the route was
  // already verifying for body-auth.
  origin: string;
  token: string;
}

/**
 * Shape the dispatched row for the extension. Upstream's outer gate at
 * background.js:1836 short-circuits on `task && task.id && task.prompt`,
 * so `prompt` is present on every mode. `createImage` additionally
 * requires `imagePrompt` for the per-mode validator; HistForge stores
 * one prompt per task, so we duplicate it into both fields.
 *
 * Mode-specific fields are included unconditionally — even if the DB
 * column is null. A null value here means the row was enqueued
 * incorrectly (e.g. mode=image with no reference_image); surfacing
 * it to the extension validator produces a loud, debuggable failure
 * rather than a silently malformed task.
 *
 * `imageModel` and `videoModel` are also emitted on every mode (not
 * gated by `row.mode`): the executor that runs picks whichever field
 * it needs, and emitting both keeps mode-switching dispatches simple.
 */
function shapeTaskForExtension(
  row: GoogleFlowQueueItem,
  video: Video,
  extras: DispatchExtras
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row.external_task_id,
    prompt: row.prompt,
    mode: row.mode,
    videoId: row.video_id,
    projectTitle: video.title,
    flowProjectId: extras.flowProjectId,
    imageModel: extras.imageModel,
    // For clip rows this carries the variant key (e.g.
    // `veo_3_1_t2v_quality_4s`); for non-clip rows it's the raw base model.
    videoModel: extras.videoModel,
  };
  if (row.mode === "createImage") {
    out.imagePrompt = row.prompt;
    // Character-lock plumbing (Phase A step 3): when the worker found
    // a per-video character reference image at enqueue time, emit it
    // as an absolute artifact URL. The youforge-flow image executor
    // reads `task.referenceImage`, `uploadImage`s it, and attaches the
    // resulting media to `imageInputs` for the Flow request.
    //
    // The URL is bound to (account_token, external_task_id) — the
    // artifact route verifies the calling account owns the dispatched
    // task before serving its reference. No `videoId`/`path` query
    // params are exposed, so a holder of one account token can't fetch
    // another account's task artifacts.
    if (row.reference_image !== null) {
      out.referenceImage = `${extras.origin}/api/flow/artifact/${extras.token}/${row.external_task_id}`;
    }
  }
  if (row.mode === "image") {
    out.referenceImage = row.reference_image;
  }
  if (row.mode === "frames") {
    out.startFrame = row.start_frame;
    out.endFrame = row.end_frame;
  }
  // Resume hint: only emitted when the row already carries a Google
  // operation id, signalling the SW to skip submit and poll the
  // existing operation. Omitted (not null'd) on fresh dispatches so a
  // truthy check on the SW side cleanly discriminates the two paths.
  if (row.google_operation_id !== null) {
    out.googleOperationId = row.google_operation_id;
    out.googleOperationProjectId = row.google_operation_project_id;
  }
  return out;
}

export async function POST(
  req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const auth = await resolveFlowAccount(req, ctx, TaskRequestSchema, {
    requireEnabled: true,
  });
  if (!auth.ok) return auth.response;
  const { account, db, now, parsed } = auth;

  // Dispatch gates, in order:
  //   1. queue_state="paused" — global, hand out no new work.
  //   2. recovery_reason !== null — operator-gated recovery (ADR-0003).
  //      No Retry-After: the flag can't clear with elapsed time, so an
  //      HTTP hint would be misleading. The extension's polling cadence
  //      throttles anyway, and the dashboard surfaces the actual reason
  //      via the badge and banner.
  //   3. paused_until > now — time-based account pause. Has Retry-After
  //      so the extension can back off until the cooldown elapses.
  // The recovery gate sits BEFORE the time-pause clearance so a stale
  // past paused_until cannot trigger the resume-and-claim path while
  // recovery_reason is still set ("first match wins" per ADR §4).
  if (getSetting("queue_state", db) === "paused") {
    return new NextResponse(JSON.stringify({}), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  }

  if (account.recovery_reason !== null) {
    return new NextResponse(JSON.stringify({}), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  }

  if (account.paused_until !== null && account.paused_until > now) {
    return new NextResponse(JSON.stringify({}), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "Retry-After": String(account.paused_until - now),
      },
    });
  }

  const claimed = flowLifecycle.claimNextTask(db, account, now, parsed.wantBucket);
  if (!claimed) return NextResponse.json({});

  // Response-shaping reads — outside the claim txn. The dispatched row
  // identity is already locked in; these reads just decorate the DTO.
  // Per-dispatch (not per-enqueue) lookup means an operator setting
  // change takes effect on the next dispatch with no queue-schema
  // migration.
  const project = gfRepo.findFlowProjectForAccount(
    db,
    claimed.row.video_id,
    account.id
  );
  const baseVideoModel = getSetting("google_flow_video_model", db);
  // Clip rows additionally resolve the (base model, clip seconds) pair
  // into a Veo variant key; non-clip rows pass the base model through.
  // Veo encodes clip duration into the videoModelKey itself.
  const videoModel =
    claimed.row.kind === "clip"
      ? resolveHookVideoModelKey(
          baseVideoModel,
          getSetting("google_flow_hook_clip_seconds", db)
        )
      : baseVideoModel;
  const extras: DispatchExtras = {
    flowProjectId: project?.flow_project_id ?? null,
    imageModel: getSetting("google_flow_image_model", db),
    videoModel,
    origin: new URL(req.url).origin,
    token: ctx.params.token,
  };

  return NextResponse.json(
    shapeTaskForExtension(claimed.row, claimed.video, extras)
  );
}
