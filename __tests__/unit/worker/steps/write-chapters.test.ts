import { describe, it, expect, afterEach, vi } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setSetting } from "@/lib/settings";
import { step as writeChaptersStep } from "@/worker/steps/04-write-chapters";
import {
  cleanup,
  freshDb,
  makeStepContext,
  tempDir,
} from "../../../helpers/step-fixtures";

/**
 * Step 4 exercises the sub-resume logic. Tests drive the step with a
 * fake `chat` that inspects the message content and returns appropriate
 * responses — JSON for the extract-structure call, chapter prose for the
 * chapter calls, summary text for the story-so-far calls.
 */

function seedVideo(db: DatabaseType): string {
  const now = Date.now();
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, 'in_progress', ?)"
  ).run("v_01", "Test Topic", "info", "comfyui", now);
  return "v_01";
}

/**
 * Prompt stubs use distinctive prefixes so the fake chat can route
 * responses without relying on call order. Every {{var}} the step is
 * expected to inject must be referenced, so a missing one surfaces as
 * an "Unresolved prompt variable" failure.
 */
function seedPrompts(promptsDir: string): void {
  mkdirSync(join(promptsDir, "_shared"), { recursive: true });
  writeFileSync(join(promptsDir, "_shared", "banned_words.md"), "");
  writeFileSync(join(promptsDir, "_shared", "numbers_as_letters.md"), "");
  writeFileSync(join(promptsDir, "_shared", "audience_profile.md"), "");
  writeFileSync(join(promptsDir, "_shared", "format_guidelines.md"), "");
  writeFileSync(
    join(promptsDir, "04_extract_structure.md"),
    "EXTRACT|OUTLINE={{outline}}"
  );
  writeFileSync(
    join(promptsDir, "04_write_chapters_batch.md"),
    "WRITE_BATCH|CB={{chapters_block}}|O={{outline}}|SF={{story_so_far}}"
  );
  writeFileSync(
    join(promptsDir, "04_story_so_far.md"),
    "STORY|PREV={{story_so_far}}|NEW={{new_chapters}}"
  );
}

/**
 * Pre-seeds the outline file that step 1 would have written. Step 4
 * reads it from disk.
 */
function seedScriptInputs(
  projectsDir: string,
  videoId: string,
  overrides: { outline?: string } = {}
): string {
  const scriptDir = join(projectsDir, videoId, "script");
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(
    join(scriptDir, "01_outline.md"),
    overrides.outline ?? "OUTLINE-BODY"
  );
  return scriptDir;
}

/**
 * Fake chat that routes by prompt prefix. Each route can be overridden
 * per-test by the `responses` map, and extract-structure defaults to a
 * valid JSON reply so phase A parses cleanly. The returned object also
 * exposes a `calls` array for content assertions.
 */
interface ChatRecord {
  kind: "extract" | "chapter" | "story" | "unknown";
  content: string;
}
function makeFakeChat(
  structured: Array<{ number: number; title: string; summary: string }>
) {
  const calls: ChatRecord[] = [];
  let chapterResponder: (n: number) => string = (n) =>
    `CHAPTER-${n}-BODY`;
  let storyResponder: (n: number) => string = (n) =>
    `STORY-AFTER-${n}`;

  const chat = vi.fn(async (messages: { content: string }[]) => {
    const content = messages[0].content;
    if (content.startsWith("EXTRACT|")) {
      calls.push({ kind: "extract", content });
      return JSON.stringify(structured);
    }
    if (content.startsWith("WRITE_BATCH|")) {
      calls.push({ kind: "chapter", content });
      // Extract chapter numbers from the chapters_block field.
      const cbMatch = content.match(/\|CB=([\s\S]*?)\|O=/);
      const chaptersBlock = cbMatch?.[1] ?? "";
      const chapterNums = [...chaptersBlock.matchAll(/CHAPTER (\d+):/g)].map(
        (m) => Number(m[1])
      );
      const parts = chapterNums.map((n) => chapterResponder(n));
      return parts.join("\n---CHAPTER_BREAK---\n");
    }
    if (content.startsWith("STORY|")) {
      calls.push({ kind: "story", content });
      const batchCount = calls.filter((c) => c.kind === "chapter").length;
      return storyResponder(batchCount);
    }
    calls.push({ kind: "unknown", content });
    return "UNEXPECTED";
  });

  return {
    chat,
    calls,
    setChapterResponder(fn: (n: number) => string) {
      chapterResponder = fn;
    },
    setStoryResponder(fn: (n: number) => string) {
      storyResponder = fn;
    },
  };
}

