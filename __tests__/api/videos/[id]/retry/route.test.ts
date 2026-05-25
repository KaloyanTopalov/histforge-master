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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-video-retry-"));
  process.env.DATABASE_URL = join(tempDir, "test.db");
});

afterAll(async () => {
  const { getDb } = await import("@/lib/db");
  try {
    getDb().close();
  } catch {
    // already closed
  }
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { getDb, seedDefaultSettings } = await import("@/lib/db");
  const db = getDb();
  db.exec("DELETE FROM video_steps; DELETE FROM videos;");
  seedDefaultSettings(db);
});

interface SeedOpts {
  videoStatus: string;
  failedStep?: string | null;
  startedAt?: number | null;
  currentStep?: string | null;
  failedReason?: string | null;
  finishedAt?: number | null;
}

async function seedFailedVideo(
  videoId: string,
  opts: SeedOpts
): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const { resolveSnapshot, materializeStepList } = await import(
    "@/lib/workflows"
  );
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO videos (id, title, topic_info, workflow_id, status, current_step, failed_step, failed_reason, started_at, finished_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    videoId,
    "topic",
    "info",
    "comfyui",
    opts.videoStatus,
    opts.currentStep ?? null,
    opts.failedStep ?? null,
    opts.failedReason ?? null,
    opts.startedAt ?? null,
    opts.finishedAt ?? null,
    now
  );
  const slugs = materializeStepList(resolveSnapshot(db, "comfyui"));
  // Seed step rows: everything before failedStep done, failedStep failed,
  // everything after pending.
  let seen = false;
  const insertDone = db.prepare(
    "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, 'done', 100, 200)"
  );
  const insertFailed = db.prepare(
    "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, 'failed', 100, 200)"
  );
  const insertPending = db.prepare(
    "INSERT INTO video_steps (video_id, step_name, status) VALUES (?, ?, 'pending')"
  );
  for (const stepName of slugs) {
    if (stepName === opts.failedStep) {
      insertFailed.run(videoId, stepName);
      seen = true;
    } else if (!seen) {
      insertDone.run(videoId, stepName);
    } else {
      insertPending.run(videoId, stepName);
    }
  }
}

describe("POST /api/videos/:id/retry", () => {
  it("re-queues a failed video: failed step → pending, video → queued, preserves started_at", async () => {
    await seedFailedVideo("v1", {
      videoStatus: "failed",
      failedStep: "voiceover",
      startedAt: 42,
      currentStep: null,
      failedReason: "GenAI Pro timeout",
      finishedAt: 999,
    });

    const { POST } = await import("@/app/api/videos/[id]/retry/route");
    const res = await POST(
      new Request("http://localhost/api/videos/v1/retry", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const db = getDb();

    const video = db
      .prepare("SELECT * FROM videos WHERE id = ?")
      .get("v1") as {
      status: string;
      failed_step: string | null;
      failed_reason: string | null;
      finished_at: number | null;
      started_at: number | null;
      current_step: string | null;
    };

    expect(video.status).toBe("queued");
    expect(video.failed_step).toBeNull();
    expect(video.failed_reason).toBeNull();
    expect(video.finished_at).toBeNull();
    // started_at is preserved.
    expect(video.started_at).toBe(42);

    const failedStepRow = db
      .prepare(
        "SELECT * FROM video_steps WHERE video_id = ? AND step_name = 'voiceover'"
      )
      .get("v1") as {
      status: string;
      started_at: number | null;
      finished_at: number | null;
    };
    expect(failedStepRow.status).toBe("pending");
    expect(failedStepRow.started_at).toBeNull();
    expect(failedStepRow.finished_at).toBeNull();

    // Earlier done steps are untouched.
    const researchStep = db
      .prepare(
        "SELECT * FROM video_steps WHERE video_id = ? AND step_name = 'research_outline'"
      )
      .get("v1") as { status: string };
    expect(researchStep.status).toBe("done");
  });

  it("returns 409 when the video is not failed", async () => {
    await seedFailedVideo("v1", {
      videoStatus: "in_progress",
      failedStep: null,
    });
    const { POST } = await import("@/app/api/videos/[id]/retry/route");
    const res = await POST(
      new Request("http://localhost/api/videos/v1/retry", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(409);
  });

  it("returns 404 when the video does not exist", async () => {
    const { POST } = await import("@/app/api/videos/[id]/retry/route");
    const res = await POST(
      new Request("http://localhost/api/videos/nope/retry", {
        method: "POST",
      }),
      { params: { id: "nope" } }
    );
    expect(res.status).toBe(404);
  });
});
