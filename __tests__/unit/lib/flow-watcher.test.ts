import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb } from "@/lib/db";
import * as gfRepo from "@/lib/repos/google-flow";
import * as magnificRepo from "@/lib/repos/magnific";
import { runReaperTick } from "@/lib/flow-watcher";

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

function seedAccount(
  db: DatabaseType,
  id: string,
  opts: { lastSeenAt?: number | null; enabled?: boolean } = {}
) {
  gfRepo.insertAccount(db, { id, name: id, token: `tok_${id}`, created_at: 1 });
  if (opts.lastSeenAt !== undefined && opts.lastSeenAt !== null) {
    gfRepo.updateAccountLastSeen(db, id, opts.lastSeenAt);
  }
  if (opts.enabled === false) {
    gfRepo.setAccountEnabled(db, id, false);
  }
}

function enqueueAndDispatch(
  db: DatabaseType,
  opts: {
    videoId?: string;
    chunkId: string;
    accountId: string;
    dispatchedAt: number;
  }
): number {
  const videoId = opts.videoId ?? "v_1";
  const id = gfRepo.enqueueTask(db, {
    video_id: videoId,
    chunk_id: opts.chunkId,
    kind: "image",
    mode: "createImage",
    prompt: "p",
    output_path: `images/${opts.chunkId}.png`,
    priority: 0,
    created_at: 1,
  });
  gfRepo.takeNextTaskForAccount(db, opts.accountId, opts.dispatchedAt);
  return id;
}

describe("runReaperTick — stale/disabled account requeue", () => {
  it("requeues a dispatched row when its account's last_seen_at is older than staleAccountTimeoutMinutes", () => {
    const db = freshDb();
    seedVideo(db);
    // last_seen_at = now - 15min, but staleAccountTimeoutMinutes = 10 → stale.
    const now = 2_000_000;
    const lastSeen = now - 15 * 60;
    seedAccount(db, "acc_01", { lastSeenAt: lastSeen });
    const taskId = enqueueAndDispatch(db, {
      chunkId: "c1",
      accountId: "acc_01",
      dispatchedAt: now - 60,
    });

    runReaperTick(db, {
      now: () => now,
      staleAccountTimeoutMinutes: 10,
      dispatchTimeoutMinutes: 30,
    });

    const row = gfRepo.findTaskById(db, taskId)!;
    expect(row.status).toBe("pending");
    expect(row.assigned_account_id).toBeNull();
    expect(row.external_task_id).toBeNull();
  });

  it("leaves a dispatched row alone when its account's last_seen_at is fresh", () => {
    const db = freshDb();
    seedVideo(db);
    const now = 2_000_000;
    seedAccount(db, "acc_01", { lastSeenAt: now - 60 }); // 1 min ago — fresh.
    const taskId = enqueueAndDispatch(db, {
      chunkId: "c1",
      accountId: "acc_01",
      dispatchedAt: now - 30,
    });

    runReaperTick(db, {
      now: () => now,
      staleAccountTimeoutMinutes: 10,
      dispatchTimeoutMinutes: 30,
    });

    const row = gfRepo.findTaskById(db, taskId)!;
    expect(row.status).toBe("dispatched");
    expect(row.assigned_account_id).toBe("acc_01");
  });

  it("requeues a dispatched row when its account is disabled", () => {
    const db = freshDb();
    seedVideo(db);
    const now = 2_000_000;
    seedAccount(db, "acc_01", { lastSeenAt: now - 60, enabled: false });
    const taskId = enqueueAndDispatch(db, {
      chunkId: "c1",
      accountId: "acc_01",
      dispatchedAt: now - 30,
    });

    runReaperTick(db, {
      now: () => now,
      staleAccountTimeoutMinutes: 10,
      dispatchTimeoutMinutes: 30,
    });

    expect(gfRepo.findTaskById(db, taskId)!.status).toBe("pending");
  });
});

