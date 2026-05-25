import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, seedDefaultSettings } from "@/lib/db";
import { makeGoogleFlowVideoProvider } from "@/lib/video/google-flow";
import type { Chunk } from "@/types";
import { noOpModerator } from "../../../helpers/no-op-moderator";

const openDbs: DatabaseType[] = [];
const tmpDirs: string[] = [];

function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
  openDbs.push(db);
  return db;
}

function tempProjectsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "histforge-gflow-video-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (openDbs.length) {
    try {
      openDbs.pop()!.close();
    } catch {
      /* ignore */
    }
  }
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function insertVideo(db: DatabaseType, id: string): void {
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, "T", "info", "google-flow", "in_progress", 1);
}

function insertAccount(db: DatabaseType, id: string): void {
  db.prepare(
    "INSERT INTO google_flow_accounts (id, name, token, enabled, paused_until, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, id, `tok_${id}`, 1, null, 1);
}

function writeChunks(
  projectsDir: string,
  videoId: string,
  chunks: Chunk[]
): void {
  const dir = join(projectsDir, videoId, "chunks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "chunks.json"), JSON.stringify(chunks));
}

describe("makeGoogleFlowVideoProvider", () => {
  it("generateBatch enqueues clip text-mode tasks via runGoogleFlowStep", async () => {
    const db = freshDb();
    const projectsDir = tempProjectsDir();
    insertVideo(db, "v1");
    insertAccount(db, "acc_01");
    writeChunks(projectsDir, "v1", [
      {
        id: "clip_001",
        kind: "clip",
        start: 0,
        end: 1,
        text: "",
        prompt: "a sweeping pan",
      },
    ]);

    const promise = makeGoogleFlowVideoProvider(noOpModerator).generateBatch(
      [{ id: "clip_001", prompt: "a sweeping pan" }],
      join(projectsDir, "v1", "videos", "clip"),
      {
        db,
        videoId: "v1",
        projectsDir,
        log: () => {},
        pollIntervalMs: 1,
      }
    );

    await new Promise((r) => setTimeout(r, 5));
    db.prepare("UPDATE google_flow_queue SET status = 'done'").run();
    const result = await promise;
    expect(result).toBeUndefined();

    const rows = db
      .prepare(
        "SELECT chunk_id, kind, mode, output_path FROM google_flow_queue WHERE video_id = ? ORDER BY id"
      )
      .all("v1") as Array<{
      chunk_id: string;
      kind: string;
      mode: string;
      output_path: string;
    }>;
    expect(rows).toEqual([
      {
        chunk_id: "clip_001",
        kind: "clip",
        mode: "text",
        output_path: "videos/clip/clip_001.mp4",
      },
    ]);
  });

  it("cleanup is a no-op — does NOT delete videos/clip", async () => {
    const projectsDir = tempProjectsDir();
    const clipDir = join(projectsDir, "v1", "videos", "clip");
    mkdirSync(clipDir, { recursive: true });
    writeFileSync(join(clipDir, "clip_001.mp4"), "data");

    await makeGoogleFlowVideoProvider(noOpModerator).cleanup!("v1", {
      projectsDir,
    });

    expect(existsSync(clipDir)).toBe(true);
    expect(existsSync(join(clipDir, "clip_001.mp4"))).toBe(true);
  });
});
