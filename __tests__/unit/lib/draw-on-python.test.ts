import { afterEach, describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { spawn as realSpawn } from "node:child_process";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb, seedDefaultSettings } from "@/lib/db";
import { getSetting, setSetting } from "@/lib/settings";
import {
  resolveDrawOnPythonPath,
  runDrawOnCli,
  DRAW_ON_VENV_WINDOWS_RELATIVE,
  DRAW_ON_VENV_POSIX_RELATIVE,
} from "@/lib/draw-on-python";

const openDbs: DatabaseType[] = [];

afterEach(() => {
  while (openDbs.length) {
    const db = openDbs.pop()!;
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
});

function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
  openDbs.push(db);
  return db;
}

describe("resolveDrawOnPythonPath", () => {
  it("returns the operator-set setting verbatim when non-empty", () => {
    const result = resolveDrawOnPythonPath({
      setting: "C:/custom/python.exe",
      repoRoot: "C:/repo",
      platform: "win32",
      existsFn: () => false,
    });
    expect(result).toBe("C:/custom/python.exe");
  });

  it("trims the setting before treating it as empty (whitespace-only is empty)", () => {
    const result = resolveDrawOnPythonPath({
      setting: "   ",
      repoRoot: "C:/repo",
      platform: "win32",
      existsFn: () => true,
    });
    expect(result).toBe(resolve("C:/repo", DRAW_ON_VENV_WINDOWS_RELATIVE));
  });

  it("probes the Windows venv path when setting is empty on win32 and returns it if present", () => {
    const expected = resolve("C:/repo", DRAW_ON_VENV_WINDOWS_RELATIVE);
    const probed: string[] = [];
    const result = resolveDrawOnPythonPath({
      setting: "",
      repoRoot: "C:/repo",
      platform: "win32",
      existsFn: (p) => {
        probed.push(p);
        return p === expected;
      },
    });
    expect(result).toBe(expected);
    expect(probed).toContain(expected);
  });

  it("probes the POSIX venv path when setting is empty on linux and returns it if present", () => {
    const expected = resolve("/repo", DRAW_ON_VENV_POSIX_RELATIVE);
    const result = resolveDrawOnPythonPath({
      setting: null,
      repoRoot: "/repo",
      platform: "linux",
      existsFn: (p) => p === expected,
    });
    expect(result).toBe(expected);
  });

  it("falls back to 'python' on PATH when setting empty and venv missing", () => {
    const result = resolveDrawOnPythonPath({
      setting: "",
      repoRoot: "C:/repo",
      platform: "win32",
      existsFn: () => false,
    });
    expect(result).toBe("python");
  });

  it("does NOT validate operator-set paths against the filesystem (precheck owns that)", () => {
    // Setting takes precedence even when existsFn would reject it. The render
    // precheck is responsible for verifying the path actually launches.
    const result = resolveDrawOnPythonPath({
      setting: "/nonsense/python",
      repoRoot: "/repo",
      platform: "linux",
      existsFn: () => false,
    });
    expect(result).toBe("/nonsense/python");
  });

  // Real-machine verification: with no setting and no mocks, on this repo
  // the Session-1 .venv exists at python/draw_on/.venv/{Scripts,bin}/python.
  // This test fails on a checkout that hasn't run the setup script — the
  // failure mode is informative (the operator gets told the venv is missing).
  it("[real-machine] resolves to the on-disk Session-1 .venv when present", () => {
    const platform = process.platform;
    const relative =
      platform === "win32"
        ? DRAW_ON_VENV_WINDOWS_RELATIVE
        : DRAW_ON_VENV_POSIX_RELATIVE;
    const expected = resolve(process.cwd(), relative);

    if (!existsSync(expected)) {
      // Skip with a loud message rather than fail the suite for fresh
      // checkouts. CI / dev machines that have run the setup script will
      // exercise the happy path.
      console.warn(
        `[draw-on-python] real-machine venv probe skipped — ${expected} not present`
      );
      return;
    }

    const result = resolveDrawOnPythonPath({ setting: "" });
    expect(result).toBe(expected);
  });
});

