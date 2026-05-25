import type { Database as DatabaseType } from "better-sqlite3";
import type { WorkflowRow, WorkflowStepRow } from "@/types";

/**
 * Workflows repository — thin atomic SQL wrappers. Internal-only:
 * callers go through `src/lib/workflows.ts` (the public lib boundary)
 * rather than reaching for these directly. Multi-statement composition
 * (snapshot capture, etc.) happens at the call site inside
 * `db.transaction(...)`.
 */

/**
 * Detect a PRIMARY KEY collision on `workflows.id`. better-sqlite3
 * raises a SqliteError with `.code === "SQLITE_CONSTRAINT_PRIMARYKEY"`
 * when `insert` runs against an existing slug; the route handlers map
 * this to a 409 with a stable `workflow_id_exists` error code.
 */
export function isPrimaryKeyCollision(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return (
      (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_PRIMARYKEY"
    );
  }
  return false;
}

export function findById(
  db: DatabaseType,
  id: string
): WorkflowRow | null {
  const row = db
    .prepare("SELECT * FROM workflows WHERE id = ?")
    .get(id) as WorkflowRow | undefined;
  return row ?? null;
}

export function list(db: DatabaseType): WorkflowRow[] {
  return db
    .prepare("SELECT * FROM workflows ORDER BY id ASC")
    .all() as WorkflowRow[];
}

export function findStepsByWorkflow(
  db: DatabaseType,
  workflow_id: string
): WorkflowStepRow[] {
  return db
    .prepare(
      "SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY position ASC"
    )
    .all(workflow_id) as WorkflowStepRow[];
}

/**
 * Insert a single workflow row. Atomic — does NOT touch
 * `workflow_steps`. Multi-statement composition (insert workflow + insert
 * its steps) happens at the API-route call site inside
 * `db.transaction(...)`. PK collisions throw a SQLite constraint error
 * which the route handler maps to 409.
 */