describe("runReaperTick — per-dispatch age timeout", () => {
  it("requeues a dispatched row older than dispatchTimeoutMinutes even when the account is healthy", () => {
    // The scenario this covers: account is polling happily (fresh
    // last_seen_at) but the specific dispatch never resolves — Flow
    // backend dropped the job or the extension got stuck internally.
    const db = freshDb();
    seedVideo(db);
    const now = 2_000_000;
    seedAccount(db, "acc_01", { lastSeenAt: now - 30 }); // fresh
    const taskId = enqueueAndDispatch(db, {
      chunkId: "c1",
      accountId: "acc_01",
      dispatchedAt: now - 35 * 60, // 35 min old
    });

    runReaperTick(db, {
      now: () => now,
      staleAccountTimeoutMinutes: 10,
      dispatchTimeoutMinutes: 30,
    });

    const row = gfRepo.findTaskById(db, taskId)!;
    expect(row.status).toBe("pending");
    expect(row.external_task_id).toBeNull();
  });

  it("leaves a fresh dispatched row alone under a fresh account", () => {
    const db = freshDb();
    seedVideo(db);
    const now = 2_000_000;
    seedAccount(db, "acc_01", { lastSeenAt: now - 30 });
    const taskId = enqueueAndDispatch(db, {
      chunkId: "c1",
      accountId: "acc_01",
      dispatchedAt: now - 60, // 1 min old
    });

    runReaperTick(db, {
      now: () => now,
      staleAccountTimeoutMinutes: 10,
      dispatchTimeoutMinutes: 30,
    });

    expect(gfRepo.findTaskById(db, taskId)!.status).toBe("dispatched");
  });
});

describe("runReaperTick — magnific dispatch-age timeout", () => {
  // ADR-0012 §Decision 4: the dispatch-age pass scans magnific_queue
  // alongside google_flow_queue but skips rows flagged no_timeout=1
  // (operator-blocking image-hitl tasks). Image-to-video rows ride
  // the same age-requeue path as Flow.
  function enqueueAndDispatchMagnific(
    db: DatabaseType,
    opts: {
      videoId?: string;
      mode: "image-hitl" | "image-to-video";
      noTimeout: 0 | 1;
      dispatchedAt: number;
    }
  ): number {
    const videoId = opts.videoId ?? "v_1";
    const id = magnificRepo.enqueueTask(db, {
      video_id: videoId,
      mode: opts.mode,
      prompt: "p",
      output_path: `${opts.mode}.out`,
      no_timeout: opts.noTimeout,
      created_at: 1,
    });
    db.prepare(
      `UPDATE magnific_queue
          SET status = 'dispatched',
              dispatched_at = ?,
              external_task_id = ?
        WHERE id = ?`
    ).run(opts.dispatchedAt, `${id}_${opts.dispatchedAt}`, id);
    return id;
  }

  it("requeues a stale dispatched magnific row when no_timeout=0", () => {
    const db = freshDb();
    seedVideo(db);
    const now = 2_000_000;
    const id = enqueueAndDispatchMagnific(db, {
      mode: "image-to-video",
      noTimeout: 0,
      dispatchedAt: now - 35 * 60, // 35 min old, > 30 min cap
    });

    runReaperTick(db, {
      now: () => now,
      staleAccountTimeoutMinutes: 10,
      dispatchTimeoutMinutes: 30,
      magnificDispatchTimeoutMinutes: 30,
    });

    const row = magnificRepo.findTaskById(db, id)!;
    expect(row.status).toBe("pending");
    expect(row.external_task_id).toBeNull();
    expect(row.dispatched_at).toBeNull();
  });

  it("leaves a stale dispatched magnific row alone when no_timeout=1", () => {
    // The HITL exemption — operator selection can legitimately take days,
    // so the reaper must not requeue these rows out from under the
    // operator's choice in the magnific tab.
    const db = freshDb();
    seedVideo(db);
    const now = 2_000_000;
    const id = enqueueAndDispatchMagnific(db, {
      mode: "image-hitl",
      noTimeout: 1,
      dispatchedAt: now - 35 * 60, // also stale by age
    });

    runReaperTick(db, {
      now: () => now,
      staleAccountTimeoutMinutes: 10,
      dispatchTimeoutMinutes: 30,
      magnificDispatchTimeoutMinutes: 30,
    });

    const row = magnificRepo.findTaskById(db, id)!;
    expect(row.status).toBe("dispatched");
    expect(row.external_task_id).toBe(`${id}_${now - 35 * 60}`);
  });

  it("leaves a fresh dispatched magnific row alone when no_timeout=0", () => {
    const db = freshDb();
    seedVideo(db);
    const now = 2_000_000;
    const id = enqueueAndDispatchMagnific(db, {
      mode: "image-to-video",
      noTimeout: 0,
      dispatchedAt: now - 60, // 1 min old — fresh
    });

    runReaperTick(db, {
      now: () => now,
      staleAccountTimeoutMinutes: 10,
      dispatchTimeoutMinutes: 30,
      magnificDispatchTimeoutMinutes: 30,
    });

    expect(magnificRepo.findTaskById(db, id)!.status).toBe("dispatched");
  });
});