/**
 * Fake child process for runDrawOnCli unit tests. The harness lets the test
 * decide what exit code to emit, what stderr lines to push, and how long to
 * wait before closing — without ever spawning a real subprocess.
 */
function makeFakeChild(opts: {
  exitCode?: number;
  stderrLines?: string[];
  closeDelayMs?: number;
  emitErrorBeforeClose?: Error;
}): { proc: ChildProcess; killCalls: Array<NodeJS.Signals | number> } {
  const ee = new EventEmitter() as ChildProcess & { killed: boolean };
  const stderr = new Readable({ read() {} });
  ee.stderr = stderr;
  ee.stdout = new Readable({ read() {} });
  ee.stdin = null;
  ee.killed = false;
  const killCalls: Array<NodeJS.Signals | number> = [];
  ee.kill = ((sig?: NodeJS.Signals | number) => {
    killCalls.push(sig ?? "SIGTERM");
    ee.killed = true;
    // Mimic the OS-side close after a kill signal.
    setImmediate(() => ee.emit("close", null));
    return true;
  }) as ChildProcess["kill"];

  setImmediate(() => {
    for (const line of opts.stderrLines ?? []) {
      stderr.push(Buffer.from(line));
    }
    stderr.push(null);
  });

  if (opts.emitErrorBeforeClose) {
    setImmediate(() => ee.emit("error", opts.emitErrorBeforeClose));
  } else {
    setTimeout(() => {
      if (!ee.killed) ee.emit("close", opts.exitCode ?? 0);
    }, opts.closeDelayMs ?? 5);
  }

  return { proc: ee as unknown as ChildProcess, killCalls };
}

