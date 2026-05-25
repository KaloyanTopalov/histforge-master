import type { Database as DatabaseType } from "better-sqlite3";
import * as workflowsRepo from "@/lib/repos/workflows";
import type { WorkflowRow } from "@/types";

/**
 * Public response shape for the workflows API. snake_case columns from
 * the SQLite-mirroring `WorkflowRow` are flattened into a `providers`
 * object + camelCased lifecycle fields at this boundary so consumers
 * (Phase 2 editor, Phase 1 read-only `/workflows` page) get one
 * consistent style. The internal `WorkflowRow` keeps snake_case to mirror
 * SQLite columns directly per CLAUDE.md.
 */
export interface WorkflowApiSummary {
  id: string;
  label: string;
  shortLabel: string;
  description: string | null;
  isBuiltin: number;
  enabled: number;
  version: number;
  providers: {
    // Nullable to mirror the relaxed workflows schema (Plan 1 Phase 1.1
    // Task 2). Narrative workflows always carry a non-null `script`;
    // music-video workflows carry null.
    script: string | null;
    tts: string | null;
    image: string | null;
    video: string | null;
  };
  stepCount: number;
}

export function toApiSummary(
  row: WorkflowRow,
  stepCount: number
): WorkflowApiSummary {
  return {
    id: row.id,
    label: row.label,
    shortLabel: row.short_label,
    description: row.description,
    isBuiltin: row.is_builtin,
    enabled: row.enabled,
    version: row.version,
    providers: {
      script: row.script_llm_provider,
      tts: row.tts_provider,
      image: row.image_provider,
      video: row.video_provider,
    },
    stepCount,
  };
}

export interface WorkflowApiDetail extends WorkflowApiSummary {
  steps: { step_name: string }[];
}

/**
 * Build the full detail response (summary + ordered step_name list) by
 * re-reading the row + steps. Used by every write route after a
 * successful mutation so the response shape stays uniform.
 */
export function buildDetail(
  db: DatabaseType,
  id: string
): WorkflowApiDetail {
  const row = workflowsRepo.findById(db, id)!;
  const stepRows = workflowsRepo.findStepsByWorkflow(db, id);
  return {
    ...toApiSummary(row, stepRows.length),
    steps: stepRows.map((s) => ({ step_name: s.step_name })),
  };
}

export interface DraftRowProviders {
  script: string | null;
  tts: string | null;
  image: string | null;
  video: string | null;
}

export interface DraftRow {
  filename: string;
  slug: string | null;
  label: string | null;
  providers: DraftRowProviders | null;
  chunker_step: string | null;
  stepCount: number | null;
  mtime: number;
  errors: string[];
}
