import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Step } from "@/worker/pipeline";
import { getDerivedChapterCount } from "@/lib/settings";
import { render } from "@/lib/prompts";

/**
 * Max number of repair attempts after the initial generation when the
 * outline comes back with the wrong number of chapters (either too few
 * or too many). Each attempt is one extra LLM call. After this ceiling,
 * the latest attempt is persisted and the step throws so the orchestrator
 * cleanup + dashboard retry button can roll again.
 */
export const MAX_OUTLINE_REPAIR_ATTEMPTS = 2;

/**
 * Step 1 — research_outline. Spec `:319-321`.
 *
 * Reads title + topic_info from the video row and the derived chapter
 * count from `script_length_minutes`, renders
 * `prompts/01_research_outline.md`, calls the LLM, writes the reply
 * verbatim to `projects/<video_id>/script/01_outline.md`.
 *
 * After the initial generation, counts the `**Title**` blocks in the
 * reply. If the LLM under-delivered, runs up to
 * MAX_OUTLINE_REPAIR_ATTEMPTS rounds of `01_outline_repair.md` to add
 * the missing chapters. If the LLM over-delivered (notably when the
 * derived chapter count is small — e.g. a 6-minute single-chapter video
 * where the prompt's four-phase emotional arc nudges the model toward
 * many chapters), runs the same number of rounds of `01_outline_trim.md`
 * to consolidate adjacent chapters into the requested count. If the
 * count is still wrong after the ceiling, throws — orchestrator cleanup
 * deletes the partial outline and the dashboard's retry button re-runs
 * this step from scratch. Failing here (rather than letting step 4
 * catch it 2 LLM calls later) makes the error attribution and
 * remediation path obvious.
 */
export const step: Step = {
  name: "research_outline",
  module: "script",
  label: "Research Outline",
  description: "Generates a chapter-by-chapter outline from title + topic.",
  inputs: [],
  outputs: ["script/01_outline.md"],
  async run(videoId, ctx) {
    const video = ctx.db
      .prepare("SELECT title, topic_info FROM videos WHERE id = ?")
      .get(videoId) as { title: string; topic_info: string } | undefined;
    if (!video) {
      throw new Error(`No video found for id ${videoId}`);
    }

    const chapterCount = getDerivedChapterCount(ctx.db);

    const prompt = render(
      "01_research_outline.md",
      {
        title: video.title,
        topic_info: video.topic_info,
        chapter_count: chapterCount,
      },
      ctx.promptsDir
    );

    let outline = await ctx.chat([{ role: "user", content: prompt }], { db: ctx.db });

    const scriptDir = join(ctx.projectsDir, videoId, "script");
    mkdirSync(scriptDir, { recursive: true });
    const outlinePath = join(scriptDir, "01_outline.md");
    writeFileSync(outlinePath, outline);

    // Repair loop. Symmetric: under-delivery → extend with 01_outline_repair.md,
    // over-delivery → consolidate with 01_outline_trim.md. Persist after
    // each attempt so an operator can inspect the latest reply even if
    // every retry misses the target.
    for (let attempt = 1; attempt <= MAX_OUTLINE_REPAIR_ATTEMPTS; attempt++) {
      const currentCount = countChapterBlocks(outline);
      if (currentCount === chapterCount) break;
      const repairPrompt =
        currentCount < chapterCount
          ? render(
              "01_outline_repair.md",
              {
                title: video.title,
                topic_info: video.topic_info,
                chapter_count: chapterCount,
                current_count: currentCount,
                missing_count: chapterCount - currentCount,
                outline,
              },
              ctx.promptsDir
            )
          : render(
              "01_outline_trim.md",
              {
                title: video.title,
                topic_info: video.topic_info,
                chapter_count: chapterCount,
                current_count: currentCount,
                extra_count: currentCount - chapterCount,
                outline,
              },
              ctx.promptsDir
            );
      outline = await ctx.chat([{ role: "user", content: repairPrompt }], { db: ctx.db });
      writeFileSync(outlinePath, outline);
    }

    const finalCount = countChapterBlocks(outline);
    if (finalCount !== chapterCount) {
      throw new Error(
        `Outline has ${finalCount} chapter(s) after ${1 + MAX_OUTLINE_REPAIR_ATTEMPTS} LLM attempts (expected ${chapterCount}). Retry to roll again, or adjust script_length_minutes / switch the script LLM provider before retrying.`
      );
    }
  },
};

/**
 * Counts chapter title blocks in the prose outline. The outline prompt
 * drives the LLM toward a `**Title**` line per chapter, but some
 * providers (notably Claude Haiku 4.5 via OpenRouter→Bedrock) prefer
 * ATX `## Title` headings instead. We accept whichever style the LLM
 * chose and return the max of the two counts — bold-wrapped lines and
 * `##` ATX-h2 lines almost never coexist in a single reply, so the max
 * is the chapter count. We deliberately skip h1 (`# Title`): when ATX
 * is used at all, h1 is typically the outline's own title and h2 the
 * per-chapter heading. Used as a pre-check before the (more expensive)
 * JSON structure extraction in step 4.
 */
export function countChapterBlocks(outline: string): number {
  let boldCount = 0;
  let h2Count = 0;
  for (const line of outline.split("\n")) {
    if (/^\s*\*\*[^*]+\*\*\s*$/.test(line)) boldCount++;
    else if (/^\s*##\s+\S.*$/.test(line)) h2Count++;
  }
  return Math.max(boldCount, h2Count);
}
