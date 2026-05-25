import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setSetting } from "@/lib/settings";
import {
  step as assembleScriptStep,
  sanitizeScript,
} from "@/worker/steps/05-assemble-script";
import {
  tempDir,
  freshDb,
  makeStepContext,
  cleanup,
} from "../../../helpers/step-fixtures";

afterEach(cleanup);

describe("sanitizeScript", () => {
  it("replaces em-dashes with ', ' and reports the count", () => {
    const input = "lived—seventeen talents—enough.";
    const { text, emDashCount } = sanitizeScript(input);
    expect(text).toBe("lived, seventeen talents, enough.");
    expect(emDashCount).toBe(2);
  });

  it("leaves em-dash-free text untouched", () => {
    const input = "co-author pages 1–5 only.";
    const { text, emDashCount } = sanitizeScript(input);
    expect(text).toBe(input);
    expect(emDashCount).toBe(0);
  });

  it("does not touch hyphens or en-dashes — only em-dashes", () => {
    const input = "co-author pages 1–5 and em—dash.";
    const { text, emDashCount } = sanitizeScript(input);
    expect(text).toBe("co-author pages 1–5 and em, dash.");
    expect(emDashCount).toBe(1);
  });
});

describe("assemble_script step", () => {
  it("concatenates hook + chapters with double newlines into full_script.md", async () => {
    const db = freshDb();
    setSetting("script_length_minutes", 12, db);
    const projectsDir = tempDir("projects");
    const videoId = "v_assemble_basic";
    const scriptDir = join(projectsDir, videoId, "script");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, "03_hook.md"), "HOOK");
    writeFileSync(join(scriptDir, "04_chapter_01.md"), "CHAP1");
    writeFileSync(join(scriptDir, "04_chapter_02.md"), "CHAP2");

    await assembleScriptStep.run(
      videoId,
      makeStepContext({ db, projectsDir })
    );

    const full = readFileSync(join(scriptDir, "full_script.md"), "utf-8");
    expect(full).toBe("HOOK\n\nCHAP1\n\nCHAP2");
  });

  it("normalizes em-dashes to ', ' in the assembled output and logs the count", async () => {
    // The script on disk is the canonical artifact — every downstream
    // consumer (TTS, aeneas alignment) reads it. Normalizing at
    // assembly time prevents alignment drift that would arise if the
    // audio were generated from a sanitized copy while alignment read
    // an un-sanitized one.
    const db = freshDb();
    setSetting("script_length_minutes", 6, db);
    const projectsDir = tempDir("projects");
    const videoId = "v_assemble_emdash";
    const scriptDir = join(projectsDir, videoId, "script");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, "03_hook.md"), "Hook—intro.");
    writeFileSync(
      join(scriptDir, "04_chapter_01.md"),
      "Chapter one—with a dash."
    );

    await assembleScriptStep.run(
      videoId,
      makeStepContext({ db, projectsDir })
    );

    const full = readFileSync(join(scriptDir, "full_script.md"), "utf-8");
    expect(full).toBe("Hook, intro.\n\nChapter one, with a dash.");
    expect(full).not.toContain("—");

    const logContents = readFileSync(
      join(projectsDir, videoId, "pipeline.log"),
      "utf-8"
    );
    expect(logContents).toMatch(/\[assemble_script\]/);
    expect(logContents).toMatch(/Sanitized 2 em-dash/);
  });

  it("does not emit a sanitization log line when there are no em-dashes", async () => {
    const db = freshDb();
    setSetting("script_length_minutes", 6, db);
    const projectsDir = tempDir("projects");
    const videoId = "v_assemble_clean";
    const scriptDir = join(projectsDir, videoId, "script");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, "03_hook.md"), "Plain hook.");
    writeFileSync(join(scriptDir, "04_chapter_01.md"), "Plain chapter.");

    await assembleScriptStep.run(
      videoId,
      makeStepContext({ db, projectsDir })
    );

    let logContents = "";
    try {
      logContents = readFileSync(
        join(projectsDir, videoId, "pipeline.log"),
        "utf-8"
      );
    } catch {
      // log file may not exist — also fine.
    }
    expect(logContents).not.toMatch(/Sanitized/);
  });
});
