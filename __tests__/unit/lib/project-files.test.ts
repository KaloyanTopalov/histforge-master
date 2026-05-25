import { describe, it, expect, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProjectFiles } from "@/lib/project-files";

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "histforge-project-files-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("listProjectFiles", () => {
  it("returns [] when the directory does not exist", () => {
    expect(listProjectFiles("/no/such/path/__nope__")).toEqual([]);
  });

  it("returns forward-slash relative paths for nested files, sorted", () => {
    const dir = freshDir();
    mkdirSync(join(dir, "script"), { recursive: true });
    mkdirSync(join(dir, "audio"), { recursive: true });
    writeFileSync(join(dir, "top.md"), "top");
    writeFileSync(join(dir, "script", "hook.md"), "hook");
    writeFileSync(join(dir, "script", "outline.md"), "outline");
    writeFileSync(join(dir, "audio", "narration.mp3"), "mp3");

    const out = listProjectFiles(dir);

    // Sorted; relative to dir; forward slashes on every platform.
    expect(out).toEqual([
      "audio/narration.mp3",
      "script/hook.md",
      "script/outline.md",
      "top.md",
    ]);
  });

  it("recurses into subdirectories (directories themselves are not listed)", () => {
    const dir = freshDir();
    mkdirSync(join(dir, "a", "b", "c"), { recursive: true });
    writeFileSync(join(dir, "a", "b", "c", "leaf.txt"), "leaf");

    const out = listProjectFiles(dir);

    expect(out).toEqual(["a/b/c/leaf.txt"]);
  });

  it("returns [] for an existing but empty directory", () => {
    const dir = freshDir();
    expect(listProjectFiles(dir)).toEqual([]);
  });
});
