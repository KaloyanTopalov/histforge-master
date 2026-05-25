import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let projectsDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-flow-requeue-failed-"));
  process.env.DATABASE_URL = join(tempDir, "test.db");
  projectsDir = join(tempDir, "projects");
  mkdirSync(projectsDir, { recursive: true });
  process.env.PROJECTS_DIR = projectsDir;
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
  const { getDb, seedDefaultSettings } = await import("@/lib/db");
  const db = getDb();
  db.exec(
    "DELETE FROM moderation_events; DELETE FROM google_flow_queue; DELETE FROM google_flow_accounts; DELETE FROM video_steps; DELETE FROM videos; DELETE FROM settings;"
  );
  rmSync(projectsDir, { recursive: true, force: true });
  mkdirSync(projectsDir, { recursive: true });
  seedDefaultSettings(db);
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("v1", "Test", "info", "google-flow", "in_progress", 1);
  db.prepare(
    "INSERT INTO google_flow_accounts (id, name, token, created_at) VALUES (?, ?, ?, ?)"
  ).run("acc_01", "Primary", "tok_1", 1);
});

async function postRequeue(
  videoId: string,
  force = false
): Promise<Response> {
  const { POST } = await import(
    "@/app/api/flow/requeue-failed/[videoId]/route"
  );
  const url = `http://localhost/api/flow/requeue-failed/${videoId}${
    force ? "?force=1" : ""
  }`;
  return POST(new Request(url, { method: "POST" }), {
    params: { videoId },
  });
}

