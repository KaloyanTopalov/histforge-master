import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
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

/**
 * Build a fake `spawn` that succeeds and writes a minimal whisper-cli
 * JSON output to the path indicated by the `-of` argument (the lib
 * appends `.json` to that basename). The whisper output covers the
 * full audio duration so the aligner has timestamps to work with.
 */
function fakeSpawnOk(
  whisperJson: unknown = {
    transcription: [
      {
        offsets: { from: 0, to: 5000 },
        text: " Hello world. Goodbye.",
      },
    ],
  }
) {
  const spawnFn = (_cmd: string, args: readonly string[], _opts?: unknown) => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      stdout: EventEmitter;
    };
    child.stderr = new EventEmitter();
    child.stdout = new EventEmitter();
    // Write the fake whisper JSON to the path the aligner expects so
    // the subsequent readFileSync succeeds. The `-of <base>` flag is
    // followed by the base path; the aligner appends `.json` itself.
    const ofIdx = args.indexOf("-of");
    if (ofIdx >= 0 && ofIdx + 1 < args.length) {
      const base = args[ofIdx + 1];
      writeFileSync(`${base}.json`, JSON.stringify(whisperJson));
    }
    process.nextTick(() => child.emit("close", 0));
    return child;
  };
  return spawnFn as unknown as typeof import("node:child_process").spawn;
}

/** A spawn that always fails — simulates whisper-cli unavailable. */
function fakeSpawnFail() {
  const spawnFn = (_cmd: string, _args: readonly string[], _opts?: unknown) => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      stdout: EventEmitter;
    };
    child.stderr = new EventEmitter();
    child.stdout = new EventEmitter();
    process.nextTick(() => {
      child.stderr.emit("data", Buffer.from("simulated whisper-cli failure"));
      child.emit("close", 1);
    });
    return child;
  };
  return spawnFn as unknown as typeof import("node:child_process").spawn;
}

/**
 * The aligner pre-flights `existsSync(binPath)` and `existsSync(modelPath)`
 * before spawning. Tests set both overrides to the script file itself,
 * which is guaranteed to exist on disk (any path that resolves to a
 * regular file is enough — the actual file contents are never read,
 * the spawn mock takes over).
 */
function alignOverrides(scriptPath: string) {
  return { binPath: scriptPath, modelPath: scriptPath };
}