afterEach(cleanup);

describe("write_chapters (step 4) — happy path", () => {
  it("extracts structure, writes one chapter, updates story_so_far", async () => {
    // Tracer: chapter_count=1 to cover both phases with minimal moving
    // parts. Verify the four file outputs and the three LLM calls in
    // the correct order.
    const db = freshDb();
    setSetting("script_length_minutes", 6, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);
    const scriptDir = seedScriptInputs(projectsDir, videoId);

    const fake = makeFakeChat([
      { number: 1, title: "The Beginning", summary: "It all begins." },
    ]);

    await writeChaptersStep.run(
      videoId,
      makeStepContext({ db, projectsDir, promptsDir, chat: fake.chat })
    );

    // Phase A output: parsed structured outline on disk.
    const structured = JSON.parse(
      readFileSync(
        join(scriptDir, "04_outline_structured.json"),
        "utf-8"
      )
    );
    expect(structured).toEqual([
      { number: 1, title: "The Beginning", summary: "It all begins." },
    ]);

    // Phase B outputs: chapter file + running summary.
    expect(
      readFileSync(join(scriptDir, "04_chapter_01.md"), "utf-8")
    ).toBe("CHAPTER-1-BODY");
    expect(
      readFileSync(join(scriptDir, "story_so_far.md"), "utf-8")
    ).toBe("STORY-AFTER-1");

    // Three LLM calls: extract → chapter 1 → story_so_far. In order.
    expect(fake.calls.map((c) => c.kind)).toEqual([
      "extract",
      "chapter",
      "story",
    ]);
  });

  it("skips Phase A when 04_outline_structured.json already exists (resume case)", async () => {
    // Spec :336-339 — Phase A is idempotent. On resume after a crash
    // mid-chapter, the structured JSON is already on disk and the step
    // must not re-call the extraction LLM.
    const db = freshDb();
    setSetting("script_length_minutes", 6, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);
    const scriptDir = seedScriptInputs(projectsDir, videoId);

    // Pre-seed the structured JSON — as if a previous run had completed
    // Phase A before crashing mid-chapter.
    writeFileSync(
      join(scriptDir, "04_outline_structured.json"),
      JSON.stringify([
        { number: 1, title: "Pre-existing", summary: "from prior run" },
      ])
    );

    const fake = makeFakeChat([
      { number: 1, title: "SHOULD-NOT-SEE", summary: "fallback" },
    ]);

    await writeChaptersStep.run(
      videoId,
      makeStepContext({ db, projectsDir, promptsDir, chat: fake.chat })
    );

    // No extract call — only chapter + story.
    expect(fake.calls.map((c) => c.kind)).toEqual(["chapter", "story"]);

    // The structured JSON on disk was NOT overwritten.
    const structured = JSON.parse(
      readFileSync(
        join(scriptDir, "04_outline_structured.json"),
        "utf-8"
      )
    );
    expect(structured[0].title).toBe("Pre-existing");

    // And the batch was generated against the pre-existing metadata.
    // The chapters_block includes the title from the structured JSON.
    const chapterCall = fake.calls.find((c) => c.kind === "chapter");
    expect(chapterCall?.content).toContain("CHAPTER 1: Pre-existing");
  });

  it("skips a batch when all its chapter files exist on disk (resume)", async () => {
    // With chapter_count=3, all 3 are in one batch. If all 3 exist on
    // disk, the batch is fully skipped — zero LLM calls.
    const db = freshDb();
    setSetting("script_length_minutes", 18, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);
    const scriptDir = seedScriptInputs(projectsDir, videoId);

    // Pre-seed: structured JSON + all 3 chapters + story_so_far.
    writeFileSync(
      join(scriptDir, "04_outline_structured.json"),
      JSON.stringify([
        { number: 1, title: "T1", summary: "S1" },
        { number: 2, title: "T2", summary: "S2" },
        { number: 3, title: "T3", summary: "S3" },
      ])
    );
    writeFileSync(join(scriptDir, "04_chapter_01.md"), "PRE-EXISTING 1");
    writeFileSync(join(scriptDir, "04_chapter_02.md"), "PRE-EXISTING 2");
    writeFileSync(join(scriptDir, "04_chapter_03.md"), "PRE-EXISTING 3");
    writeFileSync(join(scriptDir, "story_so_far.md"), "OLD SUMMARY");

    const fake = makeFakeChat([]);

    await writeChaptersStep.run(
      videoId,
      makeStepContext({ db, projectsDir, promptsDir, chat: fake.chat })
    );

    // No LLM calls at all — batch fully skipped.
    expect(fake.calls).toHaveLength(0);

    // Files were NOT overwritten.
    expect(readFileSync(join(scriptDir, "04_chapter_01.md"), "utf-8")).toBe(
      "PRE-EXISTING 1"
    );
    expect(readFileSync(join(scriptDir, "04_chapter_02.md"), "utf-8")).toBe(
      "PRE-EXISTING 2"
    );
    expect(readFileSync(join(scriptDir, "04_chapter_03.md"), "utf-8")).toBe(
      "PRE-EXISTING 3"
    );
  });

  it("skips completed batches but runs incomplete ones (cross-batch resume)", async () => {
    // chapter_count=6 → batch 1 (ch 1-3), batch 2 (ch 4-6). If batch 1
    // is fully on disk but batch 2 is missing, only batch 2 runs.
    const db = freshDb();
    setSetting("script_length_minutes", 36, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);
    const scriptDir = seedScriptInputs(projectsDir, videoId);

    const allChapters = [
      { number: 1, title: "T1", summary: "S1" },
      { number: 2, title: "T2", summary: "S2" },
      { number: 3, title: "T3", summary: "S3" },
      { number: 4, title: "T4", summary: "S4" },
      { number: 5, title: "T5", summary: "S5" },
      { number: 6, title: "T6", summary: "S6" },
    ];
    writeFileSync(
      join(scriptDir, "04_outline_structured.json"),
      JSON.stringify(allChapters)
    );
    // Batch 1 complete on disk.
    writeFileSync(join(scriptDir, "04_chapter_01.md"), "PRE 1");
    writeFileSync(join(scriptDir, "04_chapter_02.md"), "PRE 2");
    writeFileSync(join(scriptDir, "04_chapter_03.md"), "PRE 3");
    writeFileSync(join(scriptDir, "story_so_far.md"), "SUMMARY AFTER BATCH 1");

    const fake = makeFakeChat(allChapters);

    await writeChaptersStep.run(
      videoId,
      makeStepContext({ db, projectsDir, promptsDir, chat: fake.chat })
    );

    // Only batch 2 ran: one batch-write + one story call.
    expect(fake.calls.map((c) => c.kind)).toEqual(["chapter", "story"]);
    const batchCall = fake.calls.find((c) => c.kind === "chapter")!;
    // Batch 2 should contain chapters 4, 5, 6.
    expect(batchCall.content).toContain("CHAPTER 4:");
    expect(batchCall.content).toContain("CHAPTER 5:");
    expect(batchCall.content).toContain("CHAPTER 6:");
    // And it sees the pre-existing story_so_far.
    expect(batchCall.content).toContain("SF=SUMMARY AFTER BATCH 1");

    // Batch 1 files were NOT overwritten.
    expect(readFileSync(join(scriptDir, "04_chapter_01.md"), "utf-8")).toBe(
      "PRE 1"
    );

    // Batch 2 files were written.
    expect(
      readFileSync(join(scriptDir, "04_chapter_04.md"), "utf-8")
    ).toBe("CHAPTER-4-BODY");
    expect(
      readFileSync(join(scriptDir, "04_chapter_05.md"), "utf-8")
    ).toBe("CHAPTER-5-BODY");
    expect(
      readFileSync(join(scriptDir, "04_chapter_06.md"), "utf-8")
    ).toBe("CHAPTER-6-BODY");
  });

  it("passes the updated story_so_far from batch 1 into batch 2's prompt", async () => {
    // Spec :344 — the running summary from one batch must feed the next.
    // chapter_count=6 → 2 batches of 3. Batch 1 sees empty story_so_far,
    // batch 2 sees the summary generated after batch 1.
    const db = freshDb();
    setSetting("script_length_minutes", 36, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);
    seedScriptInputs(projectsDir, videoId);

    const allChapters = [
      { number: 1, title: "T1", summary: "S1" },
      { number: 2, title: "T2", summary: "S2" },
      { number: 3, title: "T3", summary: "S3" },
      { number: 4, title: "T4", summary: "S4" },
      { number: 5, title: "T5", summary: "S5" },
      { number: 6, title: "T6", summary: "S6" },
    ];
    const fake = makeFakeChat(allChapters);
    // storyResponder(N) is called with N = batch count so far.
    // After batch 1 → "AFTER-BATCH-1", after batch 2 → "AFTER-BATCH-2".
    fake.setStoryResponder((n) => `AFTER-BATCH-${n}`);

    await writeChaptersStep.run(
      videoId,
      makeStepContext({ db, projectsDir, promptsDir, chat: fake.chat })
    );

    const chapterCalls = fake.calls.filter((c) => c.kind === "chapter");
    expect(chapterCalls).toHaveLength(2);
    // Batch 1 sees empty story_so_far (initial run).
    expect(chapterCalls[0].content).toMatch(/SF=$/);
    // Batch 2 sees the summary produced after batch 1.
    expect(chapterCalls[1].content).toMatch(/SF=AFTER-BATCH-1$/);
  });
});

