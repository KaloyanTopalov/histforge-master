import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Recursively list files under `dir`, returning paths relative to `dir`
 * with forward slashes and sorted alphabetically. Used to populate the
 * artifacts panel on the video detail page and in the dashboard API. Spec
 * :718.
 *
 * Returns `[]` if `dir` does not exist — callers treat missing project
 * directories the same as empty ones (e.g., a newly-queued video before
 * the worker has run step 01).
 */
export function listProjectFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  function walk(cur: string): void {
    for (const entry of readdirSync(cur)) {
      const full = join(cur, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        out.push(relative(dir, full).replace(/\\/g, "/"));
      }
    }
  }
  walk(dir);
  return out.sort();
}
