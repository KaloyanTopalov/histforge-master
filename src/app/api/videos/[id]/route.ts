import { NextResponse } from "next/server";
import { z } from "zod";
import { join } from "node:path";
import { getDb } from "@/lib/db";
import {
  getImageChunkPacing,
  getSetting,
  ImageChunkPacingInvariantError,
} from "@/lib/settings";
import type { Database as DatabaseType } from "better-sqlite3";
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
    // Per-video pacing overrides for chunk_images_only (step 08). Ranges
    // mirror the matching global settings in src/lib/settings.ts. `null`
    // clears the column so the resolver falls through to the global on
    // the next read; `undefined` (key absent) leaves the column alone.
    image_chunk_target_seconds: z
      .number()
      .int()
      .min(2)
      .max(60)
      .nullable()
      .optional(),
    image_chunk_min_seconds: z
      .number()
      .int()
      .min(2)
      .max(20)
      .nullable()
      .optional(),
    image_chunk_max_seconds: z
      .number()
      .int()
      .min(4)
      .max(60)
      .nullable()
      .optional(),
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
      v.repeat_factor !== undefined ||
      v.image_chunk_target_seconds !== undefined ||
      v.image_chunk_min_seconds !== undefined ||
      v.image_chunk_max_seconds !== undefined,
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

  // Resolved-pacing invariant. The Zod schema validates each field in
  // isolation; the `min ≤ target ≤ max` check has to run against the
  // merged (row ∪ patch) triple because per-video columns can be NULL
  // and fall through to the globals. Catching the partial-patch trap:
  // PATCH { min: 10 } on a row whose `target` column is NULL with a
  // global target=8 would silently pass body-only validation but break
  // the chunker at step entry. Reuses the same getImageChunkPacing
  // resolver the chunker calls, so the route and the worker can never
  // disagree about what counts as a valid triple.
  if (
    parsed.data.image_chunk_target_seconds !== undefined ||
    parsed.data.image_chunk_min_seconds !== undefined ||
    parsed.data.image_chunk_max_seconds !== undefined
  ) {
    const merged = {
      image_chunk_target_seconds:
        parsed.data.image_chunk_target_seconds !== undefined
          ? parsed.data.image_chunk_target_seconds
          : video.image_chunk_target_seconds,
      image_chunk_min_seconds:
        parsed.data.image_chunk_min_seconds !== undefined
          ? parsed.data.image_chunk_min_seconds
          : video.image_chunk_min_seconds,
      image_chunk_max_seconds:
        parsed.data.image_chunk_max_seconds !== undefined
          ? parsed.data.image_chunk_max_seconds
          : video.image_chunk_max_seconds,
    };
    try {
      getImageChunkPacing(merged, db);
    } catch (e) {
      if (e instanceof ImageChunkPacingInvariantError) {
        return NextResponse.json(
          {
            error: "image_chunk_pacing_invariant",
            message: e.message,
            sources: {
              target: pacingSource(
                "image_chunk_target_seconds",
                parsed.data,
                video,
                db
              ),
              min: pacingSource(
                "image_chunk_min_seconds",
                parsed.data,
                video,
                db
              ),
              max: pacingSource(
                "image_chunk_max_seconds",
                parsed.data,
                video,
                db
              ),
            },
          },
          { status: 400 }
        );
      }
      throw e;
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

type PacingColumn =
  | "image_chunk_target_seconds"
  | "image_chunk_min_seconds"
  | "image_chunk_max_seconds";

interface PacingSourceInfo {
  source: "request" | "column" | "global";
  value: number;
}

/**
 * Reports where the resolver picked up each pacing component so a 400
 * response can name the operator-visible knob (request body, per-video
 * column, or global setting) that contributed the failing value.
 */
function pacingSource(
  column: PacingColumn,
  patch: { [K in PacingColumn]?: number | null },
  video: { [K in PacingColumn]: number | null },
  db: DatabaseType
): PacingSourceInfo {
  const patched = patch[column];
  if (patched !== undefined && patched !== null) {
    return { source: "request", value: patched };
  }
  // `null` in the patch explicitly clears the column → falls through
  // to global, same as if the patch key were absent and the column was
  // already NULL.
  if (patched === undefined && video[column] !== null) {
    return { source: "column", value: video[column] as number };
  }
  return { source: "global", value: getSetting(column, db) };
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
