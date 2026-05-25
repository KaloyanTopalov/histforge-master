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
});
