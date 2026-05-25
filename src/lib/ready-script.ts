import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import type { WorkflowSnapshot } from "@/types";
import { sanitizeScript } from "@/lib/script-sanitize";

/**
 * Queue-time prep for ready-script videos. When `videos.provided_script`
 * is non-null, write `script/full_script.md` (sanitized for TTS) to the
 * project dir and pre-mark every script-generation step as `done` so the
 * orchestrator's skip-done logic (`pipeline.ts:403`) advances straight to
 * voiceover. No-op for topic-driven videos.
 *
 * `INSERT OR IGNORE` is required: the orchestrator's pre-loop
 * `upsertPending` (`lib/repos/steps.ts:67-75`) runs after this and must
 * not overwrite the pre-marked rows.
 */
export function applyReadyScriptArtifacts(
  db: DatabaseType,
  videoId: string,
  projectsDir: string = process.env.PROJECTS_DIR ?? "./projects"
): void {
  const row = db
    .prepare(
      "SELECT provided_script, workflow_snapshot FROM videos WHERE id = ?"
    )
    .get(videoId) as
    | { provided_script: string | null; workflow_snapshot: string | null }
    | undefined;
  if (!row || row.provided_script === null) return;
  if (row.workflow_snapshot === null) {
    throw new Error(
      `Video ${videoId} has no workflow snapshot — invariant violation`
    );
  }
  const snapshot = JSON.parse(row.workflow_snapshot) as WorkflowSnapshot;

  const scriptDir = join(projectsDir, videoId, "script");
  mkdirSync(scriptDir, { recursive: true });
  const { text } = sanitizeScript(row.provided_script);
  writeFileSync(join(scriptDir, "full_script.md"), text, "utf8");

  const stepNames = [
    ...snapshot.steps.map((s) => s.step_name),
    "assemble_script",
  ];
  const insert = db.prepare(
    "INSERT OR IGNORE INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, 'done', ?, ?)"
  );
  db.transaction(() => {
    const now = Date.now();
    for (const name of stepNames) {
      insert.run(videoId, name, now, now);
    }
  })();
}
