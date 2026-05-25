import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Append one line to a video's pipeline.log. Per docs/histforge-spec.md:774-781:
 * append-only, prefixed `[<step_name>] <ISO timestamp> <message>`.
 *
 * The plan (Task 1.3) requires `mkdir -p`-ing the parent dir on every call —
 * for a brand-new video the projects/<id>/ dir does not yet exist when the
 * first log line is written, and the orchestrator (Task 1.5) sets a step to
 * `running` and calls `step.run()` before any other side effect, so the very
 * first thing a step writes is often a log line.
 */
export function appendLog(
  videoId: string,
  stepName: string,
  message: string,
  projectsDir: string = process.env.PROJECTS_DIR ?? "./projects"
): void {
  const projectDir = join(projectsDir, videoId);
  mkdirSync(projectDir, { recursive: true });

  const line = `[${stepName}] ${new Date().toISOString()} ${message}\n`;
  appendFileSync(join(projectDir, "pipeline.log"), line, "utf-8");
}
