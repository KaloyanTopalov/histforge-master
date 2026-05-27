import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, seedDefaultSettings } from "@/lib/db";
import { setSetting } from "@/lib/settings";
import { step as generateVisualPromptsStep } from "@/worker/steps/09-generate-visual-prompts";
import type { Chunk } from "@/types";
import { makeStepContext } from "../helpers/step-fixtures";

/**
 * Character-lock + style-lock plan, Task 1.3 — prompt assembly contract.
 *
 * Step 09 takes the LLM's per-chunk prompt and appends two operator-
 * editable lock segments verbatim before persisting:
 *
 *   `<llm prompt>. <style_lock_description>. Negative: <character_lock_negative>.`
 *
 * Empty lock segments are skipped (no dangling ". Negative: ." with
 * nothing inside). The post-processing happens in `runOneBatch` after
 * `callBatchWithRetry` returns its Map and before `persistBatch` — that
 * keeps `parseEnvelopeReply` a pure validator.
 *
 * The two tests below pin the assembled-string contract and the
 * empty-skip contract. They run the real step.run() with a mock
 * `visualPromptChat` returning a known prompt so the test asserts
 * directly on the persisted `chunks.json`.
 */

const STYLE_LOCK_DEFAULT =
  "2D hand-drawn animation style, plain white background, pure black line work only, no color, no shading, no gradients, no 3D rendering, no photorealism, slight hand-drawn imperfection in linework. The character must be drawn in the exact same minimalist style as the reference ingredient.";

const NEGATIVE_LOCK_DEFAULT =
  "color, shading, gradient, 3D, photorealistic, vector-clean lines, multiple characters, child, cartoon mascot, anime, manga, smiling, happy expression";

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

function seedSingleChunk(
  projectsDir: string,
  videoId: string,
  chunkId: string,
  text: string
): string {
  const chunks: Chunk[] = [
    {
      id: chunkId,
      kind: "image",
      start: 0,
      end: 30,
      text,
      prompt: null,
    },
  ];
  const dir = join(projectsDir, videoId, "chunks");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "chunks.json");
  writeFileSync(path, JSON.stringify(chunks, null, 2), "utf-8");
  return path;
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

describe("step 09 prompt assembly — lock concatenation", () => {
  it("appends style + negative lock segments verbatim onto the LLM-returned prompt", async () => {
    // Acceptance criterion from the plan, verbatim: given the LLM
    // produces "the stickman walks across a desolate plain" for the
    // chunk, the persisted prompt is exactly
    //   "the stickman walks across a desolate plain. <STYLE>. Negative: <NEG>."
    const db = freshDb();
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);
    const chunksPath = seedSingleChunk(
      projectsDir,
      videoId,
      "image_001",
      "Stickman trudges across a barren land."
    );

    const llmPrompt = "the stickman walks across a desolate plain";
    const chat = vi.fn(async () => {
      return JSON.stringify({
        prompts: [{ id: "image_001", scene: llmPrompt }],
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

    const persisted: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));
    expect(persisted[0].prompt).toBe(
      `${llmPrompt}. ${STYLE_LOCK_DEFAULT}. Negative: ${NEGATIVE_LOCK_DEFAULT}.`
    );
  });

  it("appends nothing when both lock settings are empty strings (no dangling segments)", async () => {
    // Empty-string handling: an operator who wants no lock blanks both
    // textareas. The persisted prompt must equal the LLM-returned
    // string verbatim — no trailing ". " or ". Negative: ." artifacts.
    const db = freshDb();
    setSetting("style_lock_description", "", db);
    setSetting("character_lock_negative", "", db);

    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);
    const chunksPath = seedSingleChunk(
      projectsDir,
      videoId,
      "image_001",
      "Stickman trudges."
    );

    const llmPrompt = "the stickman walks across a desolate plain";
    const chat = vi.fn(async () => {
      return JSON.stringify({
        prompts: [{ id: "image_001", scene: llmPrompt }],
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

    const persisted: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));
    expect(persisted[0].prompt).toBe(llmPrompt);
  });

  it("appends only the style segment when negative is empty", async () => {
    const db = freshDb();
    setSetting("character_lock_negative", "", db);

    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);
    const chunksPath = seedSingleChunk(
      projectsDir,
      videoId,
      "image_001",
      "scene"
    );

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

    const persisted: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));
    expect(persisted[0].prompt).toBe(`a scene. ${STYLE_LOCK_DEFAULT}.`);
  });

  it("appends only the negative segment when style is empty", async () => {
    const db = freshDb();
    setSetting("style_lock_description", "", db);

    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);
    const chunksPath = seedSingleChunk(
      projectsDir,
      videoId,
      "image_001",
      "scene"
    );

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

    const persisted: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));
    expect(persisted[0].prompt).toBe(
      `a scene. Negative: ${NEGATIVE_LOCK_DEFAULT}.`
    );
  });
});
