import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import { STEP_ARTIFACT_RULES } from "@/lib/artifact-grouping";
import {
  listWorkflows,
  materializeStepList,
  resolveSnapshot,
} from "@/lib/workflows";
import { validateWorkflowConsistency } from "@/lib/workflows-validator";
import type { WorkflowSnapshot } from "@/types";
import { REAL_STEPS } from "@/worker/steps";

/**
 * Boot-time consistency check. Replaces the old module-load validators
 * at `src/worker/steps/index.ts:70` / `:93`. Runs once from the worker
 * entry point AFTER the DB is open and BEFORE any state-mutating call
 * (resetStaleRunningSteps, reaper, runner) — failing fast on a
 * structurally inconsistent DB prevents partial cleanup. Throws on the
 * first violation; the top-level `.catch` in `worker/index.ts` logs and
 * exits non-zero so a supervisor notices, same as the prior module-load
 * throw.
 *
 * Scope (README Invariant C):
 *  1. each workflow's `workflow_steps` row resolves to a `REAL_STEPS` entry;
 *  2. each `STEP_ARTIFACT_RULES.step` resolves to a `REAL_STEPS` entry;
 *  3. every non-terminal `videos.workflow_snapshot` materializes to a step
 *     list whose slugs are all in `REAL_STEPS`. Catches snapshots pinned
 *     with pre-Phase-5 slug names (`generate_*_comfyui`,
 *     `generate_*_google_flow`) before the runner picks them up.
 *  4. (Task 11) non-terminal videos have no on-disk legacy artifacts left
 *     over from the hook/main → clip/image rename: no `"hook"` / `"main"`
 *     `kind` values in `chunks/chunks.json`, no `videos/hook/` or
 *     `images/main/` directories. Refuse-to-boot: the operator drains or
 *     restarts the video to re-emit artifacts under the asset-typed paths.
 *
 * Point 1 must run before point 3: `materializeStepList` assumes the
 * snapshot's user-authored steps reference real slugs, and a malformed
 * `workflow_steps` row would be caught here before any snapshot-bearing
 * row is inspected.
 */
export function bootValidate(
  db: DatabaseType,
  projectsDir: string
): void {
  const knownSlugs = new Set(REAL_STEPS.map((s) => s.name));

  for (const wf of listWorkflows(db)) {
    const snapshot = resolveSnapshot(db, wf.id);
    for (const step of snapshot.steps) {
      if (!knownSlugs.has(step.step_name)) {
        throw new Error(
          `Workflow "${wf.id}" references unknown step "${step.step_name}"`
        );
      }
    }

    // Kind-aware consistency check (ADR-0011 §Consequences). Narrative
    // rows are checked against the ADR 0006 §5 chunker_step ↔ provider
    // rule; music_video rows are checked against the Magnific × Suno
    // provider triple. API editor saves are advisory, so drafts imported
    // outside the editor can land inconsistent rows. Fail fast here before
    // the runner picks them up.
    const consistency = validateWorkflowConsistency(snapshot);
    if (!consistency.ok) {
      const detail = consistency.warnings.map((w) => w.message).join(" ");
      throw new Error(
        `Workflow "${wf.id}" violates ${snapshot.kind} consistency rules: ${detail}`
      );
    }
  }

  for (const rule of STEP_ARTIFACT_RULES) {
    if (!knownSlugs.has(rule.step)) {
      throw new Error(
        `Step artifact rule references unknown step "${rule.step}"`
      );
    }
  }

  // Points 3 + 4: scan non-terminal videos. `done` and `failed` are
  // terminal — a `failed` row with a legacy snapshot or directory is
  // dormant; if the operator re-queues it, `transitionNewToQueued`
  // re-snapshots from the live workflow row and step 15 will reorganize
  // any stale on-disk layout when the pipeline re-runs.
  const rows = db
    .prepare(
      "SELECT id, workflow_snapshot FROM videos WHERE workflow_snapshot IS NOT NULL AND status IN ('new', 'queued', 'in_progress')"
    )
    .all() as { id: string; workflow_snapshot: string }[];

  for (const row of rows) {
    const snapshot = JSON.parse(row.workflow_snapshot) as WorkflowSnapshot;
    const slugs = materializeStepList(snapshot);
    for (const slug of slugs) {
      if (!knownSlugs.has(slug)) {
        throw new Error(
          `Video ${row.id}'s workflow_snapshot references step "${slug}", which is not in REAL_STEPS. ` +
            `This snapshot was created with a pre-Phase-5 workflow definition. ` +
            `Operator action: drain or restart this video before deploying. ` +
            `See docs/plans/workflow-modularization/phase-5.md §Migration Notes.`
        );
      }
    }

    // Point 4a: legacy `kind` values in chunks.json. Auto-rewriting a
    // chunks.json mid-pipeline is unsafe — downstream steps (visual
    // prompts, image/clip generation, render) read this file and write
    // assets named after `chunk.id`, which was also renamed. Refuse to
    // boot and let the operator drain the video.
    const chunksPath = join(projectsDir, row.id, "chunks", "chunks.json");
    if (existsSync(chunksPath)) {
      const raw = readFileSync(chunksPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const c of parsed) {
          const kind = (c as { kind?: unknown })?.kind;
          if (kind === "hook" || kind === "main") {
            throw new Error(
              `Video ${row.id}'s chunks/chunks.json contains legacy chunk kind "${kind}" ` +
                `(pre-Phase-2 vocabulary). ` +
                `Operator action: drain or restart this video before deploying. ` +
                `See docs/plans/2026-05-16-three-video-types-and-asset-typed-chunks.md.`
            );
          }
        }
      }
    }

    // Point 4b: legacy directories from the hook/main → clip/image path
    // rename. `videos/hook/` and `images/main/` have been replaced by
    // `videos/clip/` and `images/` respectively; their presence on a
    // non-terminal video means asset files are pinned to filenames the
    // new step modules won't read.
    const hookVideoDir = join(projectsDir, row.id, "videos", "hook");
    if (existsSync(hookVideoDir)) {
      throw new Error(
        `Video ${row.id} has a legacy directory "videos/hook/" ` +
          `(pre-Phase-2 path; the unified video step now writes to "videos/clip/"). ` +
          `Operator action: drain or restart this video before deploying. ` +
          `See docs/plans/2026-05-16-three-video-types-and-asset-typed-chunks.md.`
      );
    }
    const mainImagesDir = join(projectsDir, row.id, "images", "main");
    if (existsSync(mainImagesDir)) {
      throw new Error(
        `Video ${row.id} has a legacy directory "images/main/" ` +
          `(pre-Phase-2 path; the unified image step now writes to "images/"). ` +
          `Operator action: drain or restart this video before deploying. ` +
          `See docs/plans/2026-05-16-three-video-types-and-asset-typed-chunks.md.`
      );
    }
  }
}
