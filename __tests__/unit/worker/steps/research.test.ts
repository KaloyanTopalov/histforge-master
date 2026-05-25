import { describe, it, expect, afterEach, vi } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setSetting } from "@/lib/settings";
import {
  MAX_OUTLINE_REPAIR_ATTEMPTS,
  countChapterBlocks,
  step as researchOutlineStep,
} from "@/worker/steps/01-research-outline";
import {
  cleanup,
  freshDb,
  makeStepContext,
  tempDir,
} from "../../../helpers/step-fixtures";

/**
 * Builds a stub outline with `count` chapter blocks in the `**Title**`
 * format that the count heuristic looks for. Acts/separators don't
 * matter for the count check, so we keep the body minimal.
 */
function buildOutline(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `**Chapter ${i + 1}**\n\nA paragraph with details.`
  ).join("\n\n");
}

/**
 * Tests for step 1. Exercises the DB → prompt → LLM → file wiring with
 * a fake `chat` implementation injected via StepContext — so the test
 * doesn't need to mock `global.fetch` or touch the network at all.
 */

/**
 * Seeds an in_progress video with title + topic_info columns (post-overhaul
 * schema — the topics table is gone). Returns the video id.
 */
function seedVideo(
  db: DatabaseType,
  overrides: { title?: string; topic_info?: string } = {}
): string {
  const now = Date.now();
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, 'in_progress', ?)"
  ).run(
    "v_01",
    overrides.title ?? "The Fall of Constantinople",
    overrides.topic_info ?? "1453, Ottoman siege, Mehmed II",
    "comfyui",
    now
  );
  return "v_01";
}

/**
 * Writes the minimum prompt files the steps need. The fake chat never
 * actually parses them — we just need render() to succeed, which means
 * every {{var}} referenced in the file must be supplied. Tests pin which
 * vars each step passes by making the prompt file reference them.
 */
function seedPrompts(promptsDir: string): void {
  mkdirSync(join(promptsDir, "_shared"), { recursive: true });
  // Shared fragments auto-loaded by render(). Empty content is fine.
  writeFileSync(join(promptsDir, "_shared", "audience_profile.md"), "");
  writeFileSync(join(promptsDir, "_shared", "banned_words.md"), "");
  writeFileSync(join(promptsDir, "_shared", "numbers_as_letters.md"), "");
  writeFileSync(join(promptsDir, "_shared", "format_guidelines.md"), "");
  // Reference every var the outline step is required to inject, so a
  // missing one surfaces as an "Unresolved prompt variable" failure.
  writeFileSync(
    join(promptsDir, "01_research_outline.md"),
    "TITLE={{title}}|INFO={{topic_info}}|CHAPTERS={{chapter_count}}|AUD={{audience_profile}}|BAN={{banned_words}}|NUM={{numbers_as_letters}}"
  );
  // The repair prompt references the same context vars as the initial
  // prompt plus the running outline / counts. Pinning every var here
  // matches the production template's expected surface.
  writeFileSync(
    join(promptsDir, "01_outline_repair.md"),
    "REPAIR|TITLE={{title}}|INFO={{topic_info}}|CHAPTERS={{chapter_count}}|CURRENT={{current_count}}|MISSING={{missing_count}}|OUTLINE={{outline}}|AUD={{audience_profile}}|BAN={{banned_words}}|NUM={{numbers_as_letters}}"
  );
  // Mirror prompt for the over-delivery branch. Same context vars as
  // the under-delivery repair plus the extra_count var the step
  // interpolates in place of missing_count.
  writeFileSync(
    join(promptsDir, "01_outline_trim.md"),
    "TRIM|TITLE={{title}}|INFO={{topic_info}}|CHAPTERS={{chapter_count}}|CURRENT={{current_count}}|EXTRA={{extra_count}}|OUTLINE={{outline}}|AUD={{audience_profile}}|BAN={{banned_words}}|NUM={{numbers_as_letters}}"
  );
}

afterEach(cleanup);

