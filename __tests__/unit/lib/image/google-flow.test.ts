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
import { makeGoogleFlowImageProvider } from "@/lib/image/google-flow";
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
  const dir = mkdtempSync(join(tmpdir(), "histforge-gflow-image-"));
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

describe("makeGoogleFlowImageProvider", () => {
  it("generateBatch enqueues createImage tasks for image chunks via runGoogleFlowStep", async () => {
    const db = freshDb();
    const projectsDir = tempProjectsDir();
    insertVideo(db, "v1");
    insertAccount(db, "acc_01");
    writeChunks(projectsDir, "v1", [
      {
        id: "image_001",
        kind: "image",
        start: 0,
        end: 1,
        text: "",
        prompt: "a fortress",
      },
      {
        id: "image_002",
        kind: "image",
        start: 1,
        end: 2,
        text: "",
        prompt: "a ship",
      },
    ]);

    const promise = makeGoogleFlowImageProvider(noOpModerator).generateBatch(
      [
        { id: "image_001", prompt: "a fortress" },
        { id: "image_002", prompt: "a ship" },
      ],
      // targetDir is unused by Google Flow — paths come from spec.outputDir
      join(projectsDir, "v1", "images"),
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
        chunk_id: "image_001",
        kind: "image",
        mode: "createImage",
        output_path: "images/image_001.png",
      },
      {
        chunk_id: "image_002",
        kind: "image",
        mode: "createImage",
        output_path: "images/image_002.png",
      },
    ]);
  });

  it("generateBatch propagates DeferSignal from runGoogleFlowStep when queue is paused", async () => {
    const db = freshDb();
    const projectsDir = tempProjectsDir();
    insertVideo(db, "v1");
    insertAccount(db, "acc_01");
    writeChunks(projectsDir, "v1", [
      {
        id: "image_001",
        kind: "image",
        start: 0,
        end: 1,
        text: "",
        prompt: "a tower",
      },
    ]);
    // Globally pause the queue so wait returns a defer.
    db.prepare(
      "UPDATE settings SET value = 'paused' WHERE key = 'queue_state'"
    ).run();

    const result = await makeGoogleFlowImageProvider(
      noOpModerator
    ).generateBatch([{ id: "image_001", prompt: "a tower" }], join(projectsDir, "v1", "images"), {
      db,
      videoId: "v1",
      projectsDir,
      log: () => {},
      pollIntervalMs: 1,
    });
    expect(result).toMatchObject({ deferred: true });
  });

  it("cleanup is a no-op — does NOT delete images/", async () => {
    const projectsDir = tempProjectsDir();
    const imagesDir = join(projectsDir, "v1", "images");
    mkdirSync(imagesDir, { recursive: true });
    writeFileSync(join(imagesDir, "image_001.png"), "data");

    await makeGoogleFlowImageProvider(noOpModerator).cleanup!("v1", {
      projectsDir,
    });

    expect(existsSync(imagesDir)).toBe(true);
    expect(existsSync(join(imagesDir, "image_001.png"))).toBe(true);
  });
});
