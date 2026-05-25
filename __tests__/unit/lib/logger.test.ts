import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLog } from "@/lib/logger";

const tmpDirs: string[] = [];
function tempProjectsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "histforge-logger-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // OS-managed temp dirs; ignore Windows lock races.
    }
  }
});

describe("appendLog", () => {
  it("creates the project dir and log file with [step] timestamp message format", () => {
    const projectsDir = tempProjectsDir();
    const videoId = "v_abcdef";

    // Sanity: brand-new video, dir does not yet exist.
    expect(existsSync(join(projectsDir, videoId))).toBe(false);

    appendLog(videoId, "research_outline", "starting LLM call", projectsDir);

    const logPath = join(projectsDir, videoId, "pipeline.log");
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, "utf-8");
    // Format: [step_name] <ISO timestamp> <message>\n
    expect(content).toMatch(
      /^\[research_outline\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z starting LLM call\n$/
    );
  });

  it("appends subsequent calls instead of overwriting", () => {
    const projectsDir = tempProjectsDir();
    const videoId = "v_append";

    appendLog(videoId, "research_outline", "first line", projectsDir);
    appendLog(videoId, "research_outline", "second line", projectsDir);
    appendLog(videoId, "voiceover", "third from another step", projectsDir);

    const content = readFileSync(
      join(projectsDir, videoId, "pipeline.log"),
      "utf-8"
    );
    const lines = content.trimEnd().split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\[research_outline\] .* first line$/);
    expect(lines[1]).toMatch(/^\[research_outline\] .* second line$/);
    expect(lines[2]).toMatch(
      /^\[voiceover\] .* third from another step$/
    );
  });
});
