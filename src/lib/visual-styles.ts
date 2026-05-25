import type { Database as DatabaseType } from "better-sqlite3";
import type { VisualStyle, VisualStyleSnapshot } from "@/types";
import * as visualStylesRepo from "@/lib/repos/visual-styles";

/**
 * Public lib-layer boundary for the visual-styles gallery. Mirrors the
 * role `lib/workflows.ts` plays for the workflow registry: callers reach
 * the gallery through these helpers rather than importing the repo
 * directly. `computeVisualStyleSnapshot` is the per-video snapshot
 * helper (parallel to `computeSnapshot`); `getVisualStyleFromDb` is the
 * existence-check helper used by the videos routes (parallel to
 * `getWorkflowFromDb`).
 *
 * The snapshot intentionally omits timestamps — it freezes prompt
 * content, not the gallery row's lifecycle. NULL snapshot at step-09
 * time = empty `style_prompt` template variable = "Default (no style)".
 */

export function getVisualStyleFromDb(
  db: DatabaseType,
  id: string
): VisualStyle | null {
  return visualStylesRepo.findById(db, id);
}

/**
 * Resolve a visual_style_id into the JSON string pinned in
 * `videos.visual_style_snapshot`. Returns `null` when:
 *   - the id is null (the documented "no style" shape), OR
 *   - the gallery row was deleted before this re-pin ran (decision 13 —
 *     silent loss on delete-between-create-and-queue is accepted).
 *
 * Symmetric to `computeSnapshot` in `lib/workflows.ts` but a single-row
 * read; no transaction wrapper required.
 */
export function computeVisualStyleSnapshot(
  db: DatabaseType,
  visual_style_id: string | null
): string | null {
  if (visual_style_id === null) return null;
  const row = visualStylesRepo.findById(db, visual_style_id);
  if (row === null) return null;
  const snapshot: VisualStyleSnapshot = {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
  };
  return JSON.stringify(snapshot);
}

/**
 * Inverse of `computeVisualStyleSnapshot`: parse the JSON string stored
 * in `videos.visual_style_snapshot` (or null/undefined when absent) into
 * a typed `VisualStyleSnapshot`. Null/undefined input maps to null —
 * the documented "Default (no style)" branch. Used by step 09 and the
 * video detail page; keeps the parse idiom in one place so the next
 * caller doesn't have to rediscover that the column is TEXT.
 */
export function parseVisualStyleSnapshot(
  json: string | null | undefined
): VisualStyleSnapshot | null {
  if (json == null) return null;
  return JSON.parse(json) as VisualStyleSnapshot;
}
