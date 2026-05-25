import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let projectsDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-flow-queue-row-"));
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
});

async function postEdit(rowId: number, body: unknown): Promise<Response> {
  const { POST } = await import("@/app/api/flow/queue-row/[rowId]/route");
  const url = `http://localhost/api/flow/queue-row/${rowId}`;
  return POST(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: { rowId: String(rowId) } }
  );
}

async function insertFailedRow(opts: {
  chunkId: string | null;
  prompt: string;
  moderationRound?: number;
  retryCount?: number;
  status?: "failed" | "dispatched" | "done" | "pending";
}): Promise<number> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO google_flow_queue (
         video_id, chunk_id, kind, mode, prompt, output_path, status,
         retry_count, moderation_round, priority, created_at, error_reason
       ) VALUES (?, ?, 'image', 'createImage', ?, 'images/c.png',
                ?, ?, ?, 0, 1, 'boom')`
    )
    .run(
      "v1",
      opts.chunkId,
      opts.prompt,
      opts.status ?? "failed",
      opts.retryCount ?? 0,
      opts.moderationRound ?? 2
    );
  return Number(info.lastInsertRowid);
}

function writeChunksJson(
  videoId: string,
  chunks: Array<{ id: string; prompt: string | null; history?: string[] }>
): void {
  const dir = join(projectsDir, videoId, "chunks");
  mkdirSync(dir, { recursive: true });
  const payload = chunks.map((c) => ({
    id: c.id,
    kind: "image",
    start: 0,
    end: 1,
    text: "",
    prompt: c.prompt,
    ...(c.history ? { prompt_history: c.history } : {}),
  }));
  writeFileSync(join(dir, "chunks.json"), JSON.stringify(payload), "utf-8");
}

describe("POST /api/flow/queue-row/[rowId]", () => {
  it("rewrites the queue row prompt, resets moderation_round to 0, requeues, and logs a manual_edit event", async () => {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    const id = await insertFailedRow({
      chunkId: "c1",
      prompt: "old prompt",
      moderationRound: 2,
    });
    writeChunksJson("v1", [{ id: "c1", prompt: "old prompt" }]);

    const res = await postEdit(id, { prompt: "brand new prompt" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      rowId: id,
      chunksJsonUpdated: true,
      resumedFailedStep: false,
    });

    const row = db
      .prepare(
        "SELECT prompt, status, moderation_round, error_reason FROM google_flow_queue WHERE id = ?"
      )
      .get(id) as {
      prompt: string;
      status: string;
      moderation_round: number;
      error_reason: string | null;
    };
    expect(row.prompt).toBe("brand new prompt");
    expect(row.status).toBe("pending");
    expect(row.moderation_round).toBe(0);
    expect(row.error_reason).toBeNull();

    const events = db
      .prepare(
        "SELECT round, original_prompt, rewritten_prompt, reason_tag FROM moderation_events WHERE video_id = 'v1'"
      )
      .all() as Array<{
      round: number;
      original_prompt: string;
      rewritten_prompt: string;
      reason_tag: string | null;
    }>;
    expect(events).toEqual([
      {
        round: 0,
        original_prompt: "old prompt",
        rewritten_prompt: "brand new prompt",
        reason_tag: "manual_edit",
      },
    ]);
  });

  it("writes the new prompt to chunks.json and appends the old prompt to prompt_history", async () => {
    const id = await insertFailedRow({
      chunkId: "c1",
      prompt: "queue prompt",
    });
    writeChunksJson("v1", [
      { id: "c1", prompt: "stale chunks prompt", history: ["very old"] },
    ]);

    const res = await postEdit(id, { prompt: "edited" });
    expect(res.status).toBe(200);

    const written = JSON.parse(
      readFileSync(join(projectsDir, "v1", "chunks", "chunks.json"), "utf-8")
    );
    expect(written[0].prompt).toBe("edited");
    expect(written[0].prompt_history).toEqual([
      "very old",
      "stale chunks prompt",
    ]);
  });

  it("when chunks.json is absent the queue row still updates and chunksJsonUpdated is false", async () => {
    const id = await insertFailedRow({
      chunkId: "c1",
      prompt: "old prompt",
    });
    // No chunks.json on disk.

    const res = await postEdit(id, { prompt: "edited" });
    const body = await res.json();
    expect(body).toMatchObject({ chunksJsonUpdated: false });

    const { getDb } = await import("@/lib/db");
    const prompt = (getDb()
      .prepare("SELECT prompt FROM google_flow_queue WHERE id = ?")
      .get(id) as { prompt: string }).prompt;
    expect(prompt).toBe("edited");
    // Even with no chunks.json, the file does not appear from nowhere.
    expect(
      existsSync(join(projectsDir, "v1", "chunks", "chunks.json"))
    ).toBe(false);
  });

  it("resumes the failed step when the video is in failed status", async () => {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    db.prepare(
      "UPDATE videos SET status = 'failed', failed_step = ?, failed_reason = ?, finished_at = ? WHERE id = 'v1'"
    ).run("generate_images", "boom", 999);
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, 'failed', ?, ?)"
    ).run("v1", "generate_images", 100, 200);
    const id = await insertFailedRow({
      chunkId: "c1",
      prompt: "old prompt",
    });

    const res = await postEdit(id, { prompt: "edited" });
    const body = await res.json();
    expect(body).toMatchObject({ resumedFailedStep: true });

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
        "SELECT status FROM video_steps WHERE video_id = 'v1' AND step_name = 'generate_images'"
      )
      .get() as { status: string };
    expect(step.status).toBe("pending");
  });

  it("rejects empty prompt with 400", async () => {
    const id = await insertFailedRow({ chunkId: "c1", prompt: "old" });
    const res = await postEdit(id, { prompt: "   " });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown row", async () => {
    const res = await postEdit(9999, { prompt: "new" });
    expect(res.status).toBe(404);
  });

  it("rejects done rows with 409", async () => {
    const id = await insertFailedRow({
      chunkId: "c1",
      prompt: "old",
      status: "done",
    });
    const res = await postEdit(id, { prompt: "new" });
    expect(res.status).toBe(409);
  });

  it("rejects rows missing chunk_id with 409 on the edit path", async () => {
    const id = await insertFailedRow({ chunkId: null, prompt: "old" });
    const res = await postEdit(id, { prompt: "new" });
    expect(res.status).toBe(409);
  });

  it("accepts dispatched rows so an operator can cancel an in-flight task and rewrite", async () => {
    const id = await insertFailedRow({
      chunkId: "c1",
      prompt: "old",
      status: "dispatched",
    });
    const res = await postEdit(id, { prompt: "new" });
    expect(res.status).toBe(200);
    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT status, prompt FROM google_flow_queue WHERE id = ?")
      .get(id) as { status: string; prompt: string };
    expect(row.status).toBe("pending");
    expect(row.prompt).toBe("new");
  });

  it("accepts pending rows so an operator can override a moderation requeue mid-flight", async () => {
    // The exact clip_01 scenario: moderation just requeued the row,
    // status is 'pending' with moderation_round 2. Pre-fix this returned
    // 409 and the operator was locked out until the next attempt failed.
    const id = await insertFailedRow({
      chunkId: "c1",
      prompt: "moderator rewrite",
      status: "pending",
      moderationRound: 2,
    });
    const res = await postEdit(id, { prompt: "operator override" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, mode: "edit" });
    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT status, prompt, moderation_round FROM google_flow_queue WHERE id = ?"
      )
      .get(id) as { status: string; prompt: string; moderation_round: number };
    expect(row.status).toBe("pending");
    expect(row.prompt).toBe("operator override");
    expect(row.moderation_round).toBe(0);
  });

  it("plain retry (no prompt) requeues a failed row in place and preserves moderation_round", async () => {
    const id = await insertFailedRow({
      chunkId: "c1",
      prompt: "current prompt",
      moderationRound: 1,
    });
    const res = await postEdit(id, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, mode: "retry" });
    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT status, prompt, moderation_round, error_reason FROM google_flow_queue WHERE id = ?"
      )
      .get(id) as {
      status: string;
      prompt: string;
      moderation_round: number;
      error_reason: string | null;
    };
    expect(row.status).toBe("pending");
    expect(row.prompt).toBe("current prompt");
    expect(row.moderation_round).toBe(1);
    // requeueTask clears error_reason via the same UPDATE on `failed`
    // rows so the next attempt isn't reported as still-failed; this
    // happens because google_operation_* are cleared on failed source.
    // Only assert the canonical fields here.
  });

  it("plain retry writes no moderation_events row", async () => {
    const id = await insertFailedRow({
      chunkId: "c1",
      prompt: "current",
      moderationRound: 1,
    });
    const res = await postEdit(id, {});
    expect(res.status).toBe(200);
    const { getDb } = await import("@/lib/db");
    const count = (getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM moderation_events WHERE video_id = 'v1'"
      )
      .get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it("plain retry on a row missing chunk_id is allowed (no audit row needed)", async () => {
    const id = await insertFailedRow({ chunkId: null, prompt: "current" });
    const res = await postEdit(id, {});
    expect(res.status).toBe(200);
  });

  it("plain retry on a failed video resumes the failed step", async () => {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    db.prepare(
      "UPDATE videos SET status = 'failed', failed_step = ?, failed_reason = ?, finished_at = ? WHERE id = 'v1'"
    ).run("generate_clips", "boom", 999);
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, 'failed', ?, ?)"
    ).run("v1", "generate_clips", 100, 200);
    const id = await insertFailedRow({
      chunkId: "c1",
      prompt: "current",
    });
    const res = await postEdit(id, {});
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, mode: "retry", resumedFailedStep: true });
    const video = db
      .prepare("SELECT status, failed_step FROM videos WHERE id = 'v1'")
      .get() as { status: string; failed_step: string | null };
    expect(video.status).toBe("queued");
    expect(video.failed_step).toBeNull();
  });
});
