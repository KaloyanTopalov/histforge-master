import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Step } from "@/worker/pipeline";
import { render } from "@/lib/prompts";

/**
 * Step 3 — write_hook. Spec `:327-330`.
 *
 * Reads title (DB), outline (disk), renders
 * `prompts/03_write_hook.md`, calls the LLM, writes the reply verbatim to
 * `script/03_hook.md`. The 250–400 word target in the spec is a soft
 * content guideline enforced by the prompt, not by this module.
 */
export const step: Step = {
  name: "write_hook",
  module: "script",
  label: "Write Hook",
  description: "Drafts the cold-open hook from the outline.",
  inputs: ["script/01_outline.md"],
  outputs: ["script/03_hook.md"],
  async run(videoId, ctx) {
    const video = ctx.db
      .prepare("SELECT title FROM videos WHERE id = ?")
      .get(videoId) as { title: string } | undefined;
    if (!video) {
      throw new Error(`No video found for id ${videoId}`);
    }

    const scriptDir = join(ctx.projectsDir, videoId, "script");
    const outline = readFileSync(join(scriptDir, "01_outline.md"), "utf-8");

    const prompt = render(
      "03_write_hook.md",
      {
        title: video.title,
        outline,
      },
      ctx.promptsDir
    );

    const reply = await ctx.chat([{ role: "user", content: prompt }], { db: ctx.db });

    writeFileSync(join(scriptDir, "03_hook.md"), reply);
  },
};