describe("runReaperTick — wake deferred videos", () => {
  function setDeferredUntil(db: DatabaseType, videoId: string, at: number) {
    db.prepare("UPDATE videos SET deferred_until = ? WHERE id = ?").run(
      at,
      videoId
    );
  }

  function enqueuePending(db: DatabaseType, videoId: string, chunkId: string) {
    gfRepo.enqueueTask(db, {
      video_id: videoId,
      chunk_id: chunkId,
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: `images/${chunkId}.png`,
      priority: 0,
      created_at: 1,
    });
  }

  it("clears deferred_until on a video with pending rows when an account is available", () => {
    const db = freshDb();
    seedVideo(db, "v_deferred");
    enqueuePending(db, "v_deferred", "c1");
    const now = 2_000_000;
    setDeferredUntil(db, "v_deferred", now + 3600); // 1h in future
    seedAccount(db, "acc_01"); // enabled, unpaused

    runReaperTick(db, {
      now: () => now,
      staleAccountTimeoutMinutes: 10,
      dispatchTimeoutMinutes: 30,
    });

    const row = db
      .prepare("SELECT deferred_until FROM videos WHERE id = ?")
      .get("v_deferred") as { deferred_until: number | null };
    expect(row.deferred_until).toBeNull();
  });

  it("leaves deferred_until alone when no accounts are available", () => {
    const db = freshDb();
    seedVideo(db, "v_deferred");
    enqueuePending(db, "v_deferred", "c1");
    const now = 2_000_000;
    setDeferredUntil(db, "v_deferred", now + 3600);
    seedAccount(db, "acc_01");
    gfRepo.pauseAccount(db, "acc_01", now + 1800); // paused until later

    runReaperTick(db, {
      now: () => now,
      staleAccountTimeoutMinutes: 10,
      dispatchTimeoutMinutes: 30,
    });

    const row = db
      .prepare("SELECT deferred_until FROM videos WHERE id = ?")
      .get("v_deferred") as { deferred_until: number | null };
    expect(row.deferred_until).toBe(now + 3600);
  });

  it("leaves deferred_until alone when the video has no pending queue rows", () => {
    // A video whose Flow step finished (all rows done/failed) shouldn't
    // have its defer state touched — leave it for the orchestrator to
    // advance naturally.
    const db = freshDb();
    seedVideo(db, "v_done");
    const now = 2_000_000;
    setDeferredUntil(db, "v_done", now + 3600);
    seedAccount(db, "acc_01");

    const id = gfRepo.enqueueTask(db, {
      video_id: "v_done",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
      priority: 0,
      created_at: 1,
    });
    gfRepo.completeTask(db, id, "https://example/r.png", 1);

    runReaperTick(db, {
      now: () => now,
      staleAccountTimeoutMinutes: 10,
      dispatchTimeoutMinutes: 30,
    });

    const row = db
      .prepare("SELECT deferred_until FROM videos WHERE id = ?")
      .get("v_done") as { deferred_until: number | null };
    expect(row.deferred_until).toBe(now + 3600);
  });
});
