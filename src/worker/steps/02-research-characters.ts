import type { Database as DatabaseType } from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Step } from "@/worker/pipeline";
import { getDb } from "@/lib/db";
import { render } from "@/lib/prompts";
import type { ChatMessage } from "@/lib/llm/types";

export interface ResearchCharactersDeps {
  db?: DatabaseType;
  projectsDir?: string;
  promptsDir?: string;
  chat?: (
    messages: ChatMessage[],
    opts?: { db?: DatabaseType }
  ) => Promise<string>;
}

/**
 * Step 2 — research_characters. Spec `:323-325`.
 *
 * Reads the outline file step 1 wrote to disk (file-based handoff),
 * renders `prompts/02_research_characters.md` with it, calls the LLM,
 * writes the reply verbatim to `script/02_characters.md`.
 */
export async function runResearchCharacters(
  videoId: string,
  deps: ResearchCharactersDeps = {}
): Promise<void> {
  const db = deps.db ?? getDb();
  const projectsDir = deps.projectsDir ?? process.env.PROJECTS_DIR ?? "./projects";
  const promptsDir = deps.promptsDir ?? "prompts";
  const chat = deps.chat!;

  const scriptDir = join(projectsDir, videoId, "script");
  const outline = readFileSync(join(scriptDir, "01_outline.md"), "utf-8");

  const prompt = render(
    "02_research_characters.md",
    { outline },
    promptsDir
  );

  const reply = await chat([{ role: "user", content: prompt }], { db });

  writeFileSync(join(scriptDir, "02_characters.md"), reply);
}

export const step: Step = {
  name: "research_characters",
  module: "script",
  label: "Research Characters",
  description: "Extracts the cast and key relationships from the outline.",
  inputs: ["script/01_outline.md"],
  outputs: ["script/02_characters.md"],
  run(videoId, ctx) {
    return runResearchCharacters(videoId, {
      db: ctx.db,
      projectsDir: ctx.projectsDir,
      promptsDir: ctx.promptsDir,
      chat: ctx.chat,
    });
  },
};