describe("write_chapters (step 4) — failure behavior", () => {
  it("writes no chapter files from a batch when the LLM call throws", async () => {
    // chapter_count=6 → batch 1 (ch 1-3), batch 2 (ch 4-6). The
    // chapterResponder throws on chapter 5, which is inside batch 2.
    // Batch 1 should be fully committed; batch 2 should leave no files.
    const db = freshDb();
    setSetting("script_length_minutes", 36, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);
    const scriptDir = seedScriptInputs(projectsDir, videoId);

    const allChapters = [
      { number: 1, title: "T1", summary: "S1" },
      { number: 2, title: "T2", summary: "S2" },
      { number: 3, title: "T3", summary: "S3" },
      { number: 4, title: "T4", summary: "S4" },
      { number: 5, title: "T5", summary: "S5" },
      { number: 6, title: "T6", summary: "S6" },
    ];
    const fake = makeFakeChat(allChapters);
    fake.setChapterResponder((n) => {
      if (n === 5) throw new Error("LLM exhausted retries on chapter 5");
      return `CHAPTER-${n}-BODY`;
    });

    await expect(
      writeChaptersStep.run(
        videoId,
        makeStepContext({ db, projectsDir, promptsDir, chat: fake.chat })
      )
    ).rejects.toThrow(/chapter 5/);

    // Batch 1 was fully committed.
    expect(existsSync(join(scriptDir, "04_chapter_01.md"))).toBe(true);
    expect(existsSync(join(scriptDir, "04_chapter_02.md"))).toBe(true);
    expect(existsSync(join(scriptDir, "04_chapter_03.md"))).toBe(true);
    // Batch 2 left no files — the throw happened inside the fake chat
    // before any chapter content was returned.
    expect(existsSync(join(scriptDir, "04_chapter_04.md"))).toBe(false);
    expect(existsSync(join(scriptDir, "04_chapter_05.md"))).toBe(false);
    expect(existsSync(join(scriptDir, "04_chapter_06.md"))).toBe(false);
  });

  it("tolerates a stray trailing separator on a single-chapter batch", async () => {
    // LLMs sometimes emit a trailing ---CHAPTER_BREAK--- on the final
    // batch even though the prompt forbids it. Most commonly seen when
    // chapter_count % BATCH_SIZE === 1 (the final batch is a single
    // chapter). The split must not interpret that as a missing chapter.
    const db = freshDb();
    // 7 chapters → batches of 3, 3, 1. The 1-chapter batch is the failure surface.
    setSetting("script_length_minutes", 42, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);
    const scriptDir = seedScriptInputs(projectsDir, videoId);

    const structured = [
      { number: 1, title: "T1", summary: "S1" },
      { number: 2, title: "T2", summary: "S2" },
      { number: 3, title: "T3", summary: "S3" },
      { number: 4, title: "T4", summary: "S4" },
      { number: 5, title: "T5", summary: "S5" },
      { number: 6, title: "T6", summary: "S6" },
      { number: 7, title: "T7", summary: "S7" },
    ];
    let chapterCallCount = 0;
    const chat = vi.fn(async (messages: { content: string }[]) => {
      const content = messages[0].content;
      if (content.startsWith("EXTRACT|")) return JSON.stringify(structured);
      if (content.startsWith("WRITE_BATCH|")) {
        chapterCallCount += 1;
        const cbMatch = content.match(/\|CB=([\s\S]*?)\|O=/);
        const chaptersBlock = cbMatch?.[1] ?? "";
        const nums = [...chaptersBlock.matchAll(/CHAPTER (\d+):/g)].map((m) =>
          Number(m[1])
        );
        const parts = nums.map((n) => `CHAPTER-${n}-BODY`);
        // The 3rd batch is the single-chapter one. Simulate the LLM
        // appending a stray trailing separator.
        if (chapterCallCount === 3) {
          return `${parts.join("\n---CHAPTER_BREAK---\n")}\n---CHAPTER_BREAK---\n`;
        }
        return parts.join("\n---CHAPTER_BREAK---\n");
      }
      return "STORY";
    });

    await writeChaptersStep.run(
      videoId,
      makeStepContext({ db, projectsDir, promptsDir, chat })
    );

    // The single-chapter file landed on disk with the expected body —
    // the trailing separator was tolerated, not parsed as an empty
    // second chapter.
    expect(readFileSync(join(scriptDir, "04_chapter_07.md"), "utf-8")).toBe(
      "CHAPTER-7-BODY"
    );
  });

  it("writes no chapter files when separator parsing produces wrong count", async () => {
    // If the LLM returns 2 parts instead of 3, the step should throw a
    // parse error and none of the batch's chapter files should exist.
    const db = freshDb();
    setSetting("script_length_minutes", 18, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);
    const scriptDir = seedScriptInputs(projectsDir, videoId);

    const structured = [
      { number: 1, title: "T1", summary: "S1" },
      { number: 2, title: "T2", summary: "S2" },
      { number: 3, title: "T3", summary: "S3" },
    ];
    // Build a chat mock that returns only 2 parts for a 3-chapter batch.
    const chat = vi.fn(async (messages: { content: string }[]) => {
      const content = messages[0].content;
      if (content.startsWith("EXTRACT|")) {
        return JSON.stringify(structured);
      }
      if (content.startsWith("WRITE_BATCH|")) {
        // Only 2 parts instead of 3 — missing separator.
        return "Part one\n---CHAPTER_BREAK---\nPart two";
      }
      return "STORY";
    });

    await expect(
      writeChaptersStep.run(
        videoId,
        makeStepContext({ db, projectsDir, promptsDir, chat })
      )
    ).rejects.toThrow(/expected 3 chapter.*got 2/i);

    // No chapter files from the batch were written.
    expect(existsSync(join(scriptDir, "04_chapter_01.md"))).toBe(false);
    expect(existsSync(join(scriptDir, "04_chapter_02.md"))).toBe(false);
    expect(existsSync(join(scriptDir, "04_chapter_03.md"))).toBe(false);
  });

  it("throws when structured outline has wrong chapter numbers", async () => {
    // If the LLM extraction returns chapters that don't match 1..chapter_count,
    // the step should fail-fast before entering the batch loop.
    const db = freshDb();
    setSetting("script_length_minutes", 18, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);
    const scriptDir = seedScriptInputs(projectsDir, videoId);

    // Pre-seed a structured JSON with only 2 chapters instead of 3.
    writeFileSync(
      join(scriptDir, "04_outline_structured.json"),
      JSON.stringify([
        { number: 1, title: "T1", summary: "S1" },
        { number: 2, title: "T2", summary: "S2" },
      ])
    );

    const fake = makeFakeChat([]);

    await expect(
      writeChaptersStep.run(
        videoId,
        makeStepContext({ db, projectsDir, promptsDir, chat: fake.chat })
      )
    ).rejects.toThrow(/expected \[1, 2, 3\]/);

    // No LLM calls were made — validation failed before the batch loop.
    expect(fake.calls).toHaveLength(0);
  });
});
