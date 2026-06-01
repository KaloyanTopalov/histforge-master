import { afterEach, describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb, seedDefaultSettings } from "@/lib/db";
import { getSetting, setSetting } from "@/lib/settings";
import {
  resolveDrawOnPythonPath,
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
