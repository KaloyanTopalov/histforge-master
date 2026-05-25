import { NextResponse } from "next/server";
import { z } from "zod";
import { ulid } from "ulid";
import { getDb } from "@/lib/db";
import * as videosRepo from "@/lib/repos/videos";
import {
  getVideosPageState,
  type VideosPageState,
} from "@/lib/videos-page-state";
import { getWorkflowFromDb } from "@/lib/workflows";
import { getVisualStyleFromDb } from "@/lib/visual-styles";

// Wire shape for `GET /api/videos`. The Flow operator flags (raw
// `flowCreateProjectFailed`, coerced `googleFlowReloginNeeded`) ride
// alongside the videos so the existing videos-client poller picks them
// up within POLL_MS — without this, an incident is invisible to an
// operator already viewing /videos until they hard-navigate.
export type VideosListResponse = VideosPageState;

export async function GET(): Promise<NextResponse> {
  const payload: VideosListResponse = getVideosPageState(getDb());
  return NextResponse.json(payload);
}

const NarrativeCreateSchema = z
  .object({
    kind: z.literal("narrative"),
    title: z.string().min(1),
    topic_info: z.string().min(1),
    workflow_id: z.string().min(1),
    provided_script: z.string().min(1).optional(),
    visual_style_id: z.string().nullable().optional(),
  })
  .strict();

const MusicVideoCreateSchema = z
  .object({
    kind: z.literal("music_video"),
    title: z.string().min(1),
    workflow_id: z.string().min(1),
    magnific_image_prompt: z.string().min(1),
    magnific_motion_prompt: z.string().min(1),
    suno_style_prompt: z.string().min(1),
    song_count: z.number().int().min(1).max(30),
    repeat_factor: z.number().int().min(1).max(10),
  })
  .strict();

// Backward compat: payloads omitting `kind` default to `narrative` so the
// existing AddVideoModal (which has no `kind` field) round-trips cleanly.
// Same preprocess pattern as `WorkflowRowSchema` in workflows-schema.ts —
// `z.discriminatedUnion` cannot carry a default on the discriminator, so the
// preprocess is the only way to honor pre-kind payloads.
const CreateVideoSchema = z.preprocess((input) => {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    if (!("kind" in obj) || obj.kind === undefined) {
      return { ...obj, kind: "narrative" };
    }
  }
  return input;
}, z.discriminatedUnion("kind", [NarrativeCreateSchema, MusicVideoCreateSchema]));

export async function POST(req: Request): Promise<NextResponse> {
  const parsed = CreateVideoSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const db = getDb();
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
  if (workflow.kind !== parsed.data.kind) {
    return NextResponse.json(
      {
        error: "workflow_kind_mismatch",
        message: `Workflow "${parsed.data.workflow_id}" is kind="${workflow.kind}" but the payload is kind="${parsed.data.kind}".`,
      },
      { status: 400 }
    );
  }

  const id = ulid();
  const now = Date.now();

  if (parsed.data.kind === "music_video") {
    videosRepo.createNewVideo(db, {
      id,
      title: parsed.data.title,
      workflow_id: parsed.data.workflow_id,
      kind: "music_video",
      magnific_image_prompt: parsed.data.magnific_image_prompt,
      magnific_motion_prompt: parsed.data.magnific_motion_prompt,
      suno_style_prompt: parsed.data.suno_style_prompt,
      song_count: parsed.data.song_count,
      repeat_factor: parsed.data.repeat_factor,
      created_at: now,
    });
  } else {
    const visualStyleId = parsed.data.visual_style_id ?? null;
    if (visualStyleId !== null) {
      const style = getVisualStyleFromDb(db, visualStyleId);
      if (!style) {
        return NextResponse.json(
          {
            error: "visual_style_not_found",
            message: `Visual style "${visualStyleId}" is not registered.`,
          },
          { status: 400 }
        );
      }
    }
    videosRepo.createNewVideo(db, {
      id,
      title: parsed.data.title,
      topic_info: parsed.data.topic_info,
      workflow_id: parsed.data.workflow_id,
      kind: "narrative",
      provided_script: parsed.data.provided_script ?? null,
      visual_style_id: visualStyleId,
      created_at: now,
    });
  }

  const video = videosRepo.findById(db, id);
  return NextResponse.json({ video }, { status: 201 });
}