describe("align (step 7)", () => {
  it("writes alignment.json from the whisper transcript", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_step7";
    const scriptDir = join(projectsDir, videoId, "script");
    const audioDir = join(projectsDir, videoId, "audio");
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(audioDir, { recursive: true });
    const scriptPath = join(scriptDir, "full_script.md");
    writeFileSync(scriptPath, "Hello world. Goodbye.");
    writeFileSync(join(audioDir, "narration.mp3"), "fake");

    await runAlign(videoId, {
      projectsDir,
      spawnFn: fakeSpawnOk(),
      ...alignOverrides(scriptPath),
    });

    const alignPath = join(projectsDir, videoId, "alignment", "alignment.json");
    const entries = JSON.parse(readFileSync(alignPath, "utf-8")) as Array<{
      id: string;
      text: string;
      begin: number;
      end: number;
    }>;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: "f000001", text: "Hello world." });
    expect(entries[1]).toMatchObject({ id: "f000002", text: "Goodbye." });
    expect(entries[0].begin).toBeGreaterThanOrEqual(0);
    expect(entries[1].end).toBeGreaterThan(entries[0].begin);
  });

  it("cleans up the intermediate whisper_out.json after parsing", async () => {
    // The aligner deletes the whisper-cli JSON output after reading
    // it. Keeps the alignment/ dir clean — only alignment.json should
    // remain for downstream steps to consume.
    const projectsDir = tempDir("projects");
    const videoId = "v_step7_cleanup";
    const scriptDir = join(projectsDir, videoId, "script");
    const audioDir = join(projectsDir, videoId, "audio");
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(audioDir, { recursive: true });
    const scriptPath = join(scriptDir, "full_script.md");
    writeFileSync(scriptPath, "Hello world.");
    writeFileSync(join(audioDir, "narration.mp3"), "fake");

    await runAlign(videoId, {
      projectsDir,
      spawnFn: fakeSpawnOk(),
      ...alignOverrides(scriptPath),
    });

    const alignDir = join(projectsDir, videoId, "alignment");
    expect(existsSync(join(alignDir, "alignment.json"))).toBe(true);
    expect(existsSync(join(alignDir, "whisper_out.json"))).toBe(false);
  });

  describe("manual-upload bypass", () => {
    it("skips whisper-cli when a valid alignment.json is already on disk", async () => {
      const projectsDir = tempDir("projects");
      const videoId = "v_step7_manual";
      const scriptDir = join(projectsDir, videoId, "script");
      const audioDir = join(projectsDir, videoId, "audio");
      const alignDir = join(projectsDir, videoId, "alignment");
      mkdirSync(scriptDir, { recursive: true });
      mkdirSync(audioDir, { recursive: true });
      mkdirSync(alignDir, { recursive: true });
      const scriptPath = join(scriptDir, "full_script.md");
      writeFileSync(scriptPath, "ignored — bypass active");
      writeFileSync(join(audioDir, "narration.mp3"), "fake");
      writeFileSync(
        join(alignDir, "alignment.json"),
        JSON.stringify([
          { id: "f000001", text: "Pre-uploaded.", begin: 0, end: 2 },
        ])
      );

      // Use a spawn that would fail if called — the test passes only if
      // the bypass kicks in and spawn is never reached.
      await expect(
        runAlign(videoId, {
          projectsDir,
          spawnFn: fakeSpawnFail(),
          ...alignOverrides(scriptPath),
        })
      ).resolves.toBeUndefined();

      const log = readFileSync(
        join(projectsDir, videoId, "pipeline.log"),
        "utf-8"
      );
      expect(log).toContain("[align]");
      expect(log).toContain("Using pre-existing alignment.json");
      expect(log).toContain("skipping whisper-cli");
    });

    it("falls through to whisper-cli when alignment.json exists but is malformed", async () => {
      const projectsDir = tempDir("projects");
      const videoId = "v_step7_malformed";
      const scriptDir = join(projectsDir, videoId, "script");
      const audioDir = join(projectsDir, videoId, "audio");
      const alignDir = join(projectsDir, videoId, "alignment");
      mkdirSync(scriptDir, { recursive: true });
      mkdirSync(audioDir, { recursive: true });
      mkdirSync(alignDir, { recursive: true });
      const scriptPath = join(scriptDir, "full_script.md");
      writeFileSync(scriptPath, "Real script for whisper.");
      writeFileSync(join(audioDir, "narration.mp3"), "fake");
      writeFileSync(join(alignDir, "alignment.json"), "{ not valid json [");

      // Spawn succeeds — confirming we DID reach the whisper path. The
      // existing-file contents got overwritten by the new alignment.
      await runAlign(videoId, {
        projectsDir,
        spawnFn: fakeSpawnOk({
          transcription: [
            {
              offsets: { from: 0, to: 3000 },
              text: " Real script for whisper.",
            },
          ],
        }),
        ...alignOverrides(scriptPath),
      });

      const written = JSON.parse(
        readFileSync(join(alignDir, "alignment.json"), "utf-8")
      );
      expect(Array.isArray(written)).toBe(true);
      expect(written[0].id).toBe("f000001");
    });

    it("falls through to whisper-cli when alignment.json has the wrong shape", async () => {
      const projectsDir = tempDir("projects");
      const videoId = "v_step7_wrongshape";
      const scriptDir = join(projectsDir, videoId, "script");
      const audioDir = join(projectsDir, videoId, "audio");
      const alignDir = join(projectsDir, videoId, "alignment");
      mkdirSync(scriptDir, { recursive: true });
      mkdirSync(audioDir, { recursive: true });
      mkdirSync(alignDir, { recursive: true });
      const scriptPath = join(scriptDir, "full_script.md");
      writeFileSync(scriptPath, "Real script.");
      writeFileSync(join(audioDir, "narration.mp3"), "fake");
      writeFileSync(
        join(alignDir, "alignment.json"),
        JSON.stringify([{ begin: 0, end: 1 }])
      );

      await runAlign(videoId, {
        projectsDir,
        spawnFn: fakeSpawnOk({
          transcription: [
            {
              offsets: { from: 0, to: 1500 },
              text: " Real script.",
            },
          ],
        }),
        ...alignOverrides(scriptPath),
      });
      const written = JSON.parse(
        readFileSync(join(alignDir, "alignment.json"), "utf-8")
      );
      expect(written[0]).toMatchObject({ id: "f000001", text: "Real script." });
    });

    it("falls through to whisper-cli when alignment.json is zero-sized", async () => {
      const projectsDir = tempDir("projects");
      const videoId = "v_step7_empty";
      const scriptDir = join(projectsDir, videoId, "script");
      const audioDir = join(projectsDir, videoId, "audio");
      const alignDir = join(projectsDir, videoId, "alignment");
      mkdirSync(scriptDir, { recursive: true });
      mkdirSync(audioDir, { recursive: true });
      mkdirSync(alignDir, { recursive: true });
      const scriptPath = join(scriptDir, "full_script.md");
      writeFileSync(scriptPath, "Hello world.");
      writeFileSync(join(audioDir, "narration.mp3"), "fake");
      writeFileSync(join(alignDir, "alignment.json"), "");

      await runAlign(videoId, {
        projectsDir,
        spawnFn: fakeSpawnOk(),
        ...alignOverrides(scriptPath),
      });
      const written = JSON.parse(
        readFileSync(join(alignDir, "alignment.json"), "utf-8")
      );
      expect(written.length).toBeGreaterThan(0);
    });
  });
});