export function insert(db: DatabaseType, row: WorkflowRow): void {
  db.prepare(
    `INSERT INTO workflows
       (id, label, short_label, description, kind, script_llm_provider,
        tts_provider, image_provider, video_provider,
        music_provider, upscaler_provider,
        is_builtin, enabled, version, created_at, updated_at,
        chunker_step)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.label,
    row.short_label,
    row.description,
    row.kind,
    row.script_llm_provider,
    row.tts_provider,
    row.image_provider,
    row.video_provider,
    row.music_provider,
    row.upscaler_provider,
    row.is_builtin,
    row.enabled,
    row.version,
    row.created_at,
    row.updated_at,
    row.chunker_step
  );
}

/**
 * Replace the step list for a workflow. DELETE-then-INSERT inside the
 * caller's transaction (the two prepared statements run in whatever
 * outer `db.transaction(...)` the call site wraps them in). Position is
 * 0-based — matching `seedDefaultWorkflows`'s `forEach((_, position))`.
 * Empty array clears the list.
 */
export function replaceSteps(
  db: DatabaseType,
  workflow_id: string,
  steps: { step_name: string }[]
): void {
  db.prepare("DELETE FROM workflow_steps WHERE workflow_id = ?").run(
    workflow_id
  );
  const insertStep = db.prepare(
    "INSERT INTO workflow_steps (workflow_id, position, step_name) VALUES (?, ?, ?)"
  );
  steps.forEach((step, position) => {
    insertStep.run(workflow_id, position, step.step_name);
  });
}

/**
 * Columns that `update` is allowed to write. The keys mirror SQLite
 * column names. Lifecycle fields (`id`, `created_at`, `updated_at`,
 * `version`, `is_builtin`) are intentionally absent — the slug is
 * immutable, `updated_at` and `version` are managed by `bumpVersion`,
 * and `is_builtin` is server-controlled (set only by the seed).
 */
type UpdatableField =
  | "label"
  | "short_label"
  | "description"
  | "kind"
  | "script_llm_provider"
  | "tts_provider"
  | "image_provider"
  | "video_provider"
  | "music_provider"
  | "upscaler_provider"
  | "enabled"
  | "chunker_step";

const UPDATABLE_FIELDS: readonly UpdatableField[] = [
  "label",
  "short_label",
  "description",
  "kind",
  "script_llm_provider",
  "tts_provider",
  "image_provider",
  "video_provider",
  "music_provider",
  "upscaler_provider",
  "enabled",
  "chunker_step",
];

/**
 * Input shape for `update`. Mirrors `Pick<WorkflowRow, UpdatableField>`
 * but accepts `boolean` for `enabled` so route handlers (whose Zod
 * schemas produce booleans for `enabled`) don't each repeat the
 * `boolean → 0 | 1` coercion. `undefined` skips the field; `null` is
 * still only meaningful for the nullable columns.
 */
type UpdateInput = {
  label?: string;
  short_label?: string;
  description?: string | null;
  // Plan 1 Phase 1.1 Task 6: kind is updatable in principle (the reset-
  // to-default flow needs to write it back when restoring the seed), but
  // the API layer pins kind at creation. `script_llm_provider` + `chunker_step`
  // accept null so reset-to-default on a music_video builtin can write
  // SQL NULL via this helper.
  kind?: string;
  script_llm_provider?: string | null;
  tts_provider?: string | null;
  image_provider?: string | null;
  video_provider?: string | null;
  music_provider?: string | null;
  upscaler_provider?: string | null;
  enabled?: number | boolean;
  chunker_step?: string | null;
};

/**
 * Partial UPDATE on a workflow row. Field semantics:
 *   - `undefined` → skip (no change).
 *   - `null` → write SQL NULL (only meaningful for nullable columns:
 *     description, tts_provider, image_provider, video_provider).
 *   - value → write the value. `enabled` accepts `boolean` for caller
 *     convenience and is coerced to `0 | 1` here.
 *
 * `updated_at` and `version` are not writable here — call `bumpVersion`
 * after `update` to stamp the timestamp and increment the version
 * atomically.
 */
export function update(
  db: DatabaseType,
  id: string,
  fields: UpdateInput
): void {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  for (const key of UPDATABLE_FIELDS) {
    const value = fields[key];
    if (value === undefined) continue;
    sets.push(`${key} = ?`);
    if (typeof value === "boolean") {
      args.push(value ? 1 : 0);
    } else {
      args.push(value);
    }
  }
  if (sets.length === 0) return;
  args.push(id);
  db.prepare(`UPDATE workflows SET ${sets.join(", ")} WHERE id = ?`).run(...args);
}

/**
 * Atomically increment `version` and stamp `updated_at = now`. Returns
 * the new version. Phase 2's optimistic-concurrency PATCH path calls
 * this after writing the row + steps.
 */
export function bumpVersion(
  db: DatabaseType,
  id: string
): { version: number } {
  const now = Date.now();
  db.prepare(
    "UPDATE workflows SET version = version + 1, updated_at = ? WHERE id = ?"
  ).run(now, id);
  const row = db
    .prepare("SELECT version FROM workflows WHERE id = ?")
    .get(id) as { version: number } | undefined;
  if (!row) {
    throw new Error(`bumpVersion: workflow not found: ${id}`);
  }
  return { version: row.version };
}

/**
 * DELETE a workflow row. `workflow_steps` rows cascade via the
 * `ON DELETE CASCADE` FK from the schema. The route handler is expected
 * to pre-check `countVideosUsingWorkflow` and return 409 before calling
 * this — but if it doesn't, `videos.workflow_id`'s `ON DELETE RESTRICT`
 * FK raises a constraint error, which the caller can catch.
 */
export function deleteById(
  db: DatabaseType,
  id: string
): { deleted: boolean } {
  const result = db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
  return { deleted: result.changes > 0 };
}

/**
 * Count of videos pinned to this workflow id. Used by the DELETE route
 * to produce a friendly 409 with a concrete count instead of relying on
 * the FK constraint error path.
 */
export function countVideosUsingWorkflow(
  db: DatabaseType,
  id: string
): number {
  const row = db
    .prepare("SELECT COUNT(*) as n FROM videos WHERE workflow_id = ?")
    .get(id) as { n: number };
  return row.n;
}
