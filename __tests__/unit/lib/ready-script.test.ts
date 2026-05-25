import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb, seedDefaultSettings } from "@/lib/db";
import * as videosRepo from "@/lib/repos/videos";
import { applyReadyScriptArtifacts } from "@/lib/ready-script";

const openDbs: DatabaseType[] = [];
const tmpDirs: string[] = [];

function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
  openDbs.push(db);
  return db;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "histforge-ready-script-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (openDbs.length) {
    try {
      openDbs.pop()!.close();
    } catch {
      // already closed
    }
  }
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows lock race
    }
  }
});

function getStepStatuses(
  db: DatabaseType,
  videoId: string
): Record<string, string> {
  const rows = db
    .prepare(
      "SELECT step_name, status FROM video_steps WHERE video_id = ?"
    )
    .all(videoId) as Array<{ step_name: string; status: string }>;
  return Object.fromEntries(rows.map((r) => [r.step_name, r.status]));
}

describe("applyReadyScriptArtifacts", () => {
  it("writes a sanitized full_script.md and pre-marks the script-generation steps + assemble_script as done", () => {
    const db = freshDb();
    const projectsDir = tempDir();
    videosRepo.createNewVideo(db, {
      id: "v1",
      title: "T",
      topic_info: "[ready script — generation skipped]",
      workflow_id: "comfyui",
      provided_script: "Lived—seventeen talents—enough.",
      created_at: 1,
    });

    applyReadyScriptArtifacts(db, "v1", projectsDir);

    const scriptPath = join(projectsDir, "v1", "script", "full_script.md");
    expect(existsSync(scriptPath)).toBe(true);
    expect(readFileSync(scriptPath, "utf8")).toBe(
      "Lived, seventeen talents, enough."
    );

    const statuses = getStepStatuses(db, "v1");
    // ComfyUI workflow snapshot has the three script-module steps; the
    // helper also pre-marks the glue `assemble_script` step.
    expect(statuses).toEqual({
      research_outline: "done",
      write_hook: "done",
      write_chapters: "done",
      assemble_script: "done",
    });
  });

  it("is idempotent — second call rewrites the file with the (sanitized) current value and does not overwrite pre-existing step rows", () => {
    const db = freshDb();
    const projectsDir = tempDir();
    videosRepo.createNewVideo(db, {
      id: "v1",
      title: "T",
      topic_info: "[ready script — generation skipped]",
      workflow_id: "comfyui",
      provided_script: "first—pass",
      created_at: 1,
    });

    applyReadyScriptArtifacts(db, "v1", projectsDir);
    const scriptPath = join(projectsDir, "v1", "script", "full_script.md");
    expect(readFileSync(scriptPath, "utf8")).toBe("first, pass");

    // Simulate the orchestrator's pre-loop or a PATCH resync: update the
    // script and call again. The file must reflect the new value, and
    // INSERT OR IGNORE must leave any pre-existing row untouched.
    db.prepare("UPDATE videos SET provided_script = ? WHERE id = ?").run(
      "second—pass",
      "v1"
    );
    // Pretend the orchestrator has already flipped one of the step rows
    // to `pending` between the two calls — the second call must NOT
    // clobber it back to `done`. (Belt-and-suspenders for the
    // INSERT-OR-IGNORE contract.)
    db.prepare(
      "UPDATE video_steps SET status = 'pending' WHERE video_id = ? AND step_name = ?"
    ).run("v1", "research_outline");

    expect(() =>
      applyReadyScriptArtifacts(db, "v1", projectsDir)
    ).not.toThrow();

    expect(readFileSync(scriptPath, "utf8")).toBe("second, pass");
    // INSERT OR IGNORE — the pre-existing row stays at 'pending'.
    expect(getStepStatuses(db, "v1").research_outline).toBe("pending");
    // The other rows, which already existed as 'done', also stay 'done'.
    expect(getStepStatuses(db, "v1").assemble_script).toBe("done");
    // And no duplicate rows.
    const rowCount = db
      .prepare("SELECT COUNT(*) AS n FROM video_steps WHERE video_id = ?")
      .get("v1") as { n: number };
    expect(rowCount.n).toBe(4);
  });

  it("is a no-op when provided_script is null (topic-driven video)", () => {
    const db = freshDb();
    const projectsDir = tempDir();
    videosRepo.createNewVideo(db, {
      id: "v1",
      title: "T",
      topic_info: "topic",
      workflow_id: "comfyui",
      created_at: 1,
    });

    applyReadyScriptArtifacts(db, "v1", projectsDir);

    expect(existsSync(join(projectsDir, "v1"))).toBe(false);
    expect(getStepStatuses(db, "v1")).toEqual({});
  });
});
