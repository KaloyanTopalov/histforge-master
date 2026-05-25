import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ImportError } from "@/lib/workflows-import";

/**
 * Filesystem layout for the AI-skill drafts pipeline:
 *   <prompts>/workflows/drafts/<slug>.json     — pending drafts
 *   <prompts>/workflows/imported/<slug>-<unix>.json  — archived after import
 *
 * Both directories are siblings under `<prompts>/workflows/` so renameSync
 * stays on the same volume. `getPromptsRoot()` reads the env var at call
 * time (function-form, not a module-load const) so tests can inject a
 * tempdir via `process.env.HISTFORGE_PROMPTS_DIR` after module import.
 */
export function getPromptsRoot(): string {
  return process.env.HISTFORGE_PROMPTS_DIR ?? "prompts";
}

export function getDraftsDir(): string {
  return join(getPromptsRoot(), "workflows", "drafts");
}

export function getImportedDir(): string {
  return join(getPromptsRoot(), "workflows", "imported");
}

export function ensureDraftsDirs(): void {
  mkdirSync(getDraftsDir(), { recursive: true });
  mkdirSync(getImportedDir(), { recursive: true });
}

const DRAFT_FILENAME_RE = /^[a-z0-9-]+\.json$/;

export function validateDraftFilename(filename: string): void {
  if (!DRAFT_FILENAME_RE.test(filename)) {
    throw new ImportError("invalid_filename");
  }
}
