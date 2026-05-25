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
import { runEnrichChunks } from "@/worker/steps/09-enrich-chunks";
import * as videosRepo from "@/lib/repos/videos";
import type { Chunk } from "@/types";
import type { StepContext, Step } from "@/worker/pipeline";

/**
 * Boundary mock for the Claude CLI provider's `spawn`. Hoisted via
 * `vi.hoisted` so the mock factory and test code share the same `vi.fn()`.
 * The existing `runEnrichChunks(...)` tests below don't touch
 * `child_process`, so this mock is inert for them.
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
  openDbs.push(db);
  return db;
}

function seedVideo(db: DatabaseType): string {
  const now = Date.now();
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, 'in_progress', ?)"
  ).run(
    "v_01",
    "The Fall of Constantinople",
    "1453, Ottoman siege",
    "comfyui",
    now
  );
  return "v_01";
}

function makeChunks(count: number): Chunk[] {
  const chunks: Chunk[] = [];
  for (let i = 0; i < count; i++) {
    chunks.push({
      id: `main_${String(i + 1).padStart(3, "0")}`,
      kind: "main",
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

function seedPrompts(promptsDir: string): void {
  mkdirSync(join(promptsDir, "_shared"), { recursive: true });
  writeFileSync(join(promptsDir, "_shared", "audience_profile.md"), "");
  writeFileSync(join(promptsDir, "_shared", "banned_words.md"), "");
  writeFileSync(join(promptsDir, "_shared", "numbers_as_letters.md"), "");
  writeFileSync(join(promptsDir, "_shared", "format_guidelines.md"), "");
  writeFileSync(
    join(promptsDir, "09_enrich_chunk.md"),
    "PREV={{prev_text}}|CUR={{current_text}}|NEXT={{next_text}}|STYLE={{style_prompt}}"
  );
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

describe("enrich_chunks (step 9)", () => {
  it("calls LLM once per chunk and writes prompt into each chunk in place", async () => {
    const db = freshDb();
    setSetting("style_prompt_default", "cinematic dark", db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    const chunks = makeChunks(3);
    const chunksPath = seedChunksFile(projectsDir, videoId, chunks);

    const chat = vi.fn()
      .mockResolvedValueOnce("visual prompt 1")
      .mockResolvedValueOnce("visual prompt 2")
      .mockResolvedValueOnce("visual prompt 3");

    await runEnrichChunks(videoId, { db, projectsDir, promptsDir, chat });

    expect(chat).toHaveBeenCalledTimes(3);

    const result: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));
    expect(result[0].prompt).toBe("visual prompt 1");
    expect(result[1].prompt).toBe("visual prompt 2");
    expect(result[2].prompt).toBe("visual prompt 3");
  });

  it("passes empty prev_text for first chunk and empty next_text for last chunk", async () => {
    const db = freshDb();
    setSetting("style_prompt_default", "oil painting", db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    const chunks = makeChunks(3);
    seedChunksFile(projectsDir, videoId, chunks);

    const chat = vi.fn().mockResolvedValue("prompt");

    await runEnrichChunks(videoId, { db, projectsDir, promptsDir, chat });

    // First chunk: prev_text is empty
    const call0 = chat.mock.calls[0][0][0].content as string;
    expect(call0).toContain("PREV=|");

    // Middle chunk: both neighbors present
    const call1 = chat.mock.calls[1][0][0].content as string;
    expect(call1).toContain("PREV=Sentence group 1.|");
    expect(call1).toContain("NEXT=Sentence group 3.");

    // Last chunk: next_text is empty
    const call2 = chat.mock.calls[2][0][0].content as string;
    expect(call2).toContain("|NEXT=|");
  });

  it("uses style_prompt_default from settings as the style prompt", async () => {
    const db = freshDb();
    setSetting("style_prompt_default", "watercolor pastoral", db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    seedChunksFile(projectsDir, videoId, makeChunks(1));
    const chat = vi.fn().mockResolvedValue("enriched");

    await runEnrichChunks(videoId, { db, projectsDir, promptsDir, chat });

    const content = chat.mock.calls[0][0][0].content as string;
    expect(content).toContain("STYLE=watercolor pastoral");
  });

  it("persists chunks.json after each LLM call so partial progress survives a crash", async () => {
    const db = freshDb();
    setSetting("style_prompt_default", "style", db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    const chunks = makeChunks(3);
    const chunksPath = seedChunksFile(projectsDir, videoId, chunks);

    // Chat succeeds for chunk 0 then throws on chunk 1 — simulates a
    // mid-step crash. Chunk 0's prompt should be persisted on disk.
    let callCount = 0;
    const chat = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 2) throw new Error("LLM crashed");
      return `prompt_${callCount}`;
    });

    await expect(
      runEnrichChunks(videoId, { db, projectsDir, promptsDir, chat })
    ).rejects.toThrow("LLM crashed");

    const partial: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));
    expect(partial[0].prompt).toBe("prompt_1");
    expect(partial[1].prompt).toBeNull();
    expect(partial[2].prompt).toBeNull();
  });

  it("exports step with name 'enrich_chunks'", async () => {
    const { step } = await import("@/worker/steps/09-enrich-chunks");
    expect(step.name).toBe("enrich_chunks");
    expect(typeof step.run).toBe("function");
  });

  it("resets prompt_history to [] when re-enriching a chunk that had a moderation lineage", async () => {
    // Pipeline scenario: a prior pipeline run produced moderated rewrites
    // (chunk has prompt_history populated). Re-running enrich_chunks
    // regenerates prompt from scratch, so the historical lineage no
    // longer applies — must be cleared so the moderation loop starts
    // fresh on the next attempt.
    const db = freshDb();
    setSetting("style_prompt_default", "style", db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    const chunks: Chunk[] = [
      {
        id: "main_001",
        kind: "main",
        start: 0,
        end: 30,
        text: "scene one",
        prompt: "prior moderated prompt",
        prompt_history: ["original triggering prompt", "first rewrite"],
      },
    ];
    const chunksPath = seedChunksFile(projectsDir, videoId, chunks);

    const chat = vi.fn().mockResolvedValue("freshly enriched prompt");

    await runEnrichChunks(videoId, { db, projectsDir, promptsDir, chat });

    const result: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));
    expect(result[0].prompt).toBe("freshly enriched prompt");
    expect(result[0].prompt_history ?? []).toEqual([]);
  });
});

// ─── Phase 4 Invariant E — chat vs enrichChat routing ─────────────────
// Step 09 was rewired in Task 8 to call `ctx.enrichChat` instead of
// `ctx.chat`. Two regression guards live here:
//   1. The step's `run` adapter picks `ctx.enrichChat` (Task 8 routing).
//   2. The orchestrator binds `ctx.enrichChat` to whichever provider the
//      live `enrich_chunks_llm_provider` setting names — flipping the
//      setting between videos changes the binding at the next runPipeline
//      entry. Proves the global setting is read live, not snapshot-pinned
//      (Invariant E mutability column).

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

function buildCtx(
  db: DatabaseType,
  projectsDir: string,
  promptsDir: string,
  overrides: Partial<StepContext>
): StepContext {
  return {
    db,
    projectsDir,
    promptsDir,
    log: () => {},
    chat: vi.fn(),
    enrichChat: vi.fn(),
    // Neither tts nor image providers are touched by enrich_chunks; null-shape
    // stubs are sufficient for the routing test.
    ttsProvider: {} as never,
    imageProvider: {} as never,
    videoProvider: {} as never,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("enrich_chunks routing — chat vs enrichChat (Invariant E)", () => {
  it("step.run dispatches the LLM call through ctx.enrichChat, not ctx.chat", async () => {
    const db = freshDb();
    setSetting("style_prompt_default", "style", db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);
    seedChunksFile(projectsDir, videoId, makeChunks(1));

    const chat = vi.fn().mockResolvedValue("script-provider reply");
    const enrichChat = vi.fn().mockResolvedValue("enrich-provider reply");

    const { step } = await import("@/worker/steps/09-enrich-chunks");
    const ctx = buildCtx(db, projectsDir, promptsDir, { chat, enrichChat });

    await step.run(videoId, ctx);

    expect(enrichChat).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();
  });
});

describe("enrichChat resolution is live, not snapshot-pinned", () => {
  /**
   * Capture-step approach: drop a no-op step into runPipeline whose only
   * job is to grab the ctx the orchestrator built. We then call
   * `ctx.enrichChat` directly and observe which boundary (fetch for
   * openrouter, spawn for claude-cli) got hit. This isolates the
   * resolveDeps wiring from the rest of step 09.
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

  it("flipping enrich_chunks_llm_provider between two videos rewires enrichChat to the new provider", async () => {
    const db = freshDb();
    // Both providers need their settings populated for their chat() to work.
    setSetting("model_name", "openai/gpt-4o", db);
    setSetting("enrich_chunks_llm_provider", "openrouter", db);

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "or-reply" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from("cli-reply"));
        child.emit("close", 0);
      });
      return child;
    });

    const { runPipeline } = await import("@/worker/pipeline");

    // Video 1 — setting=openrouter, expect fetch to fire when we exercise
    // ctx.enrichChat.
    videosRepo.createNewVideo(db, {
      id: "v_or",
      title: "T",
      topic_info: "t",
      workflow_id: "comfyui",
      created_at: 1,
    });
    videosRepo.transitionNewToQueued(db, "v_or");
    const cap1 = captureStep();
    await runPipeline("v_or", {
      db,
      steps: [cap1.step],
      projectsDir: tempDir("projects"),
    });
    await cap1.getCtx().enrichChat([{ role: "user", content: "hi" }], {
      db,
      retryDelayMs: 0,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();

    // Operator flips the setting BETWEEN videos — the next runPipeline
    // entry must rebind enrichChat to claude_cli.
    setSetting("enrich_chunks_llm_provider", "claude_cli", db);

    videosRepo.createNewVideo(db, {
      id: "v_cli",
      title: "T",
      topic_info: "t",
      workflow_id: "comfyui",
      created_at: 2,
    });
    videosRepo.transitionNewToQueued(db, "v_cli");
    const cap2 = captureStep();
    await runPipeline("v_cli", {
      db,
      steps: [cap2.step],
      projectsDir: tempDir("projects"),
    });
    await cap2.getCtx().enrichChat([{ role: "user", content: "hi" }], { db });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    // fetch count unchanged from the first phase — no openrouter call
    // leaked through.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
