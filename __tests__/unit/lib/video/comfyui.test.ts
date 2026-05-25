import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comfyuiVideoProvider } from "@/lib/video/comfyui";

const tmpDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `histforge-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("comfyuiVideoProvider", () => {
  it("cleanup removes <projectsDir>/<videoId>/videos/clip recursively", () => {
    const projectsDir = tempDir("project");
    const videoId = "v_clean";
    const clipDir = join(projectsDir, videoId, "videos", "clip");
    mkdirSync(clipDir, { recursive: true });
    writeFileSync(join(clipDir, "clip_001.mp4"), "fake-mp4", "utf-8");
    expect(existsSync(clipDir)).toBe(true);

    comfyuiVideoProvider.cleanup!(videoId, { projectsDir });

    expect(existsSync(clipDir)).toBe(false);
    expect(existsSync(join(projectsDir, videoId))).toBe(true);
  });

  it("cleanup is a no-op when target dir doesn't exist", () => {
    const projectsDir = tempDir("project");
    expect(() =>
      comfyuiVideoProvider.cleanup!("v_missing", { projectsDir })
    ).not.toThrow();
  });
});
