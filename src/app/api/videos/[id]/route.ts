import { NextResponse } from "next/server";
import { z } from "zod";
import { join } from "node:path";
import { getDb } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { listProjectFiles } from "@/lib/project-files";
import * as videosRepo from "@/lib/repos/videos";
import * as stepsRepo from "@/lib/repos/steps";
import * as videoLifecycle from "@/lib/lifecycle/video";
import { getWorkflowFromDb } from "@/lib/workflows";
import { getVisualStyleFromDb } from "@/lib/visual-styles";
import { applyReadyScriptArtifacts } from "@/lib/ready-script";

interface RouteCtx {
  params: { id: string };
}

function projectsDirPath(): string {
  return process.env.PROJECTS_DIR ?? "./projects";
}

export async function GET(
  _req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const db = getDb();
  const video = videosRepo.findById(db, ctx.params.id);
  if (!video) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const steps = stepsRepo.findByVideo(db, ctx.params.id);

  const projectDir = join(projectsDirPath(), ctx.params.id);
  const artifacts = listProjectFiles(projectDir);

  const workflow = getWorkflowFromDb(db, video.workflow_id);
  const workflow_label = workflow?.label ?? video.workflow_id;

  return NextResponse.json({
    video,
    steps,
    artifacts,
    workflow_label,
    queueState: getSetting("queue_state", db),
    flowServiceOverloadUntil: getSetting("flow_service_overload_until", db),
  });
}

const PatchVideoSchema = z
  .object({
    title: z.string().min(1).optional(),
    topic_info: z.string().min(1).optional(),
    workflow_id: z.string().min(1).optional(),
    provided_script: z.string().min(1).optional(),
    visual_style_id: z.string().nullable().optional(),
    // Kind is immutable post-create (ADR-0011 §Decision 1). Accepted here
    // only as a sanity check — if present, it must match the row's stored
    // kind, otherwise the handler returns 400 kind_immutable.
    kind: z.enum(["narrative", "music_video"]).optional(),
    magnific_image_prompt: z.string().min(1).optional(),
    suno_style_prompt: z.string().min(1).optional(),
    song_count: z.number().int().min(1).max(30).optional(),
    repeat_factor: z.number().int().min(1).max(10).optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.topic_info !== undefined ||
      v.workflow_id !== undefined ||
      v.provided_script !== undefined ||
      v.visual_style_id !== undefined ||
      v.magnific_image_prompt !== undefined ||
      v.suno_style_prompt !== undefined ||
      v.song_count !== undefined ||
      v.repeat_factor !== undefined,
    { message: "at least one field required" }
  );

// Per-kind field allowlists for the PATCH kind-scoping rule (ADR-0011
// §Decision 1). A narrative row may not be patched with music-video
// fields and vice versa.
const NARRATIVE_ONLY_FIELDS = [
  "topic_info",
  "provided_script",
  "visual_style_id",
] as const;
const MUSIC_VIDEO_ONLY_FIELDS = [
  "magnific_image_prompt",
  "suno_style_prompt",
  "song_count",
  "repeat_factor",
] as const;

export async function PATCH(
  req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const db = getDb();
  const video = videosRepo.findById(db, ctx.params.id);
  if (!video) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (video.status !== "new" && video.status !== "queued") {
    return NextResponse.json(
      {
        error: "not_editable",
        message:
          "Only videos that have not started generating can be edited.",
      },
      { status: 409 }
    );
  }
  const parsed = PatchVideoSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  if (parsed.data.kind !== undefined && parsed.data.kind !== video.kind) {
    return NextResponse.json(
      {
        error: "kind_immutable",
        message: `Cannot change kind of an existing video (stored kind="${video.kind}").`,
      },
      { status: 400 }
    );
  }
  const forbiddenFields =
    video.kind === "music_video"
      ? NARRATIVE_ONLY_FIELDS
      : MUSIC_VIDEO_ONLY_FIELDS;
  for (const field of forbiddenFields) {
    if (parsed.data[field] !== undefined) {
      return NextResponse.json(
        {
          error: "kind_field_mismatch",
          message: `Field "${field}" is not valid for kind="${video.kind}".`,
        },
        { status: 400 }
      );
    }
  }
  if (parsed.data.workflow_id !== undefined) {
    const workflow = getWorkflowFromDb(db, parsed.data.workflow_id);
    if (!workflow) {
      return NextResponse.json(
        {
          error: "workflow_not_found",
          message: `Workflow "${parsed.data.workflow_id}" is not registered.`,
        },
        { status: 400 }
      );
    }
    if (workflow.enabled !== 1) {
      return NextResponse.json(
        {
          error: "workflow_disabled",
          message: `Workflow "${parsed.data.workflow_id}" is disabled.`,
        },
        { status: 400 }
      );
    }
    if (workflow.kind !== video.kind) {
      return NextResponse.json(
        {
          error: "workflow_kind_mismatch",
          message: `Workflow "${parsed.data.workflow_id}" is kind="${workflow.kind}" but the video is kind="${video.kind}".`,
        },
        { status: 400 }
      );
    }
  }
  if (
    parsed.data.visual_style_id !== undefined &&
    parsed.data.visual_style_id !== null
  ) {
    const style = getVisualStyleFromDb(db, parsed.data.visual_style_id);
    if (!style) {
      return NextResponse.json(
        {
          error: "visual_style_not_found",
          message: `Visual style "${parsed.data.visual_style_id}" is not registered.`,
        },
        { status: 400 }
      );
    }
  }

  videosRepo.updateVideoDraft(db, ctx.params.id, parsed.data);

  // Resync rule: when a queued ready-script video has its provided_script
  // patched, the on-disk full_script.md must follow. For status='new' the
  // disk write happens at queue time (start route, Task 1.5), so nothing
  // extra here. The helper is idempotent, so re-running on an already-
  // prepped video safely overwrites + INSERT-OR-IGNOREs the done rows.
  if (
    parsed.data.provided_script !== undefined &&
    video.status === "queued"
  ) {
    applyReadyScriptArtifacts(db, ctx.params.id);
  }

  const updated = videosRepo.findById(db, ctx.params.id);
  return NextResponse.json({ video: updated });
}

export async function DELETE(
  _req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const db = getDb();
  const video = videosRepo.findById(db, ctx.params.id);
  if (!video) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // in_progress: defer to the orchestrator's between-steps hook.
  if (video.status === "in_progress") {
    videosRepo.setDeleteRequested(db, ctx.params.id);
    return NextResponse.json({ ok: true, deferred: true }, { status: 202 });
  }

  // new / queued / failed / done: files (if any) + rows. `deleteFully`
  // rmSyncs with force:true so a `new` video that never wrote a project
  // dir is a safe no-op on the FS side.
  videoLifecycle.deleteFully(db, ctx.params.id, projectsDirPath());
  return NextResponse.json({ ok: true });
}
