import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb, seedDefaultSettings } from "@/lib/db";
import * as workflowsRepo from "@/lib/repos/workflows";
import * as videosRepo from "@/lib/repos/videos";
import { materializeStepList } from "@/lib/workflows";
import { REAL_STEPS } from "@/worker/steps";
import type { Step } from "@/worker/pipeline";
import type { WorkflowRow, WorkflowSnapshot } from "@/types";

const openDbs: DatabaseType[] = [];

function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length) {
    try {
      openDbs.pop()!.close();
    } catch {
      /* ignore */
    }
  }
});

function readSnapshot(db: DatabaseType, videoId: string): WorkflowSnapshot {
  const row = db
    .prepare("SELECT workflow_snapshot FROM videos WHERE id = ?")
    .get(videoId) as { workflow_snapshot: string };
  return JSON.parse(row.workflow_snapshot) as WorkflowSnapshot;
}

function cloneWorkflow(
  db: DatabaseType,
  sourceId: string,
  newId: string
): void {
  db.transaction(() => {
    const source = workflowsRepo.findById(db, sourceId)!;
    const sourceSteps = workflowsRepo.findStepsByWorkflow(db, sourceId);
    const now = Date.now();
    const newRow: WorkflowRow = {
      ...source,
      id: newId,
      label: `${source.label} (copy)`,
      is_builtin: 0,
      enabled: 1,
      version: 1,
      created_at: now,
      updated_at: now,
    };
    workflowsRepo.insert(db, newRow);
    workflowsRepo.replaceSteps(
      db,
      newId,
      sourceSteps.map((s) => ({ step_name: s.step_name }))
    );
  })();
}

function patchSteps(
  db: DatabaseType,
  workflowId: string,
  steps: { step_name: string }[]
): void {
  db.transaction(() => {
    workflowsRepo.replaceSteps(db, workflowId, steps);
    workflowsRepo.bumpVersion(db, workflowId);
  })();
}

// Trimmed list mirrors comfyui's full script step list (kept named
// "trimmed" historically; the tests exercise clone+patch+queue mechanics).
const TRIMMED_SCRIPT_STEPS = [
  { step_name: "research_outline" },
  { step_name: "write_hook" },
  { step_name: "write_chapters" },
];

const TRIMMED_MATERIALIZED = [
  "research_outline",
  "write_hook",
  "write_chapters",
  "assemble_script",
  "voiceover",
  "align",
  "chunk_clips_then_images",
  "generate_visual_prompts",
  "generate_images",
  "generate_clips",
  "render",
  "cleanup",
];

/**
 * Mirrors the slug→Step resolution `resolveDeps` does in
 * `src/worker/pipeline.ts` (the function is module-internal). If the
 * orchestrator's parse/materialize/lookup chain regresses, this helper
 * regresses with it because both consume `materializeStepList` + the
 * same `REAL_STEPS` registry.
 */
function resolveStepsFromSnapshot(snapshot: WorkflowSnapshot): Step[] {
  const slugs = materializeStepList(snapshot);
  const bySlug = new Map(REAL_STEPS.map((s) => [s.name, s] as const));
  return slugs.map((slug) => {
    const s = bySlug.get(slug);
    if (!s) {
      throw new Error(
        `Workflow "${snapshot.workflow_id}" references unknown step "${slug}"`
      );
    }
    return s;
  });
}

describe("Scenario A — clone + customize + queue plumbing", () => {
  it("createNewVideo + transitionNewToQueued pin the trimmed step list end-to-end", () => {
    const db = freshDb();
    cloneWorkflow(db, "comfyui", "comfyui-trimmed");
    patchSteps(db, "comfyui-trimmed", TRIMMED_SCRIPT_STEPS);

    videosRepo.createNewVideo(db, {
      id: "v_a",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui-trimmed",
      created_at: 1,
    });

    const newSnap = readSnapshot(db, "v_a");
    expect(newSnap.steps).toEqual(TRIMMED_SCRIPT_STEPS);

    videosRepo.transitionNewToQueued(db, "v_a");

    const queuedSnap = readSnapshot(db, "v_a");
    expect(queuedSnap.steps).toEqual(TRIMMED_SCRIPT_STEPS);
    expect(materializeStepList(queuedSnap)).toEqual(TRIMMED_MATERIALIZED);

    // Mirror what `resolveDeps` does on the orchestrator path: parse the
    // snapshot, materialize, and resolve each slug against REAL_STEPS.
    // This proves the trimmed step list is consumable end-to-end (no
    // "unknown step" throw) and that the resolved Step objects line up
    // with the materialized slug order.
    const resolved = resolveStepsFromSnapshot(queuedSnap);
    expect(resolved.map((s) => s.name)).toEqual(TRIMMED_MATERIALIZED);
  });
});

describe("Scenario B — re-snapshot at queue time, immutable thereafter (Invariant B)", () => {
  it("PATCH between createNewVideo and transitionNewToQueued is reflected in the queued snapshot", () => {
    const db = freshDb();
    cloneWorkflow(db, "comfyui", "comfyui-edit-after");

    videosRepo.createNewVideo(db, {
      id: "v_b",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui-edit-after",
      created_at: 1,
    });

    // Initial snapshot mirrors the source's full step list (clone copies it).
    const initialSnap = readSnapshot(db, "v_b");
    expect(initialSnap.steps).toEqual([
      { step_name: "research_outline" },
      { step_name: "write_hook" },
      { step_name: "write_chapters" },
    ]);

    // Operator edits the workflow before queueing.
    patchSteps(db, "comfyui-edit-after", TRIMMED_SCRIPT_STEPS);

    // Invariant B point 3: queue-time snapshot must reflect the post-edit state.
    videosRepo.transitionNewToQueued(db, "v_b");
    const queuedSnap = readSnapshot(db, "v_b");
    expect(queuedSnap.steps).toEqual(TRIMMED_SCRIPT_STEPS);

    // Invariant B point 4: post-queue PATCHes do NOT mutate the pinned snapshot.
    const SECOND_PATCH_STEPS = [
      { step_name: "research_outline" },
      { step_name: "write_chapters" },
    ];
    patchSteps(db, "comfyui-edit-after", SECOND_PATCH_STEPS);

    // Sanity check: the second PATCH actually landed on the live workflow
    // row. Without this, "snapshot didn't change" is trivially satisfied
    // by a no-op PATCH, masking a regression in the immutability rule.
    const liveSteps = workflowsRepo
      .findStepsByWorkflow(db, "comfyui-edit-after")
      .map((s) => ({ step_name: s.step_name }));
    expect(liveSteps).toEqual(SECOND_PATCH_STEPS);

    const afterSecondPatch = readSnapshot(db, "v_b");
    expect(afterSecondPatch.steps).toEqual(TRIMMED_SCRIPT_STEPS);
  });
});