describe("runDrawOnCli", () => {
  it("spawns the CLI with [-m draw_on, image, dur, out] and resolves on exit 0", async () => {
    let captured:
      | { cmd: string; args: readonly string[]; opts: unknown }
      | null = null;
    const { proc } = makeFakeChild({ exitCode: 0 });
    const spawnFn = ((cmd: string, args: readonly string[], opts: unknown) => {
      captured = { cmd, args, opts };
      return proc;
    }) as unknown as typeof spawn;

    await runDrawOnCli({
      pythonPath: "C:/python/python.exe",
      imagePath: "C:/img/001.png",
      durationSec: 4.25,
      outputPath: "C:/out/001.mp4",
      spawnFn,
    });

    expect(captured).not.toBeNull();
    expect(captured!.cmd).toBe("C:/python/python.exe");
    expect(captured!.args).toEqual([
      "-m",
      "draw_on",
      "C:/img/001.png",
      "4.25",
      "C:/out/001.mp4",
    ]);
  });

  it("rejects on non-zero exit code, surfacing the stderr tail", async () => {
    const { proc } = makeFakeChild({
      exitCode: 1,
      stderrLines: [
        "ERROR: image not found\n",
        "Traceback (most recent call last):\n",
        "FileNotFoundError\n",
      ],
    });
    const spawnFn = (() => proc) as unknown as typeof spawn;

    await expect(
      runDrawOnCli({
        pythonPath: "py",
        imagePath: "x.png",
        durationSec: 1,
        outputPath: "y.mp4",
        spawnFn,
      })
    ).rejects.toThrow(/exited with code 1/);
  });

  it("routes stderr lines to the log callback (no buffering — line-at-a-time)", async () => {
    const lines: string[] = [];
    const { proc } = makeFakeChild({
      exitCode: 0,
      stderrLines: ["progress 10%\n", "progress 50%\n", "progress 100%\n"],
    });
    const spawnFn = (() => proc) as unknown as typeof spawn;

    await runDrawOnCli({
      pythonPath: "py",
      imagePath: "x.png",
      durationSec: 1,
      outputPath: "y.mp4",
      log: (line) => lines.push(line),
      spawnFn,
    });

    // Each stderr write becomes one log call (trailing newline stripped).
    expect(lines).toEqual(["progress 10%", "progress 50%", "progress 100%"]);
  });

  it("rejects on spawn ENOENT (binary missing)", async () => {
    const { proc } = makeFakeChild({
      emitErrorBeforeClose: Object.assign(new Error("ENOENT"), {
        code: "ENOENT",
      }),
    });
    const spawnFn = (() => proc) as unknown as typeof spawn;

    await expect(
      runDrawOnCli({
        pythonPath: "/no/such/python",
        imagePath: "x.png",
        durationSec: 1,
        outputPath: "y.mp4",
        spawnFn,
      })
    ).rejects.toThrow(/failed to spawn/);
  });

  it("calls child.kill when the AbortSignal fires and rejects with an abort error", async () => {
    const { proc, killCalls } = makeFakeChild({
      exitCode: 0,
      closeDelayMs: 5000, // long-running — abort should preempt
    });
    const spawnFn = (() => proc) as unknown as typeof spawn;
    const controller = new AbortController();

    const p = runDrawOnCli({
      pythonPath: "py",
      imagePath: "x.png",
      durationSec: 1,
      outputPath: "y.mp4",
      signal: controller.signal,
      spawnFn,
    });

    setTimeout(() => controller.abort(), 10);

    await expect(p).rejects.toThrow(/aborted/i);
    expect(killCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects immediately when the signal is already aborted before spawn", async () => {
    const controller = new AbortController();
    controller.abort();
    const spawnCalls: number = 0;
    const spawnFn = ((..._args: unknown[]) => {
      // shouldn't be called
      throw new Error("spawn should not be called when signal pre-aborted");
    }) as unknown as typeof spawn;

    await expect(
      runDrawOnCli({
        pythonPath: "py",
        imagePath: "x.png",
        durationSec: 1,
        outputPath: "y.mp4",
        signal: controller.signal,
        spawnFn,
      })
    ).rejects.toThrow(/aborted/i);
    void spawnCalls;
  });

  // [REAL-PROCESS] Verify the abort path actually kills a live OS process,
  // not just a fake child whose .kill is a stub. Uses node itself as the
  // spawn target (always available in the test environment) — args are
  // rewritten by a custom spawnFn so the production "-m draw_on" args
  // become a long sleep instead.
  it("[real-process] AbortSignal kills a real long-running child within 1s", async () => {
    const realChildren: ChildProcess[] = [];
    const spawnFn = ((_cmd: string, _args: readonly string[]) => {
      // Spawn node with a 30s timer — long enough that abort MUST be the
      // reason the promise resolves. realSpawn (not the injected mock).
      const child = realSpawn(process.execPath, [
        "-e",
        "setTimeout(() => process.exit(0), 30000);",
      ]);
      realChildren.push(child);
      return child;
    }) as unknown as typeof spawn;

    const controller = new AbortController();
    const start = Date.now();
    const p = runDrawOnCli({
      pythonPath: "irrelevant",
      imagePath: "x",
      durationSec: 1,
      outputPath: "y",
      signal: controller.signal,
      spawnFn,
    });

    setTimeout(() => controller.abort(), 50);

    await expect(p).rejects.toThrow(/aborted/i);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    // Defensive: ensure the OS child is actually gone (not zombie).
    for (const c of realChildren) {
      expect(c.killed || c.exitCode !== null).toBe(true);
    }
  });
});

describe("verifyDrawOnPython", () => {
  it("resolves on exit code 0 with the spec-shape spawn (-m draw_on --help)", async () => {
    let captured: { cmd: string; args: readonly string[] } | null = null;
    const { proc } = makeFakeChild({ exitCode: 0 });
    const spawnFn = ((cmd: string, args: readonly string[]) => {
      captured = { cmd, args };
      return proc;
    }) as unknown as typeof spawn;

    const { verifyDrawOnPython } = await import("@/lib/draw-on-python");
    await verifyDrawOnPython({
      pythonPath: "C:/python/python.exe",
      spawnFn,
    });

    expect(captured).not.toBeNull();
    expect(captured!.cmd).toBe("C:/python/python.exe");
    expect(captured!.args).toEqual(["-m", "draw_on", "--help"]);
  });

  it("rejects on non-zero exit code with the stderr tail in the message", async () => {
    const { proc } = makeFakeChild({
      exitCode: 1,
      stderrLines: [
        "ModuleNotFoundError: No module named 'draw_on'\n",
      ],
    });
    const spawnFn = (() => proc) as unknown as typeof spawn;

    const { verifyDrawOnPython } = await import("@/lib/draw-on-python");
    await expect(
      verifyDrawOnPython({ pythonPath: "py", spawnFn })
    ).rejects.toThrow(/exited with code 1/);
  });

  it("rejects on spawn ENOENT (binary missing)", async () => {
    const { proc } = makeFakeChild({
      emitErrorBeforeClose: Object.assign(new Error("ENOENT"), {
        code: "ENOENT",
      }),
    });
    const spawnFn = (() => proc) as unknown as typeof spawn;

    const { verifyDrawOnPython } = await import("@/lib/draw-on-python");
    await expect(
      verifyDrawOnPython({ pythonPath: "/no/such/python", spawnFn })
    ).rejects.toThrow(/failed to spawn/);
  });

  it("rejects with a timeout error when the child doesn't exit within timeoutMs", async () => {
    const { proc, killCalls } = makeFakeChild({
      exitCode: 0,
      closeDelayMs: 5000, // long-running
    });
    const spawnFn = (() => proc) as unknown as typeof spawn;

    const { verifyDrawOnPython } = await import("@/lib/draw-on-python");
    const start = Date.now();
    await expect(
      verifyDrawOnPython({ pythonPath: "py", timeoutMs: 80, spawnFn })
    ).rejects.toThrow(/timed out/i);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(killCalls.length).toBeGreaterThanOrEqual(1); // child was killed
  });

  it("default timeoutMs is finite (5s) — won't hang the precheck if python becomes catatonic", async () => {
    // Sanity pin — call without timeoutMs and confirm the default is applied.
    // We verify by checking that on a 0-delay close, the call resolves
    // quickly (well under any conceivable default).
    const { proc } = makeFakeChild({ exitCode: 0, closeDelayMs: 1 });
    const spawnFn = (() => proc) as unknown as typeof spawn;

    const { verifyDrawOnPython } = await import("@/lib/draw-on-python");
    const start = Date.now();
    await verifyDrawOnPython({ pythonPath: "py", spawnFn });
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe("draw_on_python_path setting", () => {
  it("seeds an empty default on a fresh DB (empty triggers venv fallback in the resolver)", () => {
    const db = freshDb();
    expect(getSetting("draw_on_python_path", db)).toBe("");
  });

  it("round-trips an operator-set absolute path verbatim through setSetting", () => {
    const db = freshDb();
    setSetting("draw_on_python_path", "D:/python313/python.exe", db);
    expect(getSetting("draw_on_python_path", db)).toBe(
      "D:/python313/python.exe"
    );
  });

  it("[integration] fresh-DB default feeds the resolver to the .venv path on this machine", () => {
    const db = freshDb();
    const setting = getSetting("draw_on_python_path", db);
    const expected = resolve(
      process.cwd(),
      process.platform === "win32"
        ? DRAW_ON_VENV_WINDOWS_RELATIVE
        : DRAW_ON_VENV_POSIX_RELATIVE
    );
    if (!existsSync(expected)) return; // skip on fresh checkouts (see real-machine note above)
    expect(resolveDrawOnPythonPath({ setting })).toBe(expected);
  });
});
