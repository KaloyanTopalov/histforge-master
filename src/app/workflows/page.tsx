import { getDb } from "@/lib/db";
import { listWorkflows } from "@/lib/workflows";
import * as workflowsRepo from "@/lib/repos/workflows";
import { toApiSummary } from "@/lib/workflows-api";
import { DraftsSection } from "./drafts-section";
import { WorkflowsTable } from "./workflows-table";

/**
 * Workflows list page. Server component that reads the registry directly
 * via the lib boundary and hands the camelCase-mapped rows to a client
 * component owning the action buttons (Edit, Clone, Delete, Reset, Toggle,
 * Export, Import). The camelCase boundary matches `GET /api/workflows`.
 */
export default function WorkflowsPage(): JSX.Element {
  const db = getDb();
  const rows = listWorkflows(db).map((row) => {
    const stepCount = workflowsRepo.findStepsByWorkflow(db, row.id).length;
    return toApiSummary(row, stepCount);
  });

  return (
    <>
      <header className="relative mb-8 pb-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-emerald-800/85 dark:text-emerald-300/85">
          Pipelines
        </p>
        <h1 className="mt-1.5 font-display text-[2.75rem] font-medium leading-[1.05] tracking-tight text-foreground">
          Workflows
        </h1>
        <span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-px bg-emerald-500/35 dark:bg-emerald-400/40"
        />
      </header>
      <DraftsSection />
      <WorkflowsTable rows={rows} />
    </>
  );
}
