import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { wavBytesToMp3, type SpawnFn } from "@/lib/tts/chatterbox-transcode";

/**
 * Tests inject a fake `spawn` via the helper's `spawn` opt — same pattern
 * as `worker/steps/14-render.ts` (`exec` injection). Mocking `node:child_process`
 * directly would fight Vitest's node-builtin externalization; injecting at
 * the API boundary is both simpler and matches the project's existing DI
 * convention.
 */

const tmpDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `histforge-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

interface FakeChild extends EventEmitter {
  stdin: {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  stderr: EventEmitter;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  child.stderr = new EventEmitter();
  return child;
}

function makeSpawnMock(child: FakeChild): {
  spawn: SpawnFn;
  calls: Array<{ command: string; args: readonly string[]; options: unknown }>;
} {
  const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    return child as unknown as ReturnType<SpawnFn>;
  };
  return { spawn, calls };
}

beforeEach(() => {
  // no-op (each test owns its own fake)
});

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

describe("wavBytesToMp3", () => {
  it("spawns ffmpeg with stdin pipe and libmp3lame, writes to outMp3Path, resolves on exit 0", async () => {
    const dir = tempDir("transcode");
    const outPath = join(dir, "audio", "narration.mp3");
    const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0xde, 0xad]);

    const child = makeFakeChild();
    const { spawn, calls } = makeSpawnMock(child);

    const promise = wavBytesToMp3(wav, outPath, { spawn });
    queueMicrotask(() => child.emit("exit", 0, null));
    await promise;

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("ffmpeg");
    expect(calls[0].args).toEqual([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-codec:a",
      "libmp3lame",
      "-q:a",
      "2",
      outPath,
    ]);
    expect(calls[0].options).toMatchObject({
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });

    expect(child.stdin.write).toHaveBeenCalledWith(wav);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
  });

  it("creates the parent directory before spawning ffmpeg", async () => {
    const dir = tempDir("transcode");
    const outPath = join(dir, "audio", "narration.mp3");
    const wav = Buffer.from([0]);
    expect(existsSync(dirname(outPath))).toBe(false);

    const child = makeFakeChild();
    const { spawn } = makeSpawnMock(child);

    const promise = wavBytesToMp3(wav, outPath, { spawn });
    expect(existsSync(dirname(outPath))).toBe(true);
    queueMicrotask(() => child.emit("exit", 0, null));
    await promise;
  });

  it("rejects with the stderr tail when ffmpeg exits non-zero", async () => {
    const dir = tempDir("transcode");
    const outPath = join(dir, "narration.mp3");
    const child = makeFakeChild();
    const { spawn } = makeSpawnMock(child);

    const promise = wavBytesToMp3(Buffer.from([1]), outPath, { spawn });
    queueMicrotask(() => {
      child.stderr.emit("data", Buffer.from("line1\nline2\nline3\nline4\n"));
      child.emit("exit", 1, null);
    });

    await expect(promise).rejects.toThrow(
      /ffmpeg WAV→MP3 exited with code=1.*line2 \| line3 \| line4/
    );
  });

  it("throws AbortError immediately when signal is already aborted (no spawn)", async () => {
    const dir = tempDir("transcode");
    const outPath = join(dir, "narration.mp3");
    const controller = new AbortController();
    controller.abort("test-cancel");

    const child = makeFakeChild();
    const { spawn, calls } = makeSpawnMock(child);

    await expect(
      wavBytesToMp3(Buffer.from([1]), outPath, {
        signal: controller.signal,
        spawn,
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(calls).toHaveLength(0);
  });

  it("speed=1.0 is a no-op — no -filter:a in the ffmpeg args", async () => {
    const dir = tempDir("transcode");
    const outPath = join(dir, "narration.mp3");
    const child = makeFakeChild();
    const { spawn, calls } = makeSpawnMock(child);

    const promise = wavBytesToMp3(Buffer.from([1]), outPath, {
      spawn,
      speed: 1.0,
    });
    queueMicrotask(() => child.emit("exit", 0, null));
    await promise;

    expect(calls[0].args).not.toContain("-filter:a");
    for (const arg of calls[0].args) {
      expect(arg).not.toMatch(/atempo/);
    }
  });

  it("omitted speed is a no-op — same args as before the speed feature", async () => {
    // Defends against an accidental default that injects atempo=1.0 (a
    // pointless ffmpeg pass) on the existing chatterbox path. Only a
    // caller that explicitly opts in should pay the filter cost.
    const dir = tempDir("transcode");
    const outPath = join(dir, "narration.mp3");
    const child = makeFakeChild();
    const { spawn, calls } = makeSpawnMock(child);

    const promise = wavBytesToMp3(Buffer.from([1]), outPath, { spawn });
    queueMicrotask(() => child.emit("exit", 0, null));
    await promise;

    expect(calls[0].args).not.toContain("-filter:a");
  });

  it.each([
    [0.5, "atempo=0.5"],
    [1.5, "atempo=1.5"],
    [2.0, "atempo=2"],
  ])("speed=%s adds a single atempo filter (%s)", async (speed, expected) => {
    const dir = tempDir("transcode");
    const outPath = join(dir, "narration.mp3");
    const child = makeFakeChild();
    const { spawn, calls } = makeSpawnMock(child);

    const promise = wavBytesToMp3(Buffer.from([1]), outPath, {
      spawn,
      speed,
    });
    queueMicrotask(() => child.emit("exit", 0, null));
    await promise;

    const args = calls[0].args;
    const idx = args.indexOf("-filter:a");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(expected);
  });

  it("speed=4.0 chains two atempo filters (atempo requires 0.5..2.0)", async () => {
    const dir = tempDir("transcode");
    const outPath = join(dir, "narration.mp3");
    const child = makeFakeChild();
    const { spawn, calls } = makeSpawnMock(child);

    const promise = wavBytesToMp3(Buffer.from([1]), outPath, {
      spawn,
      speed: 4.0,
    });
    queueMicrotask(() => child.emit("exit", 0, null));
    await promise;

    const args = calls[0].args;
    const idx = args.indexOf("-filter:a");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("atempo=2,atempo=2");
  });

  it("speed=0.25 chains two atempo filters on the slow side", async () => {
    const dir = tempDir("transcode");
    const outPath = join(dir, "narration.mp3");
    const child = makeFakeChild();
    const { spawn, calls } = makeSpawnMock(child);

    const promise = wavBytesToMp3(Buffer.from([1]), outPath, {
      spawn,
      speed: 0.25,
    });
    queueMicrotask(() => child.emit("exit", 0, null));
    await promise;

    const args = calls[0].args;
    const idx = args.indexOf("-filter:a");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("atempo=0.5,atempo=0.5");
  });

  it("forwards the signal to spawn so Node's signal-aware kill handles abort", async () => {
    const dir = tempDir("transcode");
    const outPath = join(dir, "narration.mp3");
    const controller = new AbortController();
    const child = makeFakeChild();
    const { spawn, calls } = makeSpawnMock(child);

    const promise = wavBytesToMp3(Buffer.from([1]), outPath, {
      signal: controller.signal,
      spawn,
    });

    expect(calls).toHaveLength(1);
    expect((calls[0].options as { signal?: unknown }).signal).toBe(
      controller.signal
    );

    // Simulate Node's signal-aware spawn surfacing the abort.
    queueMicrotask(() => {
      const err = new Error("The operation was aborted");
      (err as Error & { name: string }).name = "AbortError";
      child.emit("error", err);
    });

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});
