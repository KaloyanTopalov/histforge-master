import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Step } from "@/worker/pipeline";
import { getDerivedChapterCount } from "@/lib/settings";
import { appendLog } from "@/lib/logger";
import { sanitizeScript } from "@/lib/script-sanitize";

export { sanitizeScript } from "@/lib/script-sanitize";

/**
 * Step 5 — assemble_script. Spec `:349-350`.
 *
 * Concatenates `03_hook.md` + `04_chapter_01.md` + ... +
 * `04_chapter_<chapter_count>.md` (padded to two digits) with double
 * newlines into `script/full_script.md`. The chapter count is derived
 * from `script_length_minutes` (6 min/chapter), not from whatever
 * `04_chapter_*.md` files happen to be on disk — stale files from a
 * previous run with a higher count must not leak into the assembled
 * script.
 */
export const step: Step = {
  name: "assemble_script",
  module: "glue",
  label: "Assemble Script",
  description: "Concatenates the hook and chapter files into the full script.",
  inputs: ["script/03_hook.md", "script/04_chapter_*.md"],
  outputs: ["script/full_script.md"],
  async run(videoId, ctx) {
    const chapterCount = getDerivedChapterCount(ctx.db);

    const scriptDir = join(ctx.projectsDir, videoId, "script");
    const parts: string[] = [readFileSync(join(scriptDir, "03_hook.md"), "utf-8")];
    for (let i = 1; i <= chapterCount; i++) {
      const padded = String(i).padStart(2, "0");
      parts.push(
        readFileSync(join(scriptDir, `04_chapter_${padded}.md`), "utf-8")
      );
    }

    const { text, emDashCount } = sanitizeScript(parts.join("\n\n"));
    if (emDashCount > 0) {
      appendLog(
        videoId,
        "assemble_script",
        `Sanitized ${emDashCount} em-dash(es) → ", " in full_script.md`,
        ctx.projectsDir
      );
    }
    writeFileSync(join(scriptDir, "full_script.md"), text);
  },
};
