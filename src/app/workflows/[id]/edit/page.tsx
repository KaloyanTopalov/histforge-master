import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getWorkflowFromDb, resolveSnapshot } from "@/lib/workflows";
import { REAL_STEPS } from "@/worker/steps";
import { EditForm, type ScriptStepMeta, type WorkflowEditRow } from "./edit-form";

interface EditPageProps {
  params: { id: string };
}

/**
 * Workflow editor server shell. Reads the row + ordered step list + the
 * catalog of `module === "script"` step metadata server-side and hands a
 * plain JSON-serializable payload to the client `<EditForm>`.
 *
 * Phase 3 will introduce `GET /api/workflows/schema` for the AI skill,
 * but the editor does not need an HTTP fetch — it imports `REAL_STEPS`
 * directly server-side and serializes the script subset across the
 * server→client boundary.
 */
export default function EditWorkflowPage({
  params,
}: EditPageProps): JSX.Element {
  const db = getDb();
  const row = getWorkflowFromDb(db, params.id);
  if (!row) {
    notFound();
  }
  const snapshot = resolveSnapshot(db, params.id);

  const initialRow: WorkflowEditRow = {
    id: row.id,
    label: row.label,
    short_label: row.short_label,
    description: row.description,
    script_llm_provider: row.script_llm_provider,
    tts_provider: row.tts_provider,
    image_provider: row.image_provider,
    video_provider: row.video_provider,
    chunker_step: row.chunker_step,
    enabled: row.enabled === 1,
    version: row.version,
    is_builtin: row.is_builtin === 1,
  };

  const initialSteps = snapshot.steps.map((s) => ({ step_name: s.step_name }));

  const scriptCatalog: ScriptStepMeta[] = REAL_STEPS.filter(
    (s) => s.module === "script"
  ).map((s) => ({
    name: s.name,
    label: s.label ?? s.name,
    description: s.description ?? "",
    for_each: s.for_each ?? null,
  }));

  return (
    <EditForm
      initialRow={initialRow}
      initialSteps={initialSteps}
      scriptCatalog={scriptCatalog}
    />
  );
}
