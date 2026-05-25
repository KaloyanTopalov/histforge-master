import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { wslPath, align } from "@/lib/align";

const tmpDirs: string[] = [];
let originalWslDistro: string | undefined;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `histforge-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  originalWslDistro = process.env.WSL_DISTRO;
});

afterEach(() => {
  if (originalWslDistro === undefined) {
    delete process.env.WSL_DISTRO;
  } else {
    process.env.WSL_DISTRO = originalWslDistro;
  }
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore Windows lock races
    }
  }
});

describe("wslPath", () => {
  it("transforms C:\\Users\\x\\foo → /mnt/c/Users/x/foo", () => {
    expect(wslPath("C:\\Users\\x\\foo\\bar")).toBe("/mnt/c/Users/x/foo/bar");
  });

  it("handles lowercase drive letter and forward slashes", () => {
    expect(wslPath("c:/Users/x/foo")).toBe("/mnt/c/Users/x/foo");
  });
});

/**
 * Helper: create a fake ChildProcess-like EventEmitter with a stderr stream.
 * Emits `close` with the given code on the next tick.
 */
function fakeSpawn(exitCode: number, stderrData?: string) {
  const calls: Array<{ cmd: string; args: string[] }> = [];

  const spawnFn = (cmd: string, args: string[], _opts?: unknown) => {
    calls.push({ cmd, args: [...args] });
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      stdout: EventEmitter;
    };
    child.stderr = new EventEmitter();
    child.stdout = new EventEmitter();
    process.nextTick(() => {
      if (stderrData) {
        child.stderr.emit("data", Buffer.from(stderrData));
      }
      child.emit("close", exitCode);
    });
    return child;
  };

  return { spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn, calls };
}

describe("align", () => {
  it("reads script, writes sentences.txt one-per-line, and spawns WSL with correct args", async () => {
    const dir = tempDir("align");
    const audioPath = join(dir, "audio", "narration.mp3");
    const scriptPath = join(dir, "script", "full_script.md");
    const outPath = join(dir, "alignment", "alignment.json");
    mkdirSync(join(dir, "script"), { recursive: true });
    mkdirSync(join(dir, "audio"), { recursive: true });
    writeFileSync(scriptPath, "First sentence. Second sentence.");
    writeFileSync(audioPath, "fake-mp3");

    process.env.WSL_DISTRO = "TestDistro";

    const { spawnFn, calls } = fakeSpawn(0);

    // Inject a Windows-shaped repoRoot so the repo-relative args (python bin,
    // align.py) get mapped through wslPath on any host. Audio/script/out are
    // on real tmpfs, so we compute expected values through wslPath too.
    const repoRoot = "C:\\workspace";
    await align(audioPath, scriptPath, outPath, { spawnFn, repoRoot });

    // sentences.txt should exist next to outPath with one sentence per line
    const sentencesPath = join(dir, "alignment", "sentences.txt");
    const lines = readFileSync(sentencesPath, "utf-8").trim().split("\n");
    expect(lines).toEqual(["First sentence.", "Second sentence."]);

    // Spawn was called once with wsl and correct structure
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("wsl");
    expect(calls[0].args[0]).toBe("-d");
    expect(calls[0].args[1]).toBe("TestDistro");
    // repoRoot-derived args map through wslPath to /mnt/c/...
    expect(calls[0].args[2]).toBe("/mnt/c/workspace/python/.venv/bin/python3.11");
    expect(calls[0].args[3]).toBe("/mnt/c/workspace/python/align.py");
    // --audio, --text, --out flags; values are whatever wslPath yields for the
    // real (host-dependent) paths, which is what the function also produces.
    expect(calls[0].args[4]).toBe("--audio");
    expect(calls[0].args[5]).toBe(wslPath(audioPath));
    expect(calls[0].args[6]).toBe("--text");
    expect(calls[0].args[7]).toBe(wslPath(sentencesPath));
    expect(calls[0].args[8]).toBe("--out");
    expect(calls[0].args[9]).toBe(wslPath(outPath));
  });

  it("throws with stderr when the spawned process exits non-zero", async () => {
    const dir = tempDir("align-fail");
    const audioPath = join(dir, "audio", "narration.mp3");
    const scriptPath = join(dir, "script", "full_script.md");
    const outPath = join(dir, "alignment", "alignment.json");
    mkdirSync(join(dir, "script"), { recursive: true });
    mkdirSync(join(dir, "audio"), { recursive: true });
    writeFileSync(scriptPath, "One sentence.");
    writeFileSync(audioPath, "fake");

    const { spawnFn } = fakeSpawn(1, "aeneas crashed: bad audio format");

    await expect(
      align(audioPath, scriptPath, outPath, { spawnFn })
    ).rejects.toThrow(/exited with code 1.*aeneas crashed/);
  });
});
