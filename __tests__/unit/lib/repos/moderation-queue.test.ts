import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb } from "@/lib/db";
import * as gfRepo from "@/lib/repos/google-flow";

const openDbs: DatabaseType[] = [];
function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  openDbs.push(db);
  return db;
}
afterEach(() => {
  while (openDbs.length) {
    try {
      openDbs.pop()!.close();
    } catch {
      // already closed
    }
  }
});

function seedVideo(db: DatabaseType, id = "v_1") {
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, "V", "info", "google-flow", "in_progress", 1);
}

describe("listFailedContentPolicyForVideo", () => {
  it("returns only failed rows with content-policy error_reason for the (video, kind)", () => {
    const db = freshDb();
    seedVideo(db);

    const policyId = gfRepo.enqueueTask(db, {
      video_id: "v_1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p1",
      output_path: "images/c1.png",
      created_at: 1,
    });
    const transientId = gfRepo.enqueueTask(db, {
      video_id: "v_1",
      chunk_id: "c2",
      kind: "image",
      mode: "createImage",
      prompt: "p2",
      output_path: "images/c2.png",
      created_at: 2,
    });
    const wrongKindId = gfRepo.enqueueTask(db, {
      video_id: "v_1",
      chunk_id: "c3",
      kind: "clip",
      mode: "text",
      prompt: "p3",
      output_path: "videos/clip/c3.mp4",
      created_at: 3,
    });
    const pendingId = gfRepo.enqueueTask(db, {
      video_id: "v_1",
      chunk_id: "c4",
      kind: "image",
      mode: "createImage",
      prompt: "p4",
      output_path: "images/c4.png",
      created_at: 4,
    });

    gfRepo.failTask(db, policyId, "PUBLIC_ERROR_DANGER_FILTER");
    gfRepo.failTask(db, transientId, "UNAVAILABLE: 503");
    gfRepo.failTask(db, wrongKindId, "PUBLIC_ERROR_DANGER_FILTER");
    // pendingId stays pending

    const rows = gfRepo.listFailedContentPolicyForVideo(
      db,
      "v_1",
      "image"
    );

    expect(rows.map((r) => r.id)).toEqual([policyId]);
    expect(rows[0].error_reason).toBe("PUBLIC_ERROR_DANGER_FILTER");
  });

  it("scopes to video_id (does not bleed across videos)", () => {
    const db = freshDb();
    seedVideo(db, "v_1");
    seedVideo(db, "v_2");

    const otherVideoId = gfRepo.enqueueTask(db, {
      video_id: "v_2",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
      created_at: 1,
    });
    gfRepo.failTask(db, otherVideoId, "SAFETY");

    expect(
      gfRepo.listFailedContentPolicyForVideo(db, "v_1", "image")
    ).toEqual([]);
  });

  it("returns [] when there are no failed rows", () => {
    const db = freshDb();
    seedVideo(db);
    expect(
      gfRepo.listFailedContentPolicyForVideo(db, "v_1", "image")
    ).toEqual([]);
  });
});

describe("requeueWithNewPrompt", () => {
  it("overwrites prompt + moderation_round, flips to pending, clears dispatch fields, preserves retry_count", () => {
    const db = freshDb();
    seedVideo(db);

    const id = gfRepo.enqueueTask(db, {
      video_id: "v_1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "original",
      output_path: "images/c1.png",
      created_at: 1,
    });

    db.prepare(
      "INSERT INTO google_flow_accounts (id, name, token, created_at) VALUES (?, ?, ?, ?)"
    ).run("acc_01", "A", "tok", 1);
    // simulate a dispatch + failure with retry_count populated
    db.prepare(
      `UPDATE google_flow_queue
          SET status = 'failed',
              error_reason = 'PUBLIC_ERROR_DANGER_FILTER',
              assigned_account_id = 'acc_01',
              external_task_id = 'ext_42',
              dispatched_at = 100,
              retry_count = 2
        WHERE id = ?`
    ).run(id);

    gfRepo.requeueWithNewPrompt(db, id, "rewritten prompt", 1);

    const row = gfRepo.findTaskById(db, id)!;
    expect(row).toMatchObject({
      status: "pending",
      prompt: "rewritten prompt",
      moderation_round: 1,
      error_reason: null,
      assigned_account_id: null,
      dispatched_at: null,
      external_task_id: null,
      retry_count: 2,
    });
  });

  it("can be called repeatedly to bump moderation_round", () => {
    const db = freshDb();
    seedVideo(db);
    const id = gfRepo.enqueueTask(db, {
      video_id: "v_1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "original",
      output_path: "images/c1.png",
      created_at: 1,
    });

    gfRepo.requeueWithNewPrompt(db, id, "round1", 1);
    expect(gfRepo.findTaskById(db, id)!.moderation_round).toBe(1);
    expect(gfRepo.findTaskById(db, id)!.prompt).toBe("round1");

    gfRepo.failTask(db, id, "SAFETY");
    gfRepo.requeueWithNewPrompt(db, id, "round2", 2);
    expect(gfRepo.findTaskById(db, id)!.moderation_round).toBe(2);
    expect(gfRepo.findTaskById(db, id)!.prompt).toBe("round2");
    expect(gfRepo.findTaskById(db, id)!.error_reason).toBeNull();
  });
});