describe("research_outline (step 1)", () => {
  it("renders the outline prompt with topic + settings vars and writes script/01_outline.md with the LLM reply when the chapter count matches", async () => {
    const db = freshDb();
    setSetting("script_length_minutes", 90, db);
    const videoId = seedVideo(db, {
      title: "The Fall of Constantinople",
      topic_info: "1453, Ottoman siege, Mehmed II",
    });
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    // The reply must contain exactly chapter_count `**Title**` blocks
    // or the repair loop kicks in and we'd see additional chat calls.
    const validOutline = buildOutline(15);
    const chat = vi.fn().mockResolvedValue(validOutline);

    await researchOutlineStep.run(
      videoId,
      makeStepContext({ db, projectsDir, promptsDir, chat })
    );

    // The LLM got a single user message whose content is the fully
    // rendered prompt — every {{var}} substituted from DB state.
    expect(chat).toHaveBeenCalledOnce();
    const [messages] = chat.mock.calls[0];
    expect(messages).toEqual([
      {
        role: "user",
        content:
          "TITLE=The Fall of Constantinople|INFO=1453, Ottoman siege, Mehmed II|CHAPTERS=15|AUD=|BAN=|NUM=",
      },
    ]);

    // And the reply landed verbatim on disk at the spec-mandated path.
    const outlinePath = join(
      projectsDir,
      videoId,
      "script",
      "01_outline.md"
    );
    expect(readFileSync(outlinePath, "utf-8")).toBe(validOutline);
  });

  it("invokes the repair prompt and overwrites the outline when the initial reply is short on chapters", async () => {
    const db = freshDb();
    setSetting("script_length_minutes", 90, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    const shortOutline = buildOutline(12);
    const fullOutline = buildOutline(15);
    const chat = vi
      .fn()
      .mockResolvedValueOnce(shortOutline) // initial
      .mockResolvedValueOnce(fullOutline); // first repair, count now matches

    await researchOutlineStep.run(
      videoId,
      makeStepContext({ db, projectsDir, promptsDir, chat })
    );

    expect(chat).toHaveBeenCalledTimes(2);
    // The second call rendered the repair template — verify the
    // {{current_count}} / {{missing_count}} / {{outline}} placeholders
    // were filled from the first reply.
    const [secondMessages] = chat.mock.calls[1];
    expect(secondMessages[0].content).toContain("REPAIR|");
    expect(secondMessages[0].content).toContain("CHAPTERS=15");
    expect(secondMessages[0].content).toContain("CURRENT=12");
    expect(secondMessages[0].content).toContain("MISSING=3");
    expect(secondMessages[0].content).toContain(`OUTLINE=${shortOutline}`);

    const outlinePath = join(
      projectsDir,
      videoId,
      "script",
      "01_outline.md"
    );
    expect(readFileSync(outlinePath, "utf-8")).toBe(fullOutline);
  });

  it("throws after MAX_OUTLINE_REPAIR_ATTEMPTS when the LLM keeps under-delivering, surfacing the shortfall instead of letting step 4 catch it later", async () => {
    const db = freshDb();
    setSetting("script_length_minutes", 90, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    // Every reply is short. The loop must give up after the configured
    // max attempts and throw — orchestrator cleanup then deletes
    // script/01_outline.md, and the dashboard retry button re-runs the
    // step from scratch (which may roll a compliant reply, or the
    // operator can lower script_length_minutes first).
    const shortReply = buildOutline(12);
    const chat = vi.fn().mockResolvedValue(shortReply);

    await expect(
      researchOutlineStep.run(
        videoId,
        makeStepContext({ db, projectsDir, promptsDir, chat })
      )
    ).rejects.toThrow(
      /Outline has 12 chapter\(s\) after 3 LLM attempts \(expected 15\)/
    );

    // initial + MAX_OUTLINE_REPAIR_ATTEMPTS repair calls before giving up
    expect(chat).toHaveBeenCalledTimes(1 + MAX_OUTLINE_REPAIR_ATTEMPTS);

    // The latest reply was still written to disk before the throw —
    // operator can inspect it via the project directory even though the
    // orchestrator will clean it up as part of failure handling.
    const outlinePath = join(
      projectsDir,
      videoId,
      "script",
      "01_outline.md"
    );
    expect(readFileSync(outlinePath, "utf-8")).toBe(shortReply);
  });

  it("accepts ATX-style `## Title` headings as chapter markers when the LLM uses markdown headers instead of bold-wrapped titles (OpenRouter→Bedrock Claude Haiku 4.5 does this)", async () => {
    const db = freshDb();
    setSetting("script_length_minutes", 6, db); // 1 chapter
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    // Real reply shape observed from `anthropic/claude-haiku-4.5` via
    // OpenRouter on this exact prompt — one `#` outline title plus one
    // `##` chapter heading. The bold-wrapped regex would count 0 here,
    // but the ATX-h2 fallback should recognize it as 1 chapter.
    const atxOutline = [
      "# THE GREAT INVASION",
      "",
      "## CHAPTER ONE: THE OPENING MOVE",
      "",
      "A paragraph with specific dates and numbers. Another sentence.",
    ].join("\n");
    const chat = vi.fn().mockResolvedValue(atxOutline);

    await researchOutlineStep.run(
      videoId,
      makeStepContext({ db, projectsDir, promptsDir, chat })
    );

    // No repair calls — the initial reply satisfied the count.
    expect(chat).toHaveBeenCalledOnce();
    const outlinePath = join(
      projectsDir,
      videoId,
      "script",
      "01_outline.md"
    );
    expect(readFileSync(outlinePath, "utf-8")).toBe(atxOutline);
  });

  it("countChapterBlocks counts bold-wrapped `**Title**` lines and ATX `## Title` lines, preferring whichever style yields more", () => {
    // Bold-wrapped style — the prompt's preferred shape.
    expect(countChapterBlocks(buildOutline(3))).toBe(3);

    // Pure ATX-h2 style.
    expect(
      countChapterBlocks(
        ["## One", "body", "", "## Two", "body", "", "## Three", "body"].join(
          "\n"
        )
      )
    ).toBe(3);

    // Mixed reply with an `#` outline title above `##` chapters — h1
    // must not be counted as a chapter, only the two h2 chapters.
    expect(
      countChapterBlocks(
        ["# Outline Title", "", "## One", "body", "", "## Two", "body"].join(
          "\n"
        )
      )
    ).toBe(2);

    // Mixed reply with both styles — return the higher count (the
    // bold-wrapped chapters), since real outlines don't intermix.
    expect(
      countChapterBlocks(
        [
          "**One**",
          "body",
          "",
          "**Two**",
          "body",
          "",
          "## Notes",
          "stray h2 reference",
        ].join("\n")
      )
    ).toBe(2);

    // Empty / titleless outlines count as 0 — the failure path.
    expect(countChapterBlocks("")).toBe(0);
    expect(countChapterBlocks("Just prose, no headings.")).toBe(0);
  });

  it("invokes the trim prompt and overwrites the outline when the initial reply over-delivers on chapters", async () => {
    const db = freshDb();
    setSetting("script_length_minutes", 6, db); // 1 chapter
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    // Real-world failure: the prompt's four-phase emotional arc nudges
    // the LLM toward many chapters even when the operator asked for 1.
    // Step 1 must consolidate via 01_outline_trim.md rather than passing
    // the over-count outline downstream where step 4 throws.
    const longOutline = buildOutline(8);
    const trimmedOutline = buildOutline(1);
    const chat = vi
      .fn()
      .mockResolvedValueOnce(longOutline) // initial
      .mockResolvedValueOnce(trimmedOutline); // first trim, count now matches

    await researchOutlineStep.run(
      videoId,
      makeStepContext({ db, projectsDir, promptsDir, chat })
    );

    expect(chat).toHaveBeenCalledTimes(2);
    // The second call rendered the trim template — verify the
    // {{current_count}} / {{extra_count}} / {{outline}} placeholders
    // were filled from the first reply.
    const [secondMessages] = chat.mock.calls[1];
    expect(secondMessages[0].content).toContain("TRIM|");
    expect(secondMessages[0].content).toContain("CHAPTERS=1");
    expect(secondMessages[0].content).toContain("CURRENT=8");
    expect(secondMessages[0].content).toContain("EXTRA=7");
    expect(secondMessages[0].content).toContain(`OUTLINE=${longOutline}`);

    const outlinePath = join(
      projectsDir,
      videoId,
      "script",
      "01_outline.md"
    );
    expect(readFileSync(outlinePath, "utf-8")).toBe(trimmedOutline);
  });

  it("throws after MAX_OUTLINE_REPAIR_ATTEMPTS when the LLM keeps over-delivering, surfacing the count mismatch in step 1 rather than letting step 4 fail later", async () => {
    const db = freshDb();
    setSetting("script_length_minutes", 6, db); // 1 chapter
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    // Every reply over-delivers. The loop must give up after the
    // configured max attempts and throw — the orchestrator's cleanup
    // then deletes script/01_outline.md and the dashboard retry button
    // re-runs the step from scratch.
    const longReply = buildOutline(8);
    const chat = vi.fn().mockResolvedValue(longReply);

    await expect(
      researchOutlineStep.run(
        videoId,
        makeStepContext({ db, projectsDir, promptsDir, chat })
      )
    ).rejects.toThrow(
      /Outline has 8 chapter\(s\) after 3 LLM attempts \(expected 1\)/
    );

    expect(chat).toHaveBeenCalledTimes(1 + MAX_OUTLINE_REPAIR_ATTEMPTS);

    const outlinePath = join(
      projectsDir,
      videoId,
      "script",
      "01_outline.md"
    );
    expect(readFileSync(outlinePath, "utf-8")).toBe(longReply);
  });
});
