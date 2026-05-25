import { readFileSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";

/**
 * Render a prompt file with `{{var}}` substitution.
 *
 * Per Open Decision #4 in docs/plans/2026-04-08-histforge-implementation.md:
 * every file in `<promptsDir>/_shared/` is auto-loaded into a variable
 * matching its basename (`_shared/audience_profile.md` → `{{audience_profile}}`),
 * then merged with the caller-supplied `vars`. Caller-supplied values win
 * on collisions. A single `{{var}}` substitution pass runs after the merge.
 *
 * The file is read fresh on every call (spec :769-771) so operator edits
 * during a live run take effect without restarting the worker.
 */
export function render(
  promptFile: string,
  vars: Record<string, string | number> = {},
  promptsDir = "prompts"
): string {
  const template = readFileSync(join(promptsDir, promptFile), "utf-8");
  const shared = loadSharedFragments(promptsDir);
  const merged: Record<string, string | number> = { ...shared, ...vars };
  return substitute(template, merged);
}

function loadSharedFragments(
  promptsDir: string
): Record<string, string> {
  const sharedDir = join(promptsDir, "_shared");
  const result: Record<string, string> = {};
  const entries = readdirSync(sharedDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = basename(entry.name, extname(entry.name));
    result[name] = readFileSync(join(sharedDir, entry.name), "utf-8");
  }
  return result;
}

function substitute(
  template: string,
  vars: Record<string, string | number>
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    if (!(key in vars)) {
      throw new Error(`Unresolved prompt variable: {{${key}}}`);
    }
    return String(vars[key]);
  });
}
