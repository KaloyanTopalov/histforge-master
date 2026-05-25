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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-flow-queue-summary-"));
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
  const { getDb, seedDefaultSettings } = await import("@/lib/db");
  const db = getDb();
  db.exec(
    "DELETE FROM google_flow_queue; DELETE FROM google_flow_accounts; DELETE FROM videos; DELETE FROM settings;"
  );
  seedDefaultSettings(db);
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("v1", "Test", "info", "google-flow", "in_progress", 1);
});

async function getSummary(videoId: string): Promise<Response> {
  const { GET } = await import(
    "@/app/api/flow/queue-summary/[videoId]/route"
  );
  return GET(
    new Request(`http://localhost/api/flow/queue-summary/${videoId}`),
    { params: { videoId } }
  );
}

async function insertRow(
  status: "pending" | "dispatched" | "done" | "failed",
  kind: "image" | "clip",
  overrides: {
    chunk_id?: string;
    error_reason?: string;
    retry_count?: number;
    moderation_round?: number;
  } = {}
): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  db.prepare(
    `INSERT INTO google_flow_queue (
       video_id, chunk_id, kind, mode, prompt, output_path, status,
       retry_count, moderation_round, priority, created_at, error_reason
     ) VALUES (?, ?, ?, 'createImage', 'prompt', ?, ?, ?, ?, 0, 1, ?)`
  ).run(
    "v1",
    overrides.chunk_id ?? null,
    kind,
    `images/${overrides.chunk_id ?? "x"}.png`,
    status,
    overrides.retry_count ?? 0,
    overrides.moderation_round ?? 0,
    overrides.error_reason ?? null
  );
}

