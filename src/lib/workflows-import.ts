import type { Database as DatabaseType } from "better-sqlite3";
import * as workflowsRepo from "@/lib/repos/workflows";
import { WorkflowImportSchema } from "@/lib/workflows-schema";
import {
  validateInputAvailability,
  validateWorkflowConsistency,
  type ValidationWarning,
} from "@/lib/workflows-validator";
import type { WorkflowRow, WorkflowSnapshot } from "@/types";

/**
 * Shared workflow-import helper. Owns the insert-or-overwrite-in-transaction
 * + post-commit validation logic that both `/api/workflows/import` and
 * Phase 6's `/api/workflows/drafts/[filename]/import` route share. The
 * helper is framework-agnostic — it returns DB-shape `WorkflowRow` and
 * leaves HTTP-status mapping (`ImportError.code` → 400/404/409) to the
 * route layer.
 */

export type ImportStatus = "created" | "overwritten";

export interface ImportResult {
  row: WorkflowRow;
  status: ImportStatus;
  warnings: ValidationWarning[];
}

export type ImportErrorCode =
  | "invalid_input"
  | "workflow_id_exists"
  | "invalid_filename";

export class ImportError extends Error {
  constructor(
    public readonly code: ImportErrorCode,
    public readonly details?: Record<string, unknown>
  ) {
    super(code);
    this.name = "ImportError";
  }
}

export const IMPORT_ERROR_STATUS: Record<ImportErrorCode, number> = {
  invalid_input: 400,
  workflow_id_exists: 409,
  invalid_filename: 400,
};

export function importWorkflowJson(
  db: DatabaseType,
  payload: unknown,
  opts: { overwrite: boolean }
): ImportResult {
  const parsed = WorkflowImportSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ImportError("invalid_input", { issues: parsed.error.issues });
  }
  const data = parsed.data;

  let successStatus: ImportStatus | null = null;
  let postVersion = 0;

  try {
    db.transaction(() => {
      const existing = workflowsRepo.findById(db, data.id);
      const now = Date.now();

      if (existing) {
        if (!opts.overwrite) {
          throw new ImportError("workflow_id_exists", {
            current_version: existing.version,
          });
        }
        const { id: _id, steps, ...rowFields } = data;
        void _id;
        workflowsRepo.update(db, data.id, rowFields);
        workflowsRepo.replaceSteps(db, data.id, steps);
        workflowsRepo.bumpVersion(db, data.id);
        successStatus = "overwritten";
        postVersion = existing.version + 1;
        return;
      }

      // Discriminated-union narrowing makes each branch's columns type-safe:
      // narrative rows carry a string `script_llm_provider` + enum chunker +
      // null music-video columns; music_video rows carry the inverse.
      // Reading directly from `data` (with `?? null` for the music-video-only
      // columns that the narrative branch declares optional+null) preserves
      // round-trip parity with the export endpoint.
      const newRow: WorkflowRow = {
        id: data.id,
        label: data.label,
        short_label: data.short_label,
        description: data.description ?? null,
        kind: data.kind,
        script_llm_provider: data.script_llm_provider,
        tts_provider: data.tts_provider,
        image_provider: data.image_provider,
        video_provider: data.video_provider,
        music_provider: data.music_provider ?? null,
        upscaler_provider: data.upscaler_provider ?? null,
        is_builtin: 0,
        enabled: data.enabled === false ? 0 : 1,
        version: 1,
        created_at: now,
        updated_at: now,
        chunker_step: data.chunker_step,
      };
      workflowsRepo.insert(db, newRow);
      workflowsRepo.replaceSteps(db, data.id, data.steps);
      successStatus = "created";
      postVersion = 1;
    })();
  } catch (err) {
    if (err instanceof ImportError) throw err;
    if (workflowsRepo.isPrimaryKeyCollision(err)) {
      throw new ImportError("workflow_id_exists");
    }
    throw err;
  }

  // Synthesize the snapshot post-commit from the parsed payload. Mirrors
  // the row we just inserted, so the kind-aware consistency check sees
  // exactly the shape on disk. `validateWorkflowConsistency` dispatches
  // on `snapshot.kind`: narrative delegates to the chunker ↔ provider
  // rule (ADR 0006 §5); music_video asserts the Magnific × Suno triple
  // (ADR-0011 §Consequences).
  const snapshot: WorkflowSnapshot = {
    workflow_id: data.id,
    version: postVersion,
    kind: data.kind,
    script_llm_provider: data.script_llm_provider,
    tts_provider: data.tts_provider,
    image_provider: data.image_provider,
    video_provider: data.video_provider,
    music_provider: data.music_provider ?? null,
    upscaler_provider: data.upscaler_provider ?? null,
    chunker_step: data.chunker_step,
    image_style: data.image_style ?? null,
    steps: data.steps,
  };
  const inputs = validateInputAvailability(snapshot);
  const consistency = validateWorkflowConsistency(snapshot);

  return {
    row: workflowsRepo.findById(db, data.id)!,
    status: successStatus!,
    warnings: [...inputs.warnings, ...consistency.warnings],
  };
}
