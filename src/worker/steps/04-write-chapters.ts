import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Step } from "@/worker/pipeline";
import { getDerivedChapterCount } from "@/lib/settings";
import { render } from "@/lib/prompts";

interface StructuredChapter {
  number: number;
  title: string;
  summary: string;
}

export const BATCH_SIZE = 3;

/**
 * Target word count per chapter, interpolated into
 * `prompts/04_write_chapters_batch.md` as `{{chapter_target_words}}`.
 * ~900 words ≈ 6 minutes at 150 wpm, matching the 6-minute-per-chapter
 * cadence baked into `getDerivedChapterCount`.
 */
const CHAPTER_TARGET_WORDS = 900;

const CHAPTER_BREAK = "---CHAPTER_BREAK---";

/**
 * Step 4 — write_chapters. Spec `:332-347`.
 *
 * Two phases:
 *   Phase A (once): extract a structured JSON outline from the prose
 *     outline and persist it. Skipped on resume if the JSON file exists.
 *   Phase B (batched, BATCH_SIZE chapters at a time): if ALL chapter
 *     files in a batch exist on disk, skip the batch (resume). If ANY
 *     are missing, re-run the entire batch. Each batch makes one LLM
 *     call for the chapters and one for the running summary.
 *
 * **Atomic batch writes**: chapter files are written to `.tmp` then
 * renamed only after the full batch response is parsed and validated.
 * If the LLM call or parsing fails, no chapter files from that batch
 * are committed.
 */
export const step: Step = {
  name: "write_chapters",
  module: "script",
  label: "Write Chapters",
  description: "Drafts each chapter in batches against the running story-so-far summary.",
  for_each: "chapters",
  inputs: ["script/01_outline.md"],
  // Atomic .tmp+rename writes (writeFileAtomic above) guarantee any
  // chapter file on disk is complete, so the default no-op cleanup is
  // correct — sibling chapters and the structured outline stay, sub-resume
  // regenerates whatever is missing.
  outputs: [],
  produces: [
    "script/04_chapter_*.md",
    "script/04_outline_structured.json",
    "script/story_so_far.md",
  ],
  async run(videoId, ctx) {
    const chapterCount = getDerivedChapterCount(ctx.db);

    const scriptDir = join(ctx.projectsDir, videoId, "script");
    const outline = readFileSync(join(scriptDir, "01_outline.md"), "utf-8");

    // Phase A — extract structure. Idempotent: skip if the JSON already
    // exists on disk (resume case).
    const structuredPath = join(scriptDir, "04_outline_structured.json");
    let structured: StructuredChapter[];
    if (existsSync(structuredPath)) {
      structured = JSON.parse(readFileSync(structuredPath, "utf-8"));
    } else {
      const extractPrompt = render(
        "04_extract_structure.md",
        { outline },
        ctx.promptsDir
      );
      const extractReply = await ctx.chat(
        [{ role: "user", content: extractPrompt }],
        { db: ctx.db }
      );
      structured = JSON.parse(cleanJsonReply(extractReply));
      writeFileAtomic(structuredPath, JSON.stringify(structured, null, 2));
    }

    // Validate structured array before entering the batch loop. The LLM
    // may return fewer entries, duplicates, or wrong numbers — catch early.
    const have = structured.map((c) => c.number).sort((a, b) => a - b);
    const want = Array.from({ length: chapterCount }, (_, i) => i + 1);
    if (
      have.length !== want.length ||
      have.some((n, i) => n !== want[i])
    ) {
      throw new Error(
        `Structured outline has chapters [${have.join(", ")}] but expected [${want.join(", ")}]`
      );
    }
    structured.sort((a, b) => a.number - b.number);

    // Phase B — chapter loop. Running story_so_far is seeded from disk if
    // present (resume case), otherwise empty on first iteration.
    const storyPath = join(scriptDir, "story_so_far.md");
    let storySoFar = existsSync(storyPath)
      ? readFileSync(storyPath, "utf-8")
      : "";

    for (let batchStart = 0; batchStart < chapterCount; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, chapterCount);
      const batch = structured.slice(batchStart, batchEnd);

      // Resume: skip if ALL chapter files in this batch already exist.
      const chapterPaths = batch.map((c) => {
        const padded = String(c.number).padStart(2, "0");
        return join(scriptDir, `04_chapter_${padded}.md`);
      });
      if (chapterPaths.every((p) => existsSync(p))) continue;

      // Build the chapters_block for the batch prompt.
      const chaptersBlock = batch
        .map(
          (c) =>
            `CHAPTER ${c.number}: ${c.title}\n${c.summary}`
        )
        .join("\n\n");

      const batchPrompt = render(
        "04_write_chapters_batch.md",
        {
          chapters_block: chaptersBlock,
          outline,
          story_so_far: storySoFar,
          chapter_target_words: CHAPTER_TARGET_WORDS,
        },
        ctx.promptsDir
      );
      const batchReply = await ctx.chat(
        [{ role: "user", content: batchPrompt }],
        { db: ctx.db }
      );

      // Parse the response into individual chapters. The prompt forbids a
      // leading/trailing separator, but LLMs sometimes add one anyway —
      // especially on single-chapter batches. Filter empty parts so a stray
      // boundary separator doesn't blow up the count; a genuinely wrong
      // count (e.g. 2 non-empty parts when 3 were requested) still throws.
      const parts = batchReply
        .split(CHAPTER_BREAK)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      if (parts.length !== batch.length) {
        throw new Error(
          `Batch parse error: expected ${batch.length} chapter(s) but got ${parts.length} part(s)`
        );
      }

      // Write all chapter files atomically — only after successful parse.
      for (let j = 0; j < batch.length; j++) {
        writeFileAtomic(chapterPaths[j], parts[j]);
      }

      // Update running summary once per batch.
      const storyPrompt = render(
        "04_story_so_far.md",
        {
          story_so_far: storySoFar,
          new_chapters: batchReply,
        },
        ctx.promptsDir
      );
      const storyReply = await ctx.chat(
        [{ role: "user", content: storyPrompt }],
        { db: ctx.db }
      );
      writeFileAtomic(storyPath, storyReply);
      storySoFar = storyReply;
    }
  },
};

/**
 * Strip markdown fences and fix literal newlines inside JSON string values
 * so that `JSON.parse` doesn't choke on common LLM formatting quirks.
 */
function cleanJsonReply(raw: string): string {
  // Strip ```json ... ``` fences
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
  // Replace literal newlines inside JSON string values with spaces.
  // Walk character-by-character: when inside a quoted string, replace
  // \n with a space; outside strings, keep as-is.
  let result = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString && (ch === "\n" || ch === "\r")) {
      result += " ";
      continue;
    }
    result += ch;
  }
  return result;
}

/**
 * Write to `<path>.tmp` first, then `rename` onto the final path. On
 * POSIX and NTFS, `rename` is atomic within the same filesystem, so a
 * crash mid-write never leaves a torn file at the final path. This is
 * why step 4 doesn't need a custom `cleanup` hook — any chapter file
 * present on disk is, by construction, complete.
 */
function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}
