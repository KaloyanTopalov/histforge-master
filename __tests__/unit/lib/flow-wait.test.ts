import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb, seedDefaultSettings } from "@/lib/db";
import { waitForFlowQueue } from "@/lib/flow-wait";
import * as gfRepo from "@/lib/repos/google-flow";
import * as videosRepo from "@/lib/repos/videos";
import { setSetting } from "@/lib/settings";

const openDbs: DatabaseType[] = [];
function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
  openDbs.push(db);
  return db;
}
afterEach(() => {
  while (openDbs.length) {
    try { openDbs.pop()!.close(); } catch { /* ignore */ }
  }
});

function insertVideo(db: DatabaseType, id: string): void {
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, "T", "info", "google-flow", "in_progress", 1);
}

function insertAccount(
  db: DatabaseType,
  id: string,
  opts: { enabled?: 0 | 1; paused_until?: number | null } = {}
): void {
  db.prepare(
    "INSERT INTO google_flow_accounts (id, name, token, enabled, paused_until, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    id,
    `tok_${id}`,
    opts.enabled ?? 1,
    opts.paused_until ?? null,
    1
  );
}

describe("waitForFlowQueue", () => {
  it("returns {ok: true} when every queued row is done or failed", async () => {
    const db = freshDb();
    insertVideo(db, "v1");
    gfRepo.enqueueTask(db, {
      video_id: "v1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
      created_at: 1,
    });
    gfRepo.enqueueTask(db, {
      video_id: "v1",
      chunk_id: "c2",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c2.png",
      created_at: 1,
    });
    // Mark both as done directly (bypassing dispatch flow).
    db.prepare("UPDATE google_flow_queue SET status = 'done'").run();

    const result = await waitForFlowQueue("v1", "image", {
      db,
      pollIntervalMs: 1,
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns stalled with retryAfter from firstAccountPausedUntil when every row is pending and no account is available", async () => {
    const db = freshDb();
    insertVideo(db, "v1");
    const pausedUntil = 2_000_000;
    insertAccount(db, "acc_01", { paused_until: pausedUntil });
    gfRepo.enqueueTask(db, {
      video_id: "v1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
      created_at: 1,
    });

    const result = await waitForFlowQueue("v1", "image", {
      db,
      pollIntervalMs: 1,
    });
    expect(result).toEqual({
      ok: false,
      reason: "stalled",
      retryAfter: pausedUntil,
    });
  });

  it("keeps polling (no stall) while at least one row is still dispatched", async () => {
    const db = freshDb();
    insertVideo(db, "v1");
    // No account available, but a row is dispatched — not stalled yet.
    const id = gfRepo.enqueueTask(db, {
      video_id: "v1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
      created_at: 1,
    });
    db.prepare("UPDATE google_flow_queue SET status = 'dispatched' WHERE id = ?").run(id);

    // After a few polls, flip the row to done — the helper must not stall
    // in the meantime.
    let polls = 0;
    const result = await waitForFlowQueue("v1", "image", {
      db,
      pollIntervalMs: 1,
      onTick: () => {
        polls++;
        if (polls === 2) {
          db.prepare("UPDATE google_flow_queue SET status = 'done' WHERE id = ?").run(id);
        }
      },
    });
    expect(result).toEqual({ ok: true });
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it("falls back to now + 1800 when firstAccountPausedUntil is null", async () => {
    const db = freshDb();
    insertVideo(db, "v1");
    // No accounts at all → firstAccountPausedUntil returns null.
    gfRepo.enqueueTask(db, {
      video_id: "v1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
      created_at: 1,
    });

    const fakeNow = 1_000_000;
    const result = await waitForFlowQueue("v1", "image", {
      db,
      pollIntervalMs: 1,
      nowSec: () => fakeNow,
    });
    expect(result).toEqual({
      ok: false,
      reason: "stalled",
      retryAfter: fakeNow + 1800,
    });
  });

  it("returns paused with retryAfter=now when queue_state='paused' globally", async () => {
    const db = freshDb();
    insertVideo(db, "v1");
    insertAccount(db, "acc_01");
    // A dispatched row would normally keep us polling; here we exit
    // early because the queue is globally paused.
    const id = gfRepo.enqueueTask(db, {
      video_id: "v1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
      created_at: 1,
    });
    db.prepare("UPDATE google_flow_queue SET status = 'dispatched' WHERE id = ?").run(id);
    setSetting("queue_state", "paused", db);

    const fakeNow = 1_234_567;
    const result = await waitForFlowQueue("v1", "image", {
      db,
      pollIntervalMs: 1,
      nowSec: () => fakeNow,
    });
    expect(result).toEqual({
      ok: false,
      reason: "paused",
      retryAfter: fakeNow,
    });
  });

  it("returns paused when the specific video is paused, even with an available account", async () => {
    const db = freshDb();
    insertVideo(db, "v1");
    insertAccount(db, "acc_01");
    gfRepo.enqueueTask(db, {
      video_id: "v1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
      created_at: 1,
    });
    videosRepo.setPaused(db, "v1");

    const fakeNow = 2_222_222;
    const result = await waitForFlowQueue("v1", "image", {
      db,
      pollIntervalMs: 1,
      nowSec: () => fakeNow,
    });
    expect(result).toEqual({
      ok: false,
      reason: "paused",
      retryAfter: fakeNow,
    });
  });

  it("pause takes priority over stalled when both are true", async () => {
    // Without pause, this would return {reason: "stalled"} because no
    // account is available. With pause, we yield for pause — that's
    // the clearer signal to the orchestrator.
    const db = freshDb();
    insertVideo(db, "v1");
    // Account is paused → nothing available.
    insertAccount(db, "acc_01", { paused_until: 9_999_999 });
    gfRepo.enqueueTask(db, {
      video_id: "v1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
      created_at: 1,
    });
    videosRepo.setPaused(db, "v1");

    const fakeNow = 3_000_000;
    const result = await waitForFlowQueue("v1", "image", {
      db,
      pollIntervalMs: 1,
      nowSec: () => fakeNow,
    });
    expect(result).toEqual({
      ok: false,
      reason: "paused",
      retryAfter: fakeNow,
    });
  });

  it("returns ok:true even when paused, if the queue has already drained", async () => {
    // Drain wins: if every row is done/failed the step has nothing to
    // do, so we shouldn't force it back through a defer cycle on the
    // next tick. The orchestrator's between-step pause check will
    // catch the pause after the step completes.
    const db = freshDb();
    insertVideo(db, "v1");
    const id = gfRepo.enqueueTask(db, {
      video_id: "v1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
      created_at: 1,
    });
    db.prepare("UPDATE google_flow_queue SET status = 'done' WHERE id = ?").run(id);
    videosRepo.setPaused(db, "v1");

    const result = await waitForFlowQueue("v1", "image", {
      db,
      pollIntervalMs: 1,
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns deleted with retryAfter=now when delete_requested=1", async () => {
    // The orchestrator's between-step delete hook only fires when
    // runPipeline iterates to the next step. While a Google Flow step is
    // sitting inside waitForFlowQueue the runner is blocked on `await
    // runPipeline`, so the wait function itself must yield on
    // delete_requested. Without this the user sees a stuck "Deleting…"
    // until the queue drains or every account hits cooldown.
    const db = freshDb();
    insertVideo(db, "v1");
    insertAccount(db, "acc_01");
    const id = gfRepo.enqueueTask(db, {
      video_id: "v1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
      created_at: 1,
    });
    db.prepare("UPDATE google_flow_queue SET status = 'dispatched' WHERE id = ?").run(id);
    videosRepo.setDeleteRequested(db, "v1");

    const fakeNow = 4_242_424;
    const result = await waitForFlowQueue("v1", "image", {
      db,
      pollIntervalMs: 1,
      nowSec: () => fakeNow,
    });
    expect(result).toEqual({
      ok: false,
      reason: "deleted",
      retryAfter: fakeNow,
    });
  });

  it("delete_requested takes priority over pause", async () => {
    // Both pause and delete are set; we must yield as "deleted" so the
    // runner's findDeleteRequestedId short-circuit fires next tick. A
    // "paused" yield would also work in practice (delete short-circuits
    // ahead of pause anyway) but the signal should match the cause.
    const db = freshDb();
    insertVideo(db, "v1");
    insertAccount(db, "acc_01");
    const id = gfRepo.enqueueTask(db, {
      video_id: "v1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
      created_at: 1,
    });
    db.prepare("UPDATE google_flow_queue SET status = 'dispatched' WHERE id = ?").run(id);
    videosRepo.setPaused(db, "v1");
    videosRepo.setDeleteRequested(db, "v1");

    const fakeNow = 5_555_555;
    const result = await waitForFlowQueue("v1", "image", {
      db,
      pollIntervalMs: 1,
      nowSec: () => fakeNow,
    });
    expect(result).toEqual({
      ok: false,
      reason: "deleted",
      retryAfter: fakeNow,
    });
  });

  it("returns ok:true when queue has drained even if delete_requested is set", async () => {
    // Mirrors the existing pause/drain-wins test: if there's nothing left
    // to wait on, return ok:true so the step completes normally. The
    // orchestrator's between-step delete hook will fire on the next
    // for-loop iteration before any subsequent step runs.
    const db = freshDb();
    insertVideo(db, "v1");
    const id = gfRepo.enqueueTask(db, {
      video_id: "v1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
      created_at: 1,
    });
    db.prepare("UPDATE google_flow_queue SET status = 'done' WHERE id = ?").run(id);
    videosRepo.setDeleteRequested(db, "v1");

    const result = await waitForFlowQueue("v1", "image", {
      db,
      pollIntervalMs: 1,
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns timeout after the 24h wall-clock cap", async () => {
    const db = freshDb();
    insertVideo(db, "v1");
    // Available account + dispatched row → not stalled, just never finishes.
    insertAccount(db, "acc_01");
    const id = gfRepo.enqueueTask(db, {
      video_id: "v1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
      created_at: 1,
    });
    db.prepare("UPDATE google_flow_queue SET status = 'dispatched' WHERE id = ?").run(id);

    // Advance the clock past the 24h cap on the second tick.
    let tick = 0;
    const start = 10_000;
    const result = await waitForFlowQueue("v1", "image", {
      db,
      pollIntervalMs: 1,
      timeoutMs: 24 * 3600 * 1000,
      nowMs: () => (tick++ === 0 ? start : start + 24 * 3600 * 1000 + 1),
    });
    expect(result).toEqual({ ok: false, reason: "timeout" });
  });
});
