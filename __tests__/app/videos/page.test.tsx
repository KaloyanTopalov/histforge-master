import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-videos-page-"));
  process.env.DATABASE_URL = join(tempDir, "test.db");
});

afterAll(async () => {
  const { getDb } = await import("@/lib/db");
  try {
    getDb().close();
  } catch {
    /* already closed */
  }
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { getDb, seedDefaultSettings, seedDefaultWorkflows } = await import(
    "@/lib/db"
  );
  const db = getDb();
  db.exec(
    "DELETE FROM video_steps; DELETE FROM videos; DELETE FROM workflow_steps; DELETE FROM workflows; DELETE FROM settings;"
  );
  seedDefaultSettings(db);
  seedDefaultWorkflows(db);
});

describe("listEnabledWorkflowsForClient", () => {
  it("excludes disabled workflows", async () => {
    const { getDb } = await import("@/lib/db");
    getDb()
      .prepare("UPDATE workflows SET enabled = 0 WHERE id = ?")
      .run("google-flow");

    const { listEnabledWorkflowsForClient } = await import(
      "@/app/videos/page"
    );
    const result = listEnabledWorkflowsForClient(getDb());
    expect(result.map((w) => w.id)).toEqual([
      "comfyui",
      "google-flow-clips-only",
      "google-flow-images-only",
      "music-video-magnific-suno",
      "narrative-magnific-nano-banana",
    ]);
  });

  it("maps WorkflowRow to the {id, shortLabel, label, kind} client shape", async () => {
    const { getDb } = await import("@/lib/db");
    const { listEnabledWorkflowsForClient } = await import(
      "@/app/videos/page"
    );
    const result = listEnabledWorkflowsForClient(getDb());
    expect(result).toEqual([
      {
        id: "comfyui",
        shortLabel: "ComfyUI",
        label: "ComfyUI (local images, local hook video)",
        kind: "narrative",
      },
      {
        id: "google-flow",
        shortLabel: "Google Flow",
        label: "Google Flow (cloud images, cloud hook video)",
        kind: "narrative",
      },
      {
        id: "google-flow-clips-only",
        shortLabel: "GF Clips",
        label: "Google Flow (clips only)",
        kind: "narrative",
      },
      {
        id: "google-flow-images-only",
        shortLabel: "GF Images",
        label: "Google Flow (images only)",
        kind: "narrative",
      },
      {
        id: "music-video-magnific-suno",
        shortLabel: "Magnific × Suno",
        label: "Music video (Magnific images + Suno music)",
        kind: "music_video",
      },
      {
        id: "narrative-magnific-nano-banana",
        shortLabel: "Magnific NB2",
        label: "Narrative — Magnific (Nano Banana 2)",
        kind: "narrative",
      },
    ]);
  });
});
