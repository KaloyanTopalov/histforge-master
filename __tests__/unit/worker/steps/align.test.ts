import { describe, it, expect, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { runAlign } from "@/worker/steps/07-align";

const tmpDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `histforge-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore Windows lock races
    }
  }
});

function fakeSpawnOk() {
  const spawnFn = (_cmd: string, _args: string[], _opts?: unknown) => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      stdout: EventEmitter;
    };
    child.stderr = new EventEmitter();
    child.stdout = new EventEmitter();
    process.nextTick(() => child.emit("close", 0));
    return child;
  };
  return spawnFn as unknown as typeof import("node:child_process").spawn;
}

function fakeSpawnFail() {
  // A spawn that always fails — simulates aeneas / WSL being unavailable.
  // Step 7 falls through to this when no manual alignment.json exists.
  const spawnFn = (_cmd: string, _args: string[], _opts?: unknown) => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      stdout: EventEmitter;
    };
    child.stderr = new EventEmitter();
    child.stdout = new EventEmitter();
    process.nextTick(() => {
      child.stderr.emit("data", Buffer.from("simulated WSL/aeneas failure"));
      child.emit("close", 1);
    });
    return child;
  };
  return spawnFn as unknown as typeof import("node:child_process").spawn;
}

describe("align (step 7)", () => {
  it("constructs project paths and calls align(), producing sentences.txt", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_step7";
    const scriptDir = join(projectsDir, videoId, "script");
    const audioDir = join(projectsDir, videoId, "audio");
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(audioDir, { recursive: true });
    writeFileSync(join(scriptDir, "full_script.md"), "Hello world. Goodbye.");
    writeFileSync(join(audioDir, "narration.mp3"), "fake");

    await runAlign(videoId, { projectsDir, spawnFn: fakeSpawnOk() });

    // Verify sentences.txt was written in alignment/
    const sentencesPath = join(projectsDir, videoId, "alignment", "sentences.txt");
    const lines = readFileSync(sentencesPath, "utf-8").trim().split("\n");
    expect(lines).toEqual(["Hello world.", "Goodbye."]);
  });

  describe("manual-upload bypass", () => {
    it("skips aeneas entirely when a valid alignment.json is already on disk", async () => {
      // The alignment upload route writes the file at this path. Step 7
      // must detect it, log the bypass, and return without spawning
      // WSL/aeneas — critical for Windows hosts without WSL installed.
      const projectsDir = tempDir("projects");
      const videoId = "v_step7_manual";
      const scriptDir = join(projectsDir, videoId, "script");
      const audioDir = join(projectsDir, videoId, "audio");
      const alignDir = join(projectsDir, videoId, "alignment");
      mkdirSync(scriptDir, { recursive: true });
      mkdirSync(audioDir, { recursive: true });
      mkdirSync(alignDir, { recursive: true });
      writeFileSync(join(scriptDir, "full_script.md"), "ignored — bypass active");
      writeFileSync(join(audioDir, "narration.mp3"), "fake");
      writeFileSync(
        join(alignDir, "alignment.json"),
        JSON.stringify([
          { id: "f000001", text: "Pre-uploaded.", begin: 0, end: 2 },
        ]),
      );

      // Use a spawn that would FAIL if called — the test passes only if
      // the bypass kicks in and spawn is never reached.
      await expect(
        runAlign(videoId, { projectsDir, spawnFn: fakeSpawnFail() }),
      ).resolves.toBeUndefined();

      // sentences.txt must NOT have been written — that's only produced
      // along the aeneas codepath.
      expect(() =>
        readFileSync(join(alignDir, "sentences.txt"), "utf-8"),
      ).toThrow();

      // Log line should mention the bypass for operator observability.
      const log = readFileSync(
        join(projectsDir, videoId, "pipeline.log"),
        "utf-8",
      );
      expect(log).toContain("[align]");
      expect(log).toContain("Using pre-existing alignment.json");
      expect(log).toContain("skipping aeneas");
    });

    it("falls through to aeneas when alignment.json exists but is malformed", async () => {
      // Defensive: a stale or corrupt file should NOT silently pass
      // through to the chunker step. Treat malformed JSON as if no
      // upload happened and proceed to aeneas.
      const projectsDir = tempDir("projects");
      const videoId = "v_step7_malformed";
      const scriptDir = join(projectsDir, videoId, "script");
      const audioDir = join(projectsDir, videoId, "audio");
      const alignDir = join(projectsDir, videoId, "alignment");
      mkdirSync(scriptDir, { recursive: true });
      mkdirSync(audioDir, { recursive: true });
      mkdirSync(alignDir, { recursive: true });
      writeFileSync(join(scriptDir, "full_script.md"), "Real script for aeneas.");
      writeFileSync(join(audioDir, "narration.mp3"), "fake");
      writeFileSync(join(alignDir, "alignment.json"), "{ not valid json [");

      // Spawn succeeds — confirming we DID reach the aeneas path.
      await runAlign(videoId, { projectsDir, spawnFn: fakeSpawnOk() });
      // sentences.txt is produced by the aeneas codepath.
      expect(
        readFileSync(join(alignDir, "sentences.txt"), "utf-8").length,
      ).toBeGreaterThan(0);
    });

    it("falls through to aeneas when alignment.json has the wrong shape", async () => {
      // E.g. an array of plain timing pairs without text/id — the shape
      // validator must reject it so the chunker never sees garbage.
      const projectsDir = tempDir("projects");
      const videoId = "v_step7_wrongshape";
      const scriptDir = join(projectsDir, videoId, "script");
      const audioDir = join(projectsDir, videoId, "audio");
      const alignDir = join(projectsDir, videoId, "alignment");
      mkdirSync(scriptDir, { recursive: true });
      mkdirSync(audioDir, { recursive: true });
      mkdirSync(alignDir, { recursive: true });
      writeFileSync(join(scriptDir, "full_script.md"), "Real script for aeneas.");
      writeFileSync(join(audioDir, "narration.mp3"), "fake");
      writeFileSync(
        join(alignDir, "alignment.json"),
        JSON.stringify([{ begin: 0, end: 1 }]),
      );

      await runAlign(videoId, { projectsDir, spawnFn: fakeSpawnOk() });
      expect(
        readFileSync(join(alignDir, "sentences.txt"), "utf-8").length,
      ).toBeGreaterThan(0);
    });

    it("falls through to aeneas when alignment.json is zero-sized", async () => {
      const projectsDir = tempDir("projects");
      const videoId = "v_step7_empty";
      const scriptDir = join(projectsDir, videoId, "script");
      const audioDir = join(projectsDir, videoId, "audio");
      const alignDir = join(projectsDir, videoId, "alignment");
      mkdirSync(scriptDir, { recursive: true });
      mkdirSync(audioDir, { recursive: true });
      mkdirSync(alignDir, { recursive: true });
      writeFileSync(join(scriptDir, "full_script.md"), "Real script.");
      writeFileSync(join(audioDir, "narration.mp3"), "fake");
      writeFileSync(join(alignDir, "alignment.json"), "");

      await runAlign(videoId, { projectsDir, spawnFn: fakeSpawnOk() });
      expect(
        readFileSync(join(alignDir, "sentences.txt"), "utf-8").length,
      ).toBeGreaterThan(0);
    });
  });
});