async function insertFailed(
  chunk_id: string,
  retry_count: number,
  kind: "image" | "clip" = "image"
): Promise<number> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO google_flow_queue (
         video_id, chunk_id, kind, mode, prompt, output_path, status,
         retry_count, priority, created_at, error_reason, external_task_id,
         assigned_account_id, dispatched_at
       ) VALUES (?, ?, ?, 'createImage', 'p', ?, 'failed', ?, 0, 1,
                'boom', 'ext_1', 'acc_01', 2)`
    )
    .run("v1", chunk_id, kind, `images/${chunk_id}.png`, retry_count);
  return Number(info.lastInsertRowid);
}

async function statusById(id: number): Promise<string | undefined> {
  const { getDb } = await import("@/lib/db");
  const row = getDb()
    .prepare("SELECT status FROM google_flow_queue WHERE id = ?")
    .get(id) as { status: string } | undefined;
  return row?.status;
}

interface ChunkSeed {
  id: string;
  kind: "main" | "hook";
  prompt: string | null;
  prompt_history?: string[];
}

function writeChunksJson(videoId: string, chunks: ChunkSeed[]): void {
  const dir = join(projectsDir, videoId, "chunks");
  mkdirSync(dir, { recursive: true });
  const payload = chunks.map((c) => ({
    id: c.id,
    kind: c.kind,
    start: 0,
    end: 1,
    text: "",
    prompt: c.prompt,
    ...(c.prompt_history ? { prompt_history: c.prompt_history } : {}),
  }));
  writeFileSync(join(dir, "chunks.json"), JSON.stringify(payload), "utf-8");
}

describe("POST /api/flow/requeue-failed/[videoId]", () => {
  it("requeues failed rows under the retry cap and leaves over-cap rows alone", async () => {
    // google_flow_max_retries defaults to 3; retry_count starts at 0.
    const id1 = await insertFailed("c1", 1); // under cap
    const id2 = await insertFailed("c2", 3); // at cap — skip
    const id3 = await insertFailed("c3", 0); // under cap

    const res = await postRequeue("v1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, requeued: 2 });

    expect(await statusById(id1)).toBe("pending");
    expect(await statusById(id2)).toBe("failed");
    expect(await statusById(id3)).toBe("pending");
  });

  it("force=1 requeues every failed row regardless of retry_count", async () => {
    const id1 = await insertFailed("c1", 3);
    const id2 = await insertFailed("c2", 7);

    const res = await postRequeue("v1", true);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requeued).toBe(2);
    expect(await statusById(id1)).toBe("pending");
    expect(await statusById(id2)).toBe("pending");
  });

  it("requeue clears external_task_id + assigned_account_id + dispatched_at", async () => {
    const { getDb } = await import("@/lib/db");
    const id = await insertFailed("c1", 0);

    await postRequeue("v1");

    const row = getDb()
      .prepare(
        "SELECT external_task_id, assigned_account_id, dispatched_at FROM google_flow_queue WHERE id = ?"
      )
      .get(id) as {
      external_task_id: string | null;
      assigned_account_id: string | null;
      dispatched_at: number | null;
    };
    expect(row.external_task_id).toBeNull();
    expect(row.assigned_account_id).toBeNull();
    expect(row.dispatched_at).toBeNull();
  });

  it("returns 404 for an unknown video", async () => {
    const res = await postRequeue("nope");
    expect(res.status).toBe(404);
  });

  it("is a no-op with {requeued: 0} when no failed rows exist", async () => {
    const res = await postRequeue("v1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, requeued: 0 });
  });

  it("resumes a failed video by resetting the failed step + clearing failure metadata when at least one row was requeued", async () => {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    db.prepare(
      "UPDATE videos SET status = 'failed', failed_step = ?, failed_reason = ?, finished_at = ? WHERE id = 'v1'"
    ).run("generate_images", "boom", 999);
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, 'failed', ?, ?)"
    ).run("v1", "generate_images", 100, 200);
    await insertFailed("c1", 0);

    const res = await postRequeue("v1", true);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, resumedFailedStep: true });

    const video = db
      .prepare(
        "SELECT status, failed_step, failed_reason, finished_at FROM videos WHERE id = 'v1'"
      )
      .get() as {
      status: string;
      failed_step: string | null;
      failed_reason: string | null;
      finished_at: number | null;
    };
    expect(video.status).toBe("queued");
    expect(video.failed_step).toBeNull();
    expect(video.failed_reason).toBeNull();
    expect(video.finished_at).toBeNull();

    const step = db
      .prepare(
        "SELECT status, started_at, finished_at FROM video_steps WHERE video_id = 'v1' AND step_name = 'generate_images'"
      )
      .get() as {
      status: string;
      started_at: number | null;
      finished_at: number | null;
    };
    expect(step.status).toBe("pending");
    expect(step.started_at).toBeNull();
    expect(step.finished_at).toBeNull();
  });

  it("does NOT touch video/step status when nothing was requeued, even on a failed video", async () => {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    db.prepare(
      "UPDATE videos SET status = 'failed', failed_step = ?, failed_reason = ? WHERE id = 'v1'"
    ).run("generate_images", "boom");

    const res = await postRequeue("v1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, requeued: 0, resumedFailedStep: false });

    const video = db
      .prepare("SELECT status, failed_step FROM videos WHERE id = 'v1'")
      .get() as { status: string; failed_step: string | null };
    expect(video.status).toBe("failed");
    expect(video.failed_step).toBe("generate_images");
  });

  it("syncs queue-row prompt from chunks.json when the chunk's prompt has diverged, resets moderation_round, and logs a manual_edit event", async () => {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    db.prepare(
      `UPDATE google_flow_queue SET moderation_round = 2 WHERE 1=0`
    ); // touch nothing, just ensures the column exists
    const id = await insertFailed("c1", 0);
    db.prepare(
      "UPDATE google_flow_queue SET prompt = 'old prompt', moderation_round = 2 WHERE id = ?"
    ).run(id);
    writeChunksJson("v1", [
      { id: "c1", kind: "main", prompt: "operator-edited prompt" },
    ]);

    const res = await postRequeue("v1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, requeued: 1, promptsSynced: 1 });

    const row = db
      .prepare(
        "SELECT prompt, moderation_round, status, error_reason FROM google_flow_queue WHERE id = ?"
      )
      .get(id) as {
      prompt: string;
      moderation_round: number;
      status: string;
      error_reason: string | null;
    };
    expect(row.prompt).toBe("operator-edited prompt");
    expect(row.moderation_round).toBe(0);
    expect(row.status).toBe("pending");
    expect(row.error_reason).toBeNull();

    const ev = db
      .prepare(
        "SELECT chunk_id, round, original_prompt, rewritten_prompt, reason_tag FROM moderation_events WHERE video_id = 'v1'"
      )
      .all() as Array<{
      chunk_id: string;
      round: number;
      original_prompt: string;
      rewritten_prompt: string;
      reason_tag: string | null;
    }>;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      chunk_id: "c1",
      round: 0,
      original_prompt: "old prompt",
      rewritten_prompt: "operator-edited prompt",
      reason_tag: "manual_edit",
    });
  });

  it("does NOT touch the queue-row prompt or log an event when chunks.json prompt matches", async () => {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    const id = await insertFailed("c1", 0);
    db.prepare(
      "UPDATE google_flow_queue SET prompt = 'same prompt', moderation_round = 2 WHERE id = ?"
    ).run(id);
    writeChunksJson("v1", [
      { id: "c1", kind: "main", prompt: "same prompt" },
    ]);

    const res = await postRequeue("v1");
    const body = await res.json();
    expect(body).toMatchObject({ promptsSynced: 0, requeued: 1 });

    const row = db
      .prepare(
        "SELECT prompt, moderation_round FROM google_flow_queue WHERE id = ?"
      )
      .get(id) as { prompt: string; moderation_round: number };
    expect(row.prompt).toBe("same prompt");
    expect(row.moderation_round).toBe(2);

    const eventCount = db
      .prepare("SELECT COUNT(*) AS n FROM moderation_events")
      .get() as { n: number };
    expect(eventCount.n).toBe(0);
  });

  it("falls through to plain requeue when chunks.json is missing", async () => {
    const id = await insertFailed("c1", 0);
    // No writeChunksJson call: chunks.json does not exist.

    const res = await postRequeue("v1");
    const body = await res.json();
    expect(body).toMatchObject({ promptsSynced: 0, requeued: 1 });
    expect(await statusById(id)).toBe("pending");
  });

  it("skips prompt sync when chunks.json prompt is null", async () => {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    const id = await insertFailed("c1", 0);
    db.prepare(
      "UPDATE google_flow_queue SET prompt = 'queue prompt' WHERE id = ?"
    ).run(id);
    writeChunksJson("v1", [{ id: "c1", kind: "main", prompt: null }]);

    const res = await postRequeue("v1");
    const body = await res.json();
    expect(body).toMatchObject({ promptsSynced: 0, requeued: 1 });

    const promptAfter = (db
      .prepare("SELECT prompt FROM google_flow_queue WHERE id = ?")
      .get(id) as { prompt: string }).prompt;
    expect(promptAfter).toBe("queue prompt");
  });

  it("does NOT touch video/step status when the video is in_progress (only failed videos transition)", async () => {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    await insertFailed("c1", 0);

    const res = await postRequeue("v1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, requeued: 1, resumedFailedStep: false });

    const status = db
      .prepare("SELECT status FROM videos WHERE id = 'v1'")
      .get() as { status: string };
    expect(status.status).toBe("in_progress");
  });
});