describe("GET /api/flow/queue-summary/[videoId]", () => {
  it("returns zeroed counts and an empty needs_review list for a video with no queue rows", async () => {
    const res = await getSummary("v1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.image).toEqual({
      pending: 0,
      dispatched: 0,
      done: 0,
      failed: 0,
    });
    expect(body.clip).toEqual({
      pending: 0,
      dispatched: 0,
      done: 0,
      failed: 0,
    });
    expect(body.needs_review).toEqual([]);
  });

  it("returns status counts broken down by kind", async () => {
    await insertRow("pending", "image", { chunk_id: "c1" });
    await insertRow("done", "image", { chunk_id: "c2" });
    await insertRow("done", "image", { chunk_id: "c3" });
    await insertRow("failed", "image", {
      chunk_id: "c4",
      error_reason: "SAFETY: prompt blocked",
    });
    await insertRow("dispatched", "clip", { chunk_id: "h1" });
    await insertRow("done", "clip", { chunk_id: "h2" });

    const res = await getSummary("v1");
    const body = await res.json();
    expect(body.image).toEqual({
      pending: 1,
      dispatched: 0,
      done: 2,
      failed: 1,
    });
    expect(body.clip).toEqual({
      pending: 0,
      dispatched: 1,
      done: 1,
      failed: 0,
    });
  });

  it("includes failed rows with chunk_id + error_reason + retry_count + status", async () => {
    await insertRow("failed", "image", {
      chunk_id: "c4",
      error_reason: "SAFETY",
      retry_count: 2,
    });
    await insertRow("failed", "clip", {
      chunk_id: "h7",
      error_reason: "429 RESOURCE_EXHAUSTED",
      retry_count: 3,
    });

    const res = await getSummary("v1");
    const body = await res.json();
    expect(body.needs_review).toHaveLength(2);
    const byChunk = Object.fromEntries(
      (body.needs_review as Array<Record<string, unknown>>).map((r) => [
        r.chunk_id,
        r,
      ])
    );
    expect(byChunk.c4).toMatchObject({
      kind: "image",
      status: "failed",
      error_reason: "SAFETY",
      retry_count: 2,
    });
    expect(byChunk.h7).toMatchObject({
      kind: "clip",
      status: "failed",
      error_reason: "429 RESOURCE_EXHAUSTED",
      retry_count: 3,
    });
  });

  it("surfaces non-done rows that moderation has already rewritten so the operator can take over an in-flight retry", async () => {
    // clip_01 scenario: moderation round 2 requeued the row → status
    // 'pending' with moderation_round = 2. Pre-fix this row was hidden
    // entirely until the next attempt also failed, leaving the operator
    // unable to intervene.
    await insertRow("pending", "clip", {
      chunk_id: "clip_01",
      moderation_round: 2,
    });
    // A dispatched row that's been rewritten — same idea, mid-flight.
    await insertRow("dispatched", "image", {
      chunk_id: "c5",
      moderation_round: 1,
    });
    // A plain pending row (moderation_round = 0) is NOT in the review
    // set — nothing to take over yet.
    await insertRow("pending", "image", { chunk_id: "fresh" });
    // A done row even with moderation_round > 0 is filtered out — work
    // is finished.
    await insertRow("done", "clip", {
      chunk_id: "settled",
      moderation_round: 1,
    });

    const res = await getSummary("v1");
    const body = (await res.json()) as {
      needs_review: Array<{
        chunk_id: string;
        status: string;
        moderation_round: number;
      }>;
    };
    const byChunk = Object.fromEntries(
      body.needs_review.map((r) => [r.chunk_id, r])
    );
    expect(byChunk.clip_01).toMatchObject({
      status: "pending",
      moderation_round: 2,
    });
    expect(byChunk.c5).toMatchObject({
      status: "dispatched",
      moderation_round: 1,
    });
    expect(byChunk).not.toHaveProperty("fresh");
    expect(byChunk).not.toHaveProperty("settled");
  });

  it("returns 404 for an unknown video", async () => {
    const res = await getSummary("does-not-exist");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/flow/queue-summary/[videoId] — moderation block", () => {
  async function insertModRow(args: {
    chunk_id: string;
    kind: "image" | "clip";
    status: "pending" | "dispatched" | "done" | "failed";
    moderation_round?: number;
    error_reason?: string;
  }): Promise<void> {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    db.prepare(
      `INSERT INTO google_flow_queue (
         video_id, chunk_id, kind, mode, prompt, output_path, status,
         retry_count, moderation_round, priority, created_at, error_reason
       ) VALUES ('v1', ?, ?, 'createImage', 'p', ?, ?, 0, ?, 0, 1, ?)`
    ).run(
      args.chunk_id,
      args.kind,
      `images/${args.chunk_id}.png`,
      args.status,
      args.moderation_round ?? 0,
      args.error_reason ?? null
    );
  }

  async function insertEvent(args: {
    chunk_id: string;
    kind: "image" | "clip";
    round: number;
    created_at: number;
    reason_tag?: string | null;
  }): Promise<void> {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    db.prepare(
      `INSERT INTO moderation_events (
         video_id, chunk_id, kind, round,
         original_prompt, rewritten_prompt, reason_tag, created_at
       ) VALUES ('v1', ?, ?, ?, 'orig', 'new', ?, ?)`
    ).run(
      args.chunk_id,
      args.kind,
      args.round,
      args.reason_tag ?? null,
      args.created_at
    );
  }

  it("includes a moderation block with zero/null defaults when there's nothing moderated", async () => {
    const res = await getSummary("v1");
    const body = await res.json();
    expect(body.moderation).toMatchObject({
      last_event_at: null,
      image: { round: 0, pending: 0 },
      clip: { round: 0, pending: 0 },
      events: [],
    });
    // max_rounds reflects the current setting (default seeds to 2).
    expect(body.moderation.max_rounds).toBe(2);
  });

  it("per-kind round = max moderation_round on that kind's non-done rows", async () => {
    // image: a `done` row at round 9 (excluded), an open row at 1.
    await insertModRow({
      chunk_id: "c1",
      kind: "image",
      status: "done",
      moderation_round: 9,
    });
    await insertModRow({
      chunk_id: "c2",
      kind: "image",
      status: "pending",
      moderation_round: 1,
    });
    // clip: a failed row at round 2.
    await insertModRow({
      chunk_id: "c3",
      kind: "clip",
      status: "failed",
      moderation_round: 2,
      error_reason: "PUBLIC_ERROR_DANGER_FILTER",
    });
    const body = await (await getSummary("v1")).json();
    // No video-wide leak: each kind reports only its own max round.
    expect(body.moderation.image.round).toBe(1);
    expect(body.moderation.clip.round).toBe(2);
  });

  it("per-kind pending counts failed content-policy rows whose moderation_round < max_rounds", async () => {
    // max_rounds = 2 by default.
    await insertModRow({
      chunk_id: "m1",
      kind: "image",
      status: "failed",
      moderation_round: 0,
      error_reason: "PUBLIC_ERROR_DANGER_FILTER",
    });
    await insertModRow({
      chunk_id: "m2",
      kind: "image",
      status: "failed",
      moderation_round: 2, // already at the cap → not pending
      error_reason: "SAFETY",
    });
    await insertModRow({
      chunk_id: "m3",
      kind: "image",
      status: "failed",
      moderation_round: 0,
      error_reason: "UNAVAILABLE 503", // not a content-policy reason
    });
    await insertModRow({
      chunk_id: "h1",
      kind: "clip",
      status: "failed",
      moderation_round: 1,
      error_reason: "CHILD_DANGER",
    });
    const body = await (await getSummary("v1")).json();
    expect(body.moderation.image.pending).toBe(1);
    expect(body.moderation.clip.pending).toBe(1);
  });

  it("events are returned oldest-first and last_event_at is the latest timestamp", async () => {
    await insertEvent({
      chunk_id: "c1",
      kind: "image",
      round: 1,
      created_at: 100,
      reason_tag: "SAFETY",
    });
    await insertEvent({
      chunk_id: "c2",
      kind: "image",
      round: 1,
      created_at: 200,
      reason_tag: "CHILD_DANGER",
    });
    await insertEvent({
      chunk_id: "c1",
      kind: "image",
      round: 2,
      created_at: 300,
      reason_tag: "SAFETY",
    });
    const body = await (await getSummary("v1")).json();
    expect(body.moderation.last_event_at).toBe(300);
    expect(body.moderation.events).toHaveLength(3);
    expect(
      (body.moderation.events as Array<{ created_at: number }>).map(
        (e) => e.created_at
      )
    ).toEqual([100, 200, 300]);
  });
});
