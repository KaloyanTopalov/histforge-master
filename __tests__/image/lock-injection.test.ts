import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, seedDefaultSettings } from "@/lib/db";
import { step as generateVisualPromptsStep } from "@/worker/steps/09-generate-visual-prompts";
import type { Chunk } from "@/types";
import type { ChatMessage } from "@/lib/llm/types";
import { makeStepContext } from "../helpers/step-fixtures";

/**
 * Character-lock + style-lock plan, Task 1.3 — system-message injection.
 *
 * Every visual-prompt LLM call in step 09 must carry a hard system
 * instruction telling the model not to describe character appearance or
 * art style — the lock blocks are appended by code and re-describing
 * them in the LLM output is wasted tokens and a drift risk.
 *
 * Two tests pin the contract:
 *   1. The main batch call has messages[0].role === "system" with the
 *      expected instruction content.
 *   2. The per-chunk (K=1) fallback path — triggered when a batch
 *      parse-fails twice — ALSO carries the system message on every
 *      single-chunk call. Forgetting to thread the system instruction
 *      into the fallback would silently let LLM drift back in on
 *      retried batches.
 */

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
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, 'comfyui', 'in_progress', ?)"
  ).run("v_lock", "Stickman saga", "test", Date.now());
  return "v_lock";
}

function seedPrompts(promptsDir: string): void {
  mkdirSync(join(promptsDir, "_shared"), { recursive: true });
  writeFileSync(
    join(promptsDir, "09_generate_visual_prompts.md"),
    "STYLE={{style_prompt}}\nBATCH={{batch_json}}\n---END---"
  );
}

function seedChunks(
  projectsDir: string,
  videoId: string,
  count: number
): void {
  const chunks: Chunk[] = [];
  for (let i = 0; i < count; i++) {
    chunks.push({
      id: `image_${String(i + 1).padStart(3, "0")}`,
      kind: "image",
      start: i * 30,
      end: (i + 1) * 30,
      text: `scene ${i + 1}`,
      prompt: null,
    });
  }
  const dir = join(projectsDir, videoId, "chunks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "chunks.json"), JSON.stringify(chunks, null, 2));
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  while (openDbs.length) {
    const db = openDbs.pop()!;
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
});

describe("step 09 — system instruction injection", () => {
  it("the main batch chat call carries a system message forbidding character/style description", async () => {
    const db = freshDb();
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);
    seedChunks(projectsDir, videoId, 1);

    const chat = vi.fn(async () => {
      return JSON.stringify({
        prompts: [{ id: "image_001", scene: "a scene" }],
      });
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
    const messages = chat.mock.calls[0][0] as ChatMessage[];
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toMatch(
      /^Do not describe the character's appearance/
    );
    // User message still present at index 1, carrying the BATCH= block.
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("BATCH=");
  });

  it("the per-chunk (K=1) fallback also carries the system message on every retry call", async () => {
    // Force the parse-fail-twice path: a batch of 2 chunks where the
    // chat returns {prompts:[]} for the first 2 calls (initial + retry
    // inside callBatchWithRetry), then succeeds for the K=1 fallback
    // calls. The fallback recurses through `callBatchWithRetry` with a
    // 1-item batch — every recursed call must still carry the system
    // message. Forgetting to thread it would silently strip the lock
    // safety net on retry.
    const db = freshDb();
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);
    seedChunks(projectsDir, videoId, 2);

    let call = 0;
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      call++;
      if (call <= 2) {
        // Force two consecutive parse failures so the K=1 fallback
        // fires for each of the 2 chunks.
        return JSON.stringify({ prompts: [] });
      }
      // Calls 3 and 4 are the per-chunk fallback. Read the user
      // message (now at index 1 because of the system message) for
      // the id and produce a single-entry envelope.
      const userContent = messages[1].content;
      const start = userContent.indexOf("BATCH=");
      const end = userContent.indexOf("\n---END---", start);
      const batch = JSON.parse(
        userContent.slice(start + "BATCH=".length, end)
      ) as Array<{ id: string }>;
      return JSON.stringify({
        prompts: batch.map((b) => ({ id: b.id, scene: `p-${b.id}` })),
      });
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

    // 2 batch-mode attempts + 2 per-chunk fallback calls = 4 total.
    expect(chat).toHaveBeenCalledTimes(4);
    // Every call's first message is the system instruction.
    for (const callArgs of chat.mock.calls) {
      const messages = callArgs[0] as ChatMessage[];
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toMatch(
        /^Do not describe the character's appearance/
      );
    }
  });
});
