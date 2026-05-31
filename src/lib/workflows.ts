import type { Database as DatabaseType } from "better-sqlite3";
import type { WorkflowRow, WorkflowSnapshot } from "@/types";
import * as workflowsRepo from "@/lib/repos/workflows";

// Re-export the seed table so callers (e.g., the reset endpoint) consume
// it via the lib boundary rather than reaching into `lib/db.ts`. The
// canonical definition lives in `lib/db.ts` because the seeder uses it.
export { BUILTIN_WORKFLOWS, type SeedWorkflow } from "@/lib/db";

/**
 * Public lib-layer boundary for the workflow registry. API routes,
 * server pages, and worker code go through these helpers; the repo
 * module (`lib/repos/workflows.ts`) is internal.
 *
 * `materializeStepList` emits the unified `generate_images` /
 * `generate_clips` module slugs directly; runtime dispatch happens via
 * `ctx.imageProvider` / `ctx.videoProvider` (the image / video registries).
 * The pre-Phase-5 provider→slug mapping table (README Invariant A) is gone.
 *
 * The chunker slot is variant — `snapshot.chunker_step` picks one of
 * `chunk_clips_then_images` / `chunk_images_only` / `chunk_clips_only`
 * and the chunker decides which `Chunk.kind` values land in chunks.json,
 * which the image / video module steps filter on.
 */

export function getWorkflowFromDb(
  db: DatabaseType,
  id: string
): WorkflowRow | null {
  return workflowsRepo.findById(db, id);
}

export function listWorkflows(db: DatabaseType): WorkflowRow[] {
  return workflowsRepo.list(db);
}

/**
 * Resolve a workflow row + its step list into the JSON-shape snapshot
 * stored on `videos.workflow_snapshot`. Throws on unknown id — the FK on
 * greenfield DBs catches this too, but throwing earlier yields a better
 * error than a generic FK violation.
 *
 * Reads two tables, so callers must wrap in `db.transaction(...)` to
 * avoid a torn read if a workflow edit interleaves between the two
 * queries (Phase 2 introduces edit paths; Phase 1 has no such writers).
 */
export function resolveSnapshot(
  db: DatabaseType,
  workflow_id: string
): WorkflowSnapshot {
  const row = workflowsRepo.findById(db, workflow_id);
  if (!row) {
    throw new Error(`Unknown workflow "${workflow_id}"`);
  }
  const stepRows = workflowsRepo.findStepsByWorkflow(db, workflow_id);
  return {
    workflow_id: row.id,
    version: row.version,
    kind: row.kind,
    script_llm_provider: row.script_llm_provider,
    tts_provider: row.tts_provider,
    image_provider: row.image_provider,
    video_provider: row.video_provider,
    music_provider: row.music_provider,
    upscaler_provider: row.upscaler_provider,
    chunker_step: row.chunker_step,
    image_style: row.image_style ?? null,
    steps: stepRows.map((s) => ({ step_name: s.step_name })),
  };
}

/**
 * Convenience over `resolveSnapshot` — returns the JSON string for
 * direct insertion into `videos.workflow_snapshot`. Used by the four
 * lifecycle hooks in `lib/repos/videos.ts` (Invariant B).
 */
export function computeSnapshot(
  db: DatabaseType,
  workflow_id: string
): string {
  return JSON.stringify(resolveSnapshot(db, workflow_id));
}

/**
 * Step-list emitted for `snapshot.kind === 'music_video'`. Fixed
 * six-step backbone — no script chain, no chunker, no narrative render,
 * no cleanup. Per ADR-0011 §Decision 2, this list is hard-coded here
 * (the only kind-switching site); downstream consumers (orchestrator,
 * queue picker, lifecycle module) stay kind-agnostic.
 */
const MUSIC_VIDEO_STEPS: readonly string[] = [
  "generate_loop_image",
  "generate_loop_clip",
  "make_thumbnail",
  "generate_music",
  "download_music",
  "render_music_video",
];

/**
 * Expand a snapshot into the full step-slug list the orchestrator
 * iterates. The snapshot stores only the user-authored script-module
 * steps; everything else (glue + module steps) is inserted here per the
 * canonical order documented in README "Glue insertion logic".
 *
 * `snapshot.kind` is the ONLY kind-switching site (ADR-0011 §Decision 2):
 *   - `music_video` short-circuits to a fixed six-step backbone.
 *   - `narrative` falls through to the existing rules:
 *     - `voiceover` is dropped if `tts_provider` is null.
 *     - The chunker slot is filled by `snapshot.chunker_step` — one of
 *       `chunk_clips_then_images` (workflow 1: hook clips + image body),
 *       `chunk_images_only` (workflow 2: still images only), or
 *       `chunk_clips_only` (workflow 3: video clips only). Each variant
 *       emits a different `Chunk.kind` distribution that downstream image /
 *       video steps filter on.
 *     - The image / video module steps are dropped if their provider
 *       column is null. The provider value (`comfyui` / `google_flow`)
 *       drives runtime dispatch via `ctx.imageProvider` / `ctx.videoProvider`,
 *       not the slug name (Phase 5 removed Invariant A's slug-per-provider
 *       mapping).
 */
export function materializeStepList(snapshot: WorkflowSnapshot): string[] {
  if (snapshot.kind === "music_video") {
    return [...MUSIC_VIDEO_STEPS];
  }

  const out: string[] = [];

  for (const step of snapshot.steps) {
    out.push(step.step_name);
  }

  out.push("assemble_script");

  if (snapshot.tts_provider !== null) {
    out.push("voiceover");
  }

  out.push("align");
  if (snapshot.chunker_step !== null) out.push(snapshot.chunker_step);
  out.push("generate_visual_prompts");

  if (snapshot.image_provider !== null) out.push("generate_images");
  if (snapshot.video_provider !== null) out.push("generate_clips");

  out.push("render", "cleanup");

  return out;
}