describe("findRevivableFailedTaskForChunk", () => {
  it("returns a moderation-eligible failed row so re-entry treats it as in-flight", () => {
    const db = freshDb();
    seedVideo(db);
    const id = gfRepo.enqueueTask(db, {
      video_id: "v_1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
      created_at: 1,
    });
    gfRepo.failTask(db, id, "PUBLIC_ERROR_DANGER_FILTER");

    const row = gfRepo.findRevivableFailedTaskForChunk(
      db,
      "v_1",
      "image",
      "c1"
    );
    expect(row?.id).toBe(id);
  });

  it("returns the row for Veo's generic MEDIA_GENERATION_STATUS_FAILED — the hook_14 path", () => {
    const db = freshDb();
    seedVideo(db);
    const id = gfRepo.enqueueTask(db, {
      video_id: "v_1",
      chunk_id: "c1",
      kind: "clip",
      mode: "text",
      prompt: "p",
      output_path: "videos/clip/c1.mp4",
      created_at: 1,
    });
    gfRepo.failTask(
      db,
      id,
      'Video generation failed: MEDIA_GENERATION_STATUS_FAILED: {"code":13,"message":"INTERNAL"}'
    );

    const row = gfRepo.findRevivableFailedTaskForChunk(
      db,
      "v_1",
      "clip",
      "c1"
    );
    expect(row?.id).toBe(id);
  });

  it("returns undefined for non-moderation-eligible failures so retry can enqueue a fresh row", () => {
    const db = freshDb();
    seedVideo(db);
    const id = gfRepo.enqueueTask(db, {
      video_id: "v_1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
      created_at: 1,
    });
    gfRepo.failTask(db, id, "Video generation timed out after 10 minutes");

    expect(
      gfRepo.findRevivableFailedTaskForChunk(
        db,
        "v_1",
        "image",
        "c1"
      )
    ).toBeUndefined();
  });

  it("returns undefined when no failed row exists", () => {
    const db = freshDb();
    seedVideo(db);
    expect(
      gfRepo.findRevivableFailedTaskForChunk(
        db,
        "v_1",
        "image",
        "c1"
      )
    ).toBeUndefined();
  });

  it("finds a revivable row even when an earlier non-revivable failed row exists for the same chunk", () => {
    // A chunk can accumulate multiple failed rows: a timeout-exhausted
    // row from the initial attempt plus a content-policy row from a
    // retry. The moderator picks the second one up via
    // listFailedContentPolicyForVideo (which scans every failed row),
    // so this helper must mirror that — picking only the lowest-id
    // failed row would miss the revivable one and the step would
    // enqueue a third parallel row.
    const db = freshDb();
    seedVideo(db);
    const oldId = gfRepo.enqueueTask(db, {
      video_id: "v_1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p1",
      output_path: "images/c1.png",
      created_at: 1,
    });
    const newId = gfRepo.enqueueTask(db, {
      video_id: "v_1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p2",
      output_path: "images/c1.png",
      created_at: 2,
    });
    gfRepo.failTask(db, oldId, "Video generation timed out after 10 minutes");
    gfRepo.failTask(db, newId, "PUBLIC_ERROR_DANGER_FILTER");

    const row = gfRepo.findRevivableFailedTaskForChunk(
      db,
      "v_1",
      "image",
      "c1"
    );
    expect(row?.id).toBe(newId);
  });
});
