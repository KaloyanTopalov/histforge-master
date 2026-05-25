import type { Database as DatabaseType } from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Step } from "@/worker/pipeline";
import type { Chunk } from "@/types";
import { getDb } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { render } from "@/lib/prompts";
import type { ChatMessage } from "@/lib/llm/types";

export interface EnrichChunksDeps {
  db?: DatabaseType;
  projectsDir?: string;
  promptsDir?: string;
  chat?: (
    messages: ChatMessage[],
    opts?: { db?: DatabaseType }
  ) => Promise<string>;
}

/**
 * Step 9 — enrich_chunks. Spec section 11 (`:455-463`).
 *
 * For each chunk in `chunks.json`, calls the LLM with prev/current/next
 * text and the style prompt. Writes the returned visual prompt string
 * into the chunk's `prompt` field and persists `chunks.json` after each
 * successful call (partial-resumable on crash).
 */
export async function runEnrichChunks(
  videoId: string,
  deps: EnrichChunksDeps = {}
): Promise<void> {
  const db = deps.db ?? getDb();
  const projectsDir =
    deps.projectsDir ?? process.env.PROJECTS_DIR ?? "./projects";
  const promptsDir = deps.promptsDir ?? "prompts";
  const chat = deps.chat!;

  const projectDir = resolve(projectsDir, videoId);
  const chunksPath = join(projectDir, "chunks", "chunks.json");

  const chunks: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));

  const stylePrompt = getSetting("style_prompt_default", db);

  for (let i = 0; i < chunks.length; i++) {
    const prevText = i > 0 ? chunks[i - 1].text : "";
    const currentText = chunks[i].text;
    const nextText = i < chunks.length - 1 ? chunks[i + 1].text : "";

    const prompt = render(
      "09_enrich_chunk.md",
      {
        prev_text: prevText,
        current_text: currentText,
        next_text: nextText,
        style_prompt: stylePrompt,
      },
      promptsDir
    );

    const reply = await chat([{ role: "user", content: prompt }], { db });
    chunks[i].prompt = reply;
    // Re-enriching regenerates the prompt from scratch, so the
    // moderation lineage from any prior run no longer applies.
    chunks[i].prompt_history = [];

    // Persist after each chunk for partial-resumability.
    writeFileSync(chunksPath, JSON.stringify(chunks, null, 2), "utf-8");
  }
}

export const step: Step = {
  name: "enrich_chunks",
  module: "glue",
  label: "Enrich Chunks",
  description: "Generates a visual prompt for each chunk via the LLM.",
  for_each: "chunks",
  inputs: ["chunks/chunks.json"],
  // Re-running re-enriches all chunks in place; partial state is harmless
  // to leave.
  outputs: [],
  produces: ["chunks/chunks.json"],
  run(videoId, ctx) {
    return runEnrichChunks(videoId, {
      db: ctx.db,
      projectsDir: ctx.projectsDir,
      promptsDir: ctx.promptsDir,
      chat: ctx.enrichChat,
    });
  },
};
