import { describe, it, expect, afterEach, vi } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setSetting } from "@/lib/settings";
import { step as writeHookStep } from "@/worker/steps/03-write-hook";
import { step as assembleScriptStep } from "@/worker/steps/05-assemble-script";
import {
  tempDir,
  freshDb,
  makeStepContext,
  cleanup,
} from "../../../helpers/step-fixtures";

function seedVideo(
  db: DatabaseType,
  overrides: { title?: string } = {}
): string {
  const now = Date.now();
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, 'in_progress', ?)"
  ).run(
    "v_01",
    overrides.title ?? "Stalingrad",
    "WW2 eastern front",
    "comfyui",
    now
  );
  return "v_01";
}

function seedPrompts(promptsDir: string): void {
  mkdirSync(join(promptsDir, "_shared"), { recursive: true });
  writeFileSync(join(promptsDir, "_shared", "banned_words.md"), "");
  writeFileSync(join(promptsDir, "_shared", "numbers_as_letters.md"), "");
  writeFileSync(join(promptsDir, "_shared", "audience_profile.md"), "");
  writeFileSync(join(promptsDir, "_shared", "format_guidelines.md"), "");
  writeFileSync(
    join(promptsDir, "03_write_hook.md"),
    "T={{title}}|O={{outline}}|B={{banned_words}}|N={{numbers_as_letters}}"
  );
}

afterEach(cleanup);

describe("write_hook (step 3)", () => {
  it("reads title from DB + outline from disk, calls LLM, writes script/03_hook.md", async () => {
    const db = freshDb();
    const videoId = seedVideo(db, { title: "Stalingrad" });
    const projectsDir = tempDir("projects");
    const promptsDir = tempDir("prompts");
    seedPrompts(promptsDir);

    // Spec :329 — hook prompt variables are title, outline.
    // Outline is read from disk (file produced by step 1), title is
    // read from the DB topic row.
    const scriptDir = join(projectsDir, videoId, "script");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, "01_outline.md"), "OUTLINE-BODY");

    const chat = vi
      .fn()
      .mockResolvedValue("A cold open about the winter of...");

    await writeHookStep.run(
      videoId,
      makeStepContext({ db, projectsDir, promptsDir, chat })
    );

    expect(chat).toHaveBeenCalledOnce();
    const [messages] = chat.mock.calls[0];
    expect(messages).toEqual([
      {
        role: "user",
        content:
          "T=Stalingrad|O=OUTLINE-BODY|B=|N=",
      },
    ]);

    expect(
      readFileSync(join(scriptDir, "03_hook.md"), "utf-8")
    ).toBe("A cold open about the winter of...");
  });
});

describe("assemble_script (step 5)", () => {
  it("concatenates hook + every chapter file with double newlines into full_script.md", async () => {
    const db = freshDb();
    setSetting("script_length_minutes", 18, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");

    const scriptDir = join(projectsDir, videoId, "script");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, "03_hook.md"), "HOOK");
    writeFileSync(join(scriptDir, "04_chapter_01.md"), "CHAPTER ONE");
    writeFileSync(join(scriptDir, "04_chapter_02.md"), "CHAPTER TWO");
    writeFileSync(join(scriptDir, "04_chapter_03.md"), "CHAPTER THREE");

    await assembleScriptStep.run(
      videoId,
      makeStepContext({ db, projectsDir })
    );

    // Spec :349-350 — hook + chapters 1..N joined with double newlines.
    expect(
      readFileSync(join(scriptDir, "full_script.md"), "utf-8")
    ).toBe("HOOK\n\nCHAPTER ONE\n\nCHAPTER TWO\n\nCHAPTER THREE");
  });

  it("reads exactly the derived chapter count — extra files on disk are ignored", async () => {
    // If a previous run produced 15 chapters and this run is configured
    // for 3, the 4..15 chapter files from the prior run must NOT leak
    // into the new script. Pin the contract: the chapter count derived
    // from script_length_minutes is authoritative.
    const db = freshDb();
    setSetting("script_length_minutes", 18, db);
    const videoId = seedVideo(db);
    const projectsDir = tempDir("projects");

    const scriptDir = join(projectsDir, videoId, "script");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, "03_hook.md"), "HOOK");
    writeFileSync(join(scriptDir, "04_chapter_01.md"), "ONE");
    writeFileSync(join(scriptDir, "04_chapter_02.md"), "TWO");
    writeFileSync(join(scriptDir, "04_chapter_03.md"), "THREE");
    writeFileSync(join(scriptDir, "04_chapter_04.md"), "STALE FOUR");
    writeFileSync(join(scriptDir, "04_chapter_05.md"), "STALE FIVE");

    await assembleScriptStep.run(
      videoId,
      makeStepContext({ db, projectsDir })
    );

    const fullScript = readFileSync(
      join(scriptDir, "full_script.md"),
      "utf-8"
    );
    expect(fullScript).toBe("HOOK\n\nONE\n\nTWO\n\nTHREE");
    expect(fullScript).not.toContain("STALE");
  });
});
