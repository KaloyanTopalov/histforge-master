import type { Database as DatabaseType } from "better-sqlite3";
import type { VisualStyle } from "@/types";

/**
 * Visual-styles repository — thin atomic SQL wrappers over the
 * `visual_styles` table. Each entry is one named visual prompt prefix
 * that operators can pin to a video at create time (mirroring how
 * `workflow_id` + `workflow_snapshot` works). Step 09 reads the pinned
 * snapshot, never this table directly.
 *
 * Deletes are unconditional — `videos.visual_style_id` carries an
 * `ON DELETE SET NULL` FK, so there's no `countVideosUsing*` analogue
 * here (ADR-0010). Friction lives in the UI, not the API.
 */

export function findById(
  db: DatabaseType,
  id: string
): VisualStyle | null {
  const row = db
    .prepare("SELECT * FROM visual_styles WHERE id = ?")
    .get(id) as VisualStyle | undefined;
  return row ?? null;
}

/**
 * Alphabetical case-insensitive sort. Matches the gallery's left-rail
 * order and the per-video selector dropdown order (decision 7).
 */
export function list(db: DatabaseType): VisualStyle[] {
  return db
    .prepare(
      "SELECT * FROM visual_styles ORDER BY title COLLATE NOCASE ASC"
    )
    .all() as VisualStyle[];
}

export function insert(db: DatabaseType, row: VisualStyle): void {
  db.prepare(
    `INSERT INTO visual_styles
       (id, title, prompt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(row.id, row.title, row.prompt, row.created_at, row.updated_at);
}

type UpdateInput = {
  title?: string;
  prompt?: string;
};

/**
 * Partial UPDATE. Stamps `updated_at = Date.now()` whenever any field is
 * written. Empty patch is a no-op and does not touch the timestamp;
 * missing-id is also a no-op (UPDATE WHERE id matches zero rows). Both
 * cases return `{ updated: false }` so callers can 404 without a
 * separate existence check.
 */
export function update(
  db: DatabaseType,
  id: string,
  fields: UpdateInput
): { updated: boolean } {
  const sets: string[] = [];
  const args: (string | number)[] = [];
  if (fields.title !== undefined) {
    sets.push("title = ?");
    args.push(fields.title);
  }
  if (fields.prompt !== undefined) {
    sets.push("prompt = ?");
    args.push(fields.prompt);
  }
  if (sets.length === 0) return { updated: false };
  sets.push("updated_at = ?");
  args.push(Date.now());
  args.push(id);
  const result = db
    .prepare(`UPDATE visual_styles SET ${sets.join(", ")} WHERE id = ?`)
    .run(...args);
  return { updated: result.changes > 0 };
}

export function deleteById(
  db: DatabaseType,
  id: string
): { deleted: boolean } {
  const result = db
    .prepare("DELETE FROM visual_styles WHERE id = ?")
    .run(id);
  return { deleted: result.changes > 0 };
}
