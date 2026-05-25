import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, seedDefaultSettings } from "@/lib/db";
import { setSetting } from "@/lib/settings";
import { step as generateVisualPromptsStep } from "@/worker/steps/09-generate-visual-prompts";
import * as videosRepo from "@/lib/repos/videos";
import type { Chunk } from "@/types";
import type { StepContext, Step } from "@/worker/pipeline";
import { makeStepContext } from "../../../helpers/step-fixtures";

/**
 * Boundary mock for the Claude CLI provider's `spawn`. Hoisted via
 * `vi.hoisted` so the mock factory and test code share the same `vi.fn()`.
 * The existing `generateVisualPromptsStep.run(...)` tests below don't
 * touch `child_process`, so this mock is inert for them.
 */
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    default: { ...actual, spawn: spawnMock },
    spawn: spawnMock,
  };
});

const tmpDirs: string[] = [];
const openDbs: DatabaseType[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `histforge-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
  // Step 09 post-processes every persisted prompt with the
  // style/negative lock segments seeded by DEFAULT_SETTINGS. The tests
  // in THIS file assert raw LLM-returned prompt strings (batching,
  // retry, parse, mutex semantics — none of them are about lock
  // semantics), so we blank both lock settings here to restore the
  // pre-lock contract. Lock-specific tests live in
  // __tests__/image/prompt-assembly.test.ts and lock-injection.test.ts.
  setSetting("style_lock_description", "", db);
  setSetting("character_lock_negative", "", db);
  openDbs.push(db);
  return db;
}

function seedVideo(
  db: DatabaseType,
  opts: { stylePrompt?: string } = {}
): string {
  const now = Date.now();
  const snapshot =
    opts.stylePrompt !== undefined
      ? JSON.stringify({ id: "vs_01", title: "Test Style", prompt: opts.stylePrompt })
      : null;
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at, visual_style_snapshot) VALUES (?, ?, ?, ?, 'in_progress', ?, ?)"
  ).run(
    "v_01",
    "The Fall of Constantinople",
    "1453, Ottoman siege",
    "comfyui",
    now,
    snapshot
  );
  return "v_01";
}

function makeChunks(count: number): Chunk[] {
  const chunks: Chunk[] = [];
  for (let i = 0; i < count; i++) {
    chunks.push({
      id: `image_${String(i + 1).padStart(3, "0")}`,
      kind: "image",
      start: i * 30,
      end: (i + 1) * 30,
      text: `Sentence group ${i + 1}.`,
      prompt: null,
    });
  }
  return chunks;
}

function seedChunksFile(projectsDir: string, videoId: string, chunks: Chunk[]): string {
  const chunksDir = join(projectsDir, videoId, "chunks");
  mkdirSync(chunksDir, { recursive: true });
  const chunksPath = join(chunksDir, "chunks.json");
  writeFileSync(chunksPath, JSON.stringify(chunks, null, 2), "utf-8");
  return chunksPath;
}

/**
 * Seed a stub `09_generate_visual_prompts.md` whose body lets tests
 * round-trip the batch JSON envelope. The real template is the static
 * safety preamble; the stub keeps just the placeholders so test
 * assertions can `JSON.parse` the BATCH= section. The empty `_shared/`
 * directory exists because `lib/prompts.ts:loadSharedFragments` calls
 * `readdirSync(_shared)` unconditionally and would otherwise throw —
 * the new template references no shared fragments, so no files inside.
 */
function seedPrompts(promptsDir: string): void {
  mkdirSync(join(promptsDir, "_shared"), { recursive: true });
  // ---END--- is a stable terminator so the test helper can extract
  // BATCH= even when the step appends a retry reminder to the user
  // prompt on attempt 2.
  writeFileSync(
    join(promptsDir, "09_generate_visual_prompts.md"),
    "STYLE={{style_prompt}}\nBATCH={{batch_json}}\n---END---"
  );
}

/**
 * Helper: build an envelope reply for a given batch of items.
 */
function envelopeReply(
  items: Array<{ id: string }>,
  promptFor: (id: string) => string
): string {
  return JSON.stringify({
    prompts: items.map((i) => ({ id: i.id, prompt: promptFor(i.id) })),
  });
}

/**
 * Helper: pull the batch JSON array out of a captured chat call. The
 * stub prompt embeds the batch_json verbatim after `BATCH=`.
 */
function extractBatch(content: string): Array<{
  id: string;
  prev_text: string;
  current_text: string;
  next_text: string;
}> {
  const start = content.indexOf("BATCH=");
  if (start < 0) throw new Error("stub prompt didn't render BATCH= section");
  const end = content.indexOf("\n---END---", start);
  if (end < 0) throw new Error("stub prompt didn't render ---END--- terminator");
  return JSON.parse(content.slice(start + "BATCH=".length, end));
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  while (openDbs.length) {
    const db = openDbs.pop()!;
    try { db.close(); } catch { /* ignore */ }
  }
});

describe("generate_visual_prompts (step 9) — batched JSON envelope", () => {
  it("slices the working set into K-sized batches and makes one LLM call per batch", async () => {
    // Tracer bullet: N=8 chunks, K=4 → exactly 2 chat() calls, each
    // carrying a 4-item JSON-array payload of {id, prev_text,
    // current_text, next_text}. Preserved order is load-bearing on
    // prev_text/next_text neighbourliness, which the next assertion
    // checks at the batch-edge boundary.
    const db = freshDb();
    setSetting("visual_prompts_batch_size", 4, db);
    const videoId = seedVideo(db, { stylePrompt: "cinematic dark" });
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    const chunks = makeChunks(8);
    const chunksPath = seedChunksFile(projectsDir, videoId, chunks);

    const chat = vi.fn(async (messages: { content: string }[]) => {
      const batch = extractBatch(messages[1].content);
      return envelopeReply(batch, (id) => `prompt-for-${id}`);
    });

    await generateVisualPromptsStep.run(
      videoId,
      makeStepContext({
        db,
        projectsDir,
        promptsDir,
        visualPromptsConcurrency: 1,
        visualPromptChat: chat,
      })
    );

    expect(chat).toHaveBeenCalledTimes(2);

    const b0 = extractBatch(chat.mock.calls[0][0][1].content as string);
    const b1 = extractBatch(chat.mock.calls[1][0][1].content as string);
    expect(b0).toHaveLength(4);
    expect(b1).toHaveLength(4);
    expect(b0.map((c) => c.id)).toEqual(
      ["image_001", "image_002", "image_003", "image_004"]
    );
    expect(b1.map((c) => c.id)).toEqual(
      ["image_005", "image_006", "image_007", "image_008"]
    );

    const result: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));
    for (let i = 0; i < 8; i++) {
      expect(result[i].prompt).toBe(`prompt-for-${result[i].id}`);
    }
  });

  it("carries prev_text and next_text across batch boundaries (neighbourliness is global, not per-batch)", async () => {
    const db = freshDb();
    setSetting("visual_prompts_batch_size", 2, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    seedChunksFile(projectsDir, videoId, makeChunks(4));

    const chat = vi.fn(async (messages: { content: string }[]) => {
      const batch = extractBatch(messages[1].content);
      return envelopeReply(batch, (id) => `p-${id}`);
    });

    await generateVisualPromptsStep.run(
      videoId,
      makeStepContext({
        db,
        projectsDir,
        promptsDir,
        visualPromptsConcurrency: 1,
        visualPromptChat: chat,
      })
    );

    const b0 = extractBatch(chat.mock.calls[0][0][1].content as string);
    const b1 = extractBatch(chat.mock.calls[1][0][1].content as string);

    // First batch (chunks 1..2): chunk 1's prev_text empty, chunk 2's
    // next_text comes from chunk 3 — across the batch boundary.
    expect(b0[0]).toMatchObject({ id: "image_001", prev_text: "", current_text: "Sentence group 1.", next_text: "Sentence group 2." });
    expect(b0[1]).toMatchObject({ id: "image_002", prev_text: "Sentence group 1.", current_text: "Sentence group 2.", next_text: "Sentence group 3." });

    // Second batch (chunks 3..4): chunk 3's prev_text comes from
    // chunk 2 — across the batch boundary; chunk 4's next_text empty.
    expect(b1[0]).toMatchObject({ id: "image_003", prev_text: "Sentence group 2.", current_text: "Sentence group 3.", next_text: "Sentence group 4." });
    expect(b1[1]).toMatchObject({ id: "image_004", prev_text: "Sentence group 3.", current_text: "Sentence group 4.", next_text: "" });
  });

  it("substitutes style_prompt once per call (not per chunk)", async () => {
    const db = freshDb();
    setSetting("visual_prompts_batch_size", 4, db);
    const videoId = seedVideo(db, { stylePrompt: "watercolor pastoral" });
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    seedChunksFile(projectsDir, videoId, makeChunks(4));
    const chat = vi.fn(async (messages: { content: string }[]) => {
      const batch = extractBatch(messages[1].content);
      return envelopeReply(batch, (id) => `p-${id}`);
    });

    await generateVisualPromptsStep.run(
      videoId,
      makeStepContext({
        db,
        projectsDir,
        promptsDir,
        visualPromptsConcurrency: 1,
        visualPromptChat: chat,
      })
    );

    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][0][1].content).toContain("STYLE=watercolor pastoral");
  });

  it("substitutes an empty style_prompt when visual_style_snapshot is NULL ('Default (no style)')", async () => {
    // Per plan Task 4.1: NULL snapshot is the documented "no style"
    // runtime state. Step 09 must hand the template an empty string,
    // not throw on JSON.parse and not look at any setting.
    const db = freshDb();
    setSetting("visual_prompts_batch_size", 4, db);
    const videoId = seedVideo(db); // no stylePrompt → snapshot NULL
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    seedChunksFile(projectsDir, videoId, makeChunks(2));
    const chat = vi.fn(async (messages: { content: string }[]) => {
      const batch = extractBatch(messages[1].content);
      return envelopeReply(batch, (id) => `p-${id}`);
    });

    await generateVisualPromptsStep.run(
      videoId,
      makeStepContext({
        db,
        projectsDir,
        promptsDir,
        visualPromptsConcurrency: 1,
        visualPromptChat: chat,
      })
    );

    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][0][1].content).toContain("STYLE=\nBATCH=");
  });

  it("ignores the legacy style_prompt_default setting — only visual_style_snapshot drives style_prompt", async () => {
    // Phase 4 cut: the old setting key is dead. Even if a row lingers
    // in the settings table (test seeds it manually here), step 09
    // must not read it. The snapshot is the only source of truth.
    const db = freshDb();
    setSetting("visual_prompts_batch_size", 4, db);
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
    ).run("style_prompt_default", "should-be-ignored");

    const videoId = seedVideo(db, { stylePrompt: "from-snapshot" });
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    seedChunksFile(projectsDir, videoId, makeChunks(1));
    const chat = vi.fn(async (messages: { content: string }[]) => {
      const batch = extractBatch(messages[1].content);
      return envelopeReply(batch, (id) => `p-${id}`);
    });

    await generateVisualPromptsStep.run(
      videoId,
      makeStepContext({
        db,
        projectsDir,
        promptsDir,
        visualPromptsConcurrency: 1,
        visualPromptChat: chat,
      })
    );

    const content = chat.mock.calls[0][0][1].content as string;
    expect(content).toContain("STYLE=from-snapshot");
    expect(content).not.toContain("should-be-ignored");
  });

  it("skips already-enriched chunks (only chunk.prompt === null is dispatched)", async () => {
    // Resume scenario: a prior partial run filled some chunks. Re-entry
    // must skip those and only dispatch the remaining null-prompt set —
    // critical so the dashboard's retry button is fast for resume.
    const db = freshDb();
    setSetting("visual_prompts_batch_size", 4, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    const chunks = makeChunks(4);
    chunks[0].prompt = "kept from earlier run";
    chunks[2].prompt = "also kept";
    const chunksPath = seedChunksFile(projectsDir, videoId, chunks);

    const chat = vi.fn(async (messages: { content: string }[]) => {
      const batch = extractBatch(messages[1].content);
      return envelopeReply(batch, (id) => `fresh-${id}`);
    });

    await generateVisualPromptsStep.run(
      videoId,
      makeStepContext({
        db,
        projectsDir,
        promptsDir,
        visualPromptsConcurrency: 1,
        visualPromptChat: chat,
      })
    );

    expect(chat).toHaveBeenCalledTimes(1);
    const batch = extractBatch(chat.mock.calls[0][0][1].content as string);
    expect(batch.map((c) => c.id)).toEqual(["image_002", "image_004"]);

    const result: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));
    expect(result[0].prompt).toBe("kept from earlier run");
    expect(result[1].prompt).toBe("fresh-image_002");
    expect(result[2].prompt).toBe("also kept");
    expect(result[3].prompt).toBe("fresh-image_004");
  });

  it("makes no LLM call when every chunk is already enriched", async () => {
    const db = freshDb();
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    const chunks = makeChunks(3);
    chunks.forEach((c, i) => (c.prompt = `existing-${i}`));
    seedChunksFile(projectsDir, videoId, chunks);

    const chat = vi.fn();

    await generateVisualPromptsStep.run(
      videoId,
      makeStepContext({
        db,
        projectsDir,
        promptsDir,
        visualPromptsConcurrency: 1,
        visualPromptChat: chat,
      })
    );

    expect(chat).not.toHaveBeenCalled();
  });

  it("resets prompt_history=[] on the to-regenerate subset BEFORE the first LLM call", async () => {
    // Eager-sweep semantics: the moderation lineage from a prior run
    // becomes meaningless the moment we decide to regenerate, so it
    // must be cleared before any work starts. A mid-step crash then
    // leaves consistent state.
    const db = freshDb();
    setSetting("visual_prompts_batch_size", 2, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    const chunks: Chunk[] = [
      {
        id: "image_001",
        kind: "image",
        start: 0,
        end: 30,
        text: "kept",
        prompt: "kept-prompt",
        prompt_history: ["history-that-must-stay"],
      },
      {
        id: "image_002",
        kind: "image",
        start: 30,
        end: 60,
        text: "regen me",
        prompt: null,
        prompt_history: ["should be cleared"],
      },
    ];
    const chunksPath = seedChunksFile(projectsDir, videoId, chunks);

    // Inspect chunks.json on disk at the moment of the first LLM call.
    let snapshotAtFirstCall: Chunk[] | null = null;
    const chat = vi.fn(async (messages: { content: string }[]) => {
      if (snapshotAtFirstCall === null) {
        snapshotAtFirstCall = JSON.parse(readFileSync(chunksPath, "utf-8"));
      }
      const batch = extractBatch(messages[1].content);
      return envelopeReply(batch, (id) => `fresh-${id}`);
    });

    await generateVisualPromptsStep.run(
      videoId,
      makeStepContext({
        db,
        projectsDir,
        promptsDir,
        visualPromptsConcurrency: 1,
        visualPromptChat: chat,
      })
    );

    expect(snapshotAtFirstCall).not.toBeNull();
    // chunk 1 was already enriched — its history is preserved.
    expect(snapshotAtFirstCall![0].prompt_history).toEqual([
      "history-that-must-stay",
    ]);
    // chunk 2 is in the to-regenerate set — its history was cleared.
    expect(snapshotAtFirstCall![1].prompt_history ?? []).toEqual([]);
  });

  it("retries the same batch once when the reply is missing one of the input ids", async () => {
    const db = freshDb();
    setSetting("visual_prompts_batch_size", 4, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    seedChunksFile(projectsDir, videoId, makeChunks(2));

    const chat = vi.fn()
      .mockResolvedValueOnce(
        // Missing image_002.
        JSON.stringify({ prompts: [{ id: "image_001", prompt: "p1" }] })
      )
      .mockImplementationOnce(async (messages: { content: string }[]) => {
        const batch = extractBatch(messages[1].content);
        return envelopeReply(batch, (id) => `retry-${id}`);
      });

    await generateVisualPromptsStep.run(
      videoId,
      makeStepContext({
        db,
        projectsDir,
        promptsDir,
        visualPromptsConcurrency: 1,
        visualPromptChat: chat,
      })
    );

    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("retries the same batch once when the reply contains an extra id not in the input", async () => {
    const db = freshDb();
    setSetting("visual_prompts_batch_size", 4, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    seedChunksFile(projectsDir, videoId, makeChunks(1));

    const chat = vi.fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          prompts: [
            { id: "image_001", prompt: "p1" },
            { id: "image_999", prompt: "extra" },
          ],
        })
      )
      .mockImplementationOnce(async (messages: { content: string }[]) => {
        const batch = extractBatch(messages[1].content);
        return envelopeReply(batch, (id) => `retry-${id}`);
      });

    await generateVisualPromptsStep.run(
      videoId,
      makeStepContext({
        db,
        projectsDir,
        promptsDir,
        visualPromptsConcurrency: 1,
        visualPromptChat: chat,
      })
    );

    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("retries the same batch once when any prompt value is an empty string", async () => {
    const db = freshDb();
    setSetting("visual_prompts_batch_size", 4, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    seedChunksFile(projectsDir, videoId, makeChunks(2));

    const chat = vi.fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          prompts: [
            { id: "image_001", prompt: "" },
            { id: "image_002", prompt: "p2" },
          ],
        })
      )
      .mockImplementationOnce(async (messages: { content: string }[]) => {
        const batch = extractBatch(messages[1].content);
        return envelopeReply(batch, (id) => `retry-${id}`);
      });

    await generateVisualPromptsStep.run(
      videoId,
      makeStepContext({
        db,
        projectsDir,
        promptsDir,
        visualPromptsConcurrency: 1,
        visualPromptChat: chat,
      })
    );

    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("retries the same batch once when an id appears twice in the reply", async () => {
    const db = freshDb();
    setSetting("visual_prompts_batch_size", 4, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    seedChunksFile(projectsDir, videoId, makeChunks(2));

    const chat = vi.fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          prompts: [
            { id: "image_001", prompt: "a" },
            { id: "image_001", prompt: "b" },
          ],
        })
      )
      .mockImplementationOnce(async (messages: { content: string }[]) => {
        const batch = extractBatch(messages[1].content);
        return envelopeReply(batch, (id) => `retry-${id}`);
      });

    await generateVisualPromptsStep.run(
      videoId,
      makeStepContext({
        db,
        projectsDir,
        promptsDir,
        visualPromptsConcurrency: 1,
        visualPromptChat: chat,
      })
    );

    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("falls back to per-chunk (K=1) calls when a batch parse-fails twice in a row", async () => {
    // Two consecutive failures on the same batch — the K=4 batch's
    // 3 chunks each get their own single-chunk batch call.
    const db = freshDb();
    setSetting("visual_prompts_batch_size", 4, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    const chunksPath = seedChunksFile(projectsDir, videoId, makeChunks(3));

    let call = 0;
    const chat = vi.fn(async (messages: { content: string }[]) => {
      call++;
      const batch = extractBatch(messages[1].content);
      // First two calls (the K=3 batch + its retry) parse-fail; the
      // remaining calls succeed as single-chunk batches.
      if (call <= 2) {
        return JSON.stringify({ prompts: [] }); // missing every id
      }
      expect(batch).toHaveLength(1);
      return envelopeReply(batch, (id) => `per-chunk-${id}`);
    });

    await generateVisualPromptsStep.run(
      videoId,
      makeStepContext({
        db,
        projectsDir,
        promptsDir,
        visualPromptsConcurrency: 1,
        visualPromptChat: chat,
      })
    );

    // 2 batch-mode attempts + 3 per-chunk calls = 5 total.
    expect(chat).toHaveBeenCalledTimes(5);

    const result: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));
    expect(result[0].prompt).toBe("per-chunk-image_001");
    expect(result[1].prompt).toBe("per-chunk-image_002");
    expect(result[2].prompt).toBe("per-chunk-image_003");
  });

  it("isolates the per-chunk fallback to the failing batch — sibling batches stay batched", async () => {
    // 7 chunks at K=4 → batches of sizes 4 and 3. If batch 1 (chunks
    // 1..4) parse-fails twice and falls back to per-chunk, batch 2
    // (chunks 5..7) must still go through as a single 3-item batch,
    // not as 3 per-chunk calls. The K=1 degradation is scoped to the
    // failing batch only.
    const db = freshDb();
    setSetting("visual_prompts_batch_size", 4, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    seedChunksFile(projectsDir, videoId, makeChunks(7));

    let call = 0;
    const chat = vi.fn(async (messages: { content: string }[]) => {
      call++;
      const batch = extractBatch(messages[1].content);
      // Calls 1 + 2 are batch 1 (K=4) and its retry, both parse-fail.
      // Calls 3-6 are batch 1's per-chunk fallback (K=1 each).
      // Call 7 is batch 2 as a single K=3 batch.
      if (call <= 2) return JSON.stringify({ prompts: [] });
      return envelopeReply(batch, (id) => `p-${id}`);
    });

    await generateVisualPromptsStep.run(
      videoId,
      makeStepContext({
        db,
        projectsDir,
        promptsDir,
        visualPromptsConcurrency: 1,
        visualPromptChat: chat,
      })
    );

    // 2 (batch 1 + retry) + 4 (per-chunk fallback) + 1 (batch 2) = 7.
    expect(chat).toHaveBeenCalledTimes(7);
    // Per-chunk fallback for batch 1: calls 3-6 each carry 1 item.
    expect(extractBatch(chat.mock.calls[2][0][1].content as string)).toHaveLength(1);
    expect(extractBatch(chat.mock.calls[3][0][1].content as string)).toHaveLength(1);
    expect(extractBatch(chat.mock.calls[4][0][1].content as string)).toHaveLength(1);
    expect(extractBatch(chat.mock.calls[5][0][1].content as string)).toHaveLength(1);
    // Batch 2 stayed batched — chunks 5..7 went through as a single call.
    const batch2 = extractBatch(chat.mock.calls[6][0][1].content as string);
    expect(batch2.map((c) => c.id)).toEqual(["image_005", "image_006", "image_007"]);
  });

  it("persists chunks.json after each successful batch (per-batch resume primitive)", async () => {
    const db = freshDb();
    setSetting("visual_prompts_batch_size", 2, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    const chunksPath = seedChunksFile(projectsDir, videoId, makeChunks(4));

    let call = 0;
    const chat = vi.fn(async (messages: { content: string }[]) => {
      call++;
      if (call === 2) throw new Error("LLM crashed");
      const batch = extractBatch(messages[1].content);
      return envelopeReply(batch, (id) => `p-${id}`);
    });

    await expect(
      generateVisualPromptsStep.run(
        videoId,
        makeStepContext({
          db,
          projectsDir,
          promptsDir,
          visualPromptsConcurrency: 1,
          visualPromptChat: chat,
        })
      )
    ).rejects.toThrow();

    // First batch (chunks 1..2) settled and persisted; second batch
    // (chunks 3..4) crashed and stayed null.
    const partial: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));
    expect(partial[0].prompt).toBe("p-image_001");
    expect(partial[1].prompt).toBe("p-image_002");
    expect(partial[2].prompt).toBeNull();
    expect(partial[3].prompt).toBeNull();
  });

  it("serializes chunks.json writes when batches finish concurrently", async () => {
    // With concurrency=2 the two batches run in parallel and finish
    // around the same time. The mutex must serialize the writes so the
    // final file carries both batches' results — no torn JSON, no lost
    // batch.
    const db = freshDb();
    setSetting("visual_prompts_batch_size", 2, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    const chunksPath = seedChunksFile(projectsDir, videoId, makeChunks(4));

    // Resolve in reverse arrival order — the *second* batch sent in
    // resolves first. If writes weren't serialized, the slower (first)
    // batch's write could land on top of the faster batch's, dropping
    // the latter. A mutex prevents that.
    const gates: Array<() => void> = [];
    const chat = vi.fn(async (messages: { content: string }[]) => {
      const batch = extractBatch(messages[1].content);
      await new Promise<void>((resolve) => gates.push(resolve));
      return envelopeReply(batch, (id) => `p-${id}`);
    });

    const run = generateVisualPromptsStep.run(
      videoId,
      makeStepContext({
        db,
        projectsDir,
        promptsDir,
        visualPromptsConcurrency: 2,
        visualPromptChat: chat,
      })
    );

    // Give the worker pool a beat to dispatch both batches.
    await new Promise((r) => setTimeout(r, 5));
    expect(gates).toHaveLength(2);
    // Release second batch first, then first.
    gates[1]();
    gates[0]();

    await run;

    const result: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));
    expect(result[0].prompt).toBe("p-image_001");
    expect(result[1].prompt).toBe("p-image_002");
    expect(result[2].prompt).toBe("p-image_003");
    expect(result[3].prompt).toBe("p-image_004");
  });

  it("stops siblings from picking new batches once one worker has thrown", async () => {
    // 6 chunks at K=2, concurrency=2 → 3 batches. Both workers
    // dispatch their initial batches (0 and 1). If batch 0 throws a
    // transport error, the worker that's still running batch 1 must
    // finish its current batch but NOT pick batch 2 — otherwise a
    // failed step keeps burning LLM calls + writing chunks.json after
    // the orchestrator has already marked it failed.
    const db = freshDb();
    setSetting("visual_prompts_batch_size", 2, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    seedChunksFile(projectsDir, videoId, makeChunks(6));

    type Gate = {
      batch: Array<{ id: string }>;
      resolve: (value: string) => void;
      reject: (err: Error) => void;
    };
    const gates: Gate[] = [];
    const chat = vi.fn(async (messages: { content: string }[]) => {
      const batch = extractBatch(messages[1].content);
      return new Promise<string>((resolve, reject) => {
        gates.push({ batch, resolve, reject });
      });
    });

    const run = generateVisualPromptsStep.run(
      videoId,
      makeStepContext({
        db,
        projectsDir,
        promptsDir,
        visualPromptsConcurrency: 2,
        visualPromptChat: chat,
      })
    );

    // Both workers dispatch their initial batches.
    await new Promise((r) => setTimeout(r, 5));
    expect(gates).toHaveLength(2);

    // Reject batch 0 first so the throw propagates and `stop` is set
    // before batch 1's worker loops back to its while condition.
    gates[0].reject(new Error("LLM crashed"));
    gates[1].resolve(JSON.stringify({
      prompts: gates[1].batch.map((b) => ({ id: b.id, prompt: `p-${b.id}` })),
    }));

    await expect(run).rejects.toThrow("LLM crashed");

    // Give any in-flight microtasks time to settle. Without the
    // short-circuit, the worker that finished batch 1 would have
    // picked batch 2 and dispatched a third chat call by now.
    await new Promise((r) => setTimeout(r, 10));
    expect(chat).toHaveBeenCalledTimes(2);
    expect(gates).toHaveLength(2);
  });

  it("exports step with name 'generate_visual_prompts'", async () => {
    const { step } = await import("@/worker/steps/09-generate-visual-prompts");
    expect(step.name).toBe("generate_visual_prompts");
    expect(typeof step.run).toBe("function");
  });
});

// ─── Invariant — chat vs visualPromptChat routing ─────────────────────
// Step 09 dispatches its LLM call through `ctx.visualPromptChat`, not
// `ctx.chat`. Two regression guards live here:
//   1. The step's `run` adapter picks `ctx.visualPromptChat`.
//   2. `ctx.visualPromptChat` is bound to the workflow snapshot's
//      `script_llm_provider` (same provider as `ctx.chat`) but with the
//      provider's `<provider>_visual_model` injected as the default.
//      The legacy `enrich_chunks_llm_provider` global setting is gone —
//      visual-prompt generation now follows the snapshot, like every other
//      in-flight knob.

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.kill = vi.fn();
  return child;
}

describe("generate_visual_prompts routing — chat vs visualPromptChat (Invariant E)", () => {
  it("step.run dispatches the LLM call through ctx.visualPromptChat, not ctx.chat", async () => {
    const db = freshDb();
    const videoId = seedVideo(db, { stylePrompt: "style" });
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);
    seedChunksFile(projectsDir, videoId, makeChunks(1));

    const chat = vi.fn().mockResolvedValue(
      JSON.stringify({ prompts: [{ id: "image_001", prompt: "p" }] })
    );
    const visualPromptChat = vi.fn().mockResolvedValue(
      JSON.stringify({ prompts: [{ id: "image_001", prompt: "p" }] })
    );

    const { step } = await import("@/worker/steps/09-generate-visual-prompts");
    const ctx = makeStepContext({ db, projectsDir, promptsDir, chat, visualPromptChat });

    await step.run(videoId, ctx);

    expect(visualPromptChat).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();
  });
});

describe("visualPromptChat resolution is snapshot-pinned (uses the visual model)", () => {
  /**
   * Capture-step approach: drop a no-op step into runPipeline whose only
   * job is to grab the ctx the orchestrator built. We then call
   * `ctx.visualPromptChat` directly and observe which boundary (fetch for
   * openrouter, spawn for claude-cli) got hit, and with which model. This
   * isolates the resolveDeps wiring from the rest of step 09.
   */
  let originalFetch: typeof fetch;
  const fetchMock = vi.fn();

  beforeEach(() => {
    spawnMock.mockReset();
    originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockReset();
    process.env.OPENROUTER_API_KEY = "test-key";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.OPENROUTER_API_KEY;
  });

  function captureStep(): { step: Step; getCtx: () => StepContext } {
    let captured: StepContext | undefined;
    const step: Step = {
      name: "capture",
      module: "glue",
      label: "Capture",
      description: "test capture step",
      outputs: [],
      run: async (_videoId, ctx) => {
        captured = ctx;
      },
    };
    return {
      step,
      getCtx: () => {
        if (!captured) throw new Error("capture step never ran");
        return captured;
      },
    };
  }

  it("visualPromptChat targets the visual model (not the script model) for the snapshot-pinned provider", async () => {
    // Both built-in workflows pin `script_llm_provider: "openrouter"`, so
    // visualPromptChat goes to openrouter — and the model it carries is
    // `openrouter_visual_model`, not `openrouter_script_model`. This
    // proves Task 2.4's wrapper split (script vs visual) reaches the wire.
    const db = freshDb();
    setSetting("openrouter_script_model", "script-tier-model", db);
    setSetting("openrouter_visual_model", "visual-tier-model", db);

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "or-reply" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const { runPipeline } = await import("@/worker/pipeline");

    videosRepo.createNewVideo(db, {
      id: "v_or",
      title: "T",
      topic_info: "t",
      workflow_id: "comfyui",
      created_at: 1,
    });
    videosRepo.transitionNewToQueued(db, "v_or");
    const cap = captureStep();
    await runPipeline("v_or", {
      db,
      steps: [cap.step],
      projectsDir: tempDir("projects"),
    });
    await cap.getCtx().visualPromptChat([{ role: "user", content: "hi" }], {
      retryDelayMs: 0,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.model).toBe("visual-tier-model");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("opts.model on the call site overrides the visual-model fallback (moderator override path)", async () => {
    // The Google Flow moderator passes `opts.model =
    // google_flow_content_moderation_model` when non-empty. The wrapper
    // must let that override layer on top of the visual-model fallback.
    const db = freshDb();
    setSetting("openrouter_visual_model", "visual-tier-model", db);

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const { runPipeline } = await import("@/worker/pipeline");

    videosRepo.createNewVideo(db, {
      id: "v_or",
      title: "T",
      topic_info: "t",
      workflow_id: "comfyui",
      created_at: 1,
    });
    videosRepo.transitionNewToQueued(db, "v_or");
    const cap = captureStep();
    await runPipeline("v_or", {
      db,
      steps: [cap.step],
      projectsDir: tempDir("projects"),
    });
    await cap.getCtx().visualPromptChat([{ role: "user", content: "hi" }], {
      model: "moderator-override-model",
      retryDelayMs: 0,
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.model).toBe("moderator-override-model");
  });

  it("ctx.visualPromptsConcurrency resolves from openrouter_visual_prompts_concurrency when the snapshot pins openrouter", async () => {
    // Snapshot-pinned per-purpose resolution: when the workflow's
    // script_llm_provider is "openrouter", ctx.visualPromptsConcurrency
    // mirrors openrouter_visual_prompts_concurrency. The Claude-CLI
    // knob is irrelevant on this video.
    const db = freshDb();
    setSetting("openrouter_visual_prompts_concurrency", 17, db);
    setSetting("claude_cli_visual_prompts_concurrency", 3, db);

    const { runPipeline } = await import("@/worker/pipeline");

    videosRepo.createNewVideo(db, {
      id: "v_or",
      title: "T",
      topic_info: "t",
      workflow_id: "comfyui",
      created_at: 1,
    });
    videosRepo.transitionNewToQueued(db, "v_or");
    const cap = captureStep();
    await runPipeline("v_or", {
      db,
      steps: [cap.step],
      projectsDir: tempDir("projects"),
    });

    expect(cap.getCtx().visualPromptsConcurrency).toBe(17);
  });

  it("ctx.visualPromptsConcurrency resolves from claude_cli_visual_prompts_concurrency when the snapshot pins claude_cli", async () => {
    // Symmetric to the openrouter test above. Neither built-in
    // workflow ships pinned to Claude CLI, so the seeded workflow row
    // is rewritten before the snapshot is stamped at queue time —
    // `transitionNewToQueued` re-resolves the snapshot from the live
    // workflow row, picking up the updated provider.
    const db = freshDb();
    setSetting("openrouter_visual_prompts_concurrency", 17, db);
    setSetting("claude_cli_visual_prompts_concurrency", 5, db);
    db.prepare(
      "UPDATE workflows SET script_llm_provider = 'claude_cli' WHERE id = 'comfyui'"
    ).run();

    const { runPipeline } = await import("@/worker/pipeline");

    videosRepo.createNewVideo(db, {
      id: "v_cc",
      title: "T",
      topic_info: "t",
      workflow_id: "comfyui",
      created_at: 1,
    });
    videosRepo.transitionNewToQueued(db, "v_cc");
    const cap = captureStep();
    await runPipeline("v_cc", {
      db,
      steps: [cap.step],
      projectsDir: tempDir("projects"),
    });

    expect(cap.getCtx().visualPromptsConcurrency).toBe(5);
  });
});
