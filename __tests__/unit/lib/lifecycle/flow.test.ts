import { describe, it, expect, afterEach, vi } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb, seedDefaultSettings } from "@/lib/db";
import * as flowLifecycle from "@/lib/lifecycle/flow";
import * as gfRepo from "@/lib/repos/google-flow";
import * as videosRepo from "@/lib/repos/videos";
import { setSetting } from "@/lib/settings";
import { FlowBannerKeys } from "@/lib/lifecycle/flow-banner-keys";
import type {
  GoogleFlowAccount,
  GoogleFlowQueueItem,
  GoogleFlowVideoProject,
} from "@/types";

function readSettingRaw(db: DatabaseType, key: string): string | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

const openDbs: DatabaseType[] = [];
function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
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

function seedAccount(
  db: DatabaseType,
  overrides: { id?: string; token?: string; paused_until?: number | null } = {}
): string {
  const id = overrides.id ?? "acc1";
  gfRepo.insertAccount(db, {
    id,
    name: "a",
    token: overrides.token ?? "tok",
    created_at: 100,
  });
  if (overrides.paused_until !== undefined && overrides.paused_until !== null) {
    gfRepo.pauseAccount(db, id, overrides.paused_until);
  }
  return id;
}

function seedVideo(db: DatabaseType, id: string = "v1"): void {
  db.prepare(
    `INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at)
     VALUES (?, 'T', 'info', 'google-flow', 'queued', ?)`
  ).run(id, 100);
}

function seedDispatched(
  db: DatabaseType,
  args: {
    videoId?: string;
    accountId: string;
    chunkId?: string;
    retryCount?: number;
  }
): number {
  const videoId = args.videoId ?? "v1";
  const id = gfRepo.enqueueTask(db, {
    video_id: videoId,
    chunk_id: args.chunkId ?? "c1",
    kind: "image",
    mode: "createImage",
    prompt: "P",
    output_path: `images/${args.chunkId ?? "c1"}.png`,
    created_at: 100,
  });
  db.prepare(
    `UPDATE google_flow_queue
        SET status='dispatched', assigned_account_id=?, dispatched_at=?,
            external_task_id=?, retry_count=?
      WHERE id = ?`
  ).run(args.accountId, 100, `${id}_100`, args.retryCount ?? 0, id);
  return id;
}

function loadTask(db: DatabaseType, id: number): GoogleFlowQueueItem {
  return gfRepo.findTaskById(db, id) as GoogleFlowQueueItem;
}

describe("flowLifecycle.handleStaleProjectId", () => {
  it("clears the (video, account) project row and requeues the task", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    seedVideo(db, "v1");
    gfRepo.upsertFlowProjectForAccount(db, "v1", accountId, "flow_proj_1", 100);
    const taskId = seedDispatched(db, { accountId, videoId: "v1" });

    flowLifecycle.handleStaleProjectId(db, taskId, "v1", accountId);

    const project: GoogleFlowVideoProject | undefined = gfRepo.findFlowProjectForAccount(
      db,
      "v1",
      accountId
    );
    expect(project).toBeUndefined();

    const task = loadTask(db, taskId);
    expect(task.status).toBe("pending");
    expect(task.assigned_account_id).toBeNull();
    expect(task.external_task_id).toBeNull();
    expect(task.dispatched_at).toBeNull();
  });

  it("is a no-op on the project side when no row existed; still requeues", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    seedVideo(db, "v1");
    const taskId = seedDispatched(db, { accountId, videoId: "v1" });

    flowLifecycle.handleStaleProjectId(db, taskId, "v1", accountId);

    const task = loadTask(db, taskId);
    expect(task.status).toBe("pending");
  });

  it("preserves retry_count (no retry-bump on stale project)", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    seedVideo(db, "v1");
    const taskId = seedDispatched(db, { accountId, videoId: "v1", retryCount: 2 });

    flowLifecycle.handleStaleProjectId(db, taskId, "v1", accountId);

    const task = loadTask(db, taskId);
    expect(task.retry_count).toBe(2);
  });
});

describe("flowLifecycle.handleQuota", () => {
  it("pauses the account until the supplied unix-seconds and requeues the task", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    seedVideo(db, "v1");
    const taskId = seedDispatched(db, { accountId });
    const pauseUntil = 1_700_000_000 + 24 * 3600;

    flowLifecycle.handleQuota(db, taskId, accountId, pauseUntil);

    const acct = db
      .prepare("SELECT paused_until FROM google_flow_accounts WHERE id = ?")
      .get(accountId) as { paused_until: number };
    expect(acct.paused_until).toBe(pauseUntil);

    const task = loadTask(db, taskId);
    expect(task.status).toBe("pending");
    expect(task.assigned_account_id).toBeNull();
  });

  it("preserves retry_count (quota is account-state, not task-shape)", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    seedVideo(db, "v1");
    const taskId = seedDispatched(db, { accountId, retryCount: 3 });

    flowLifecycle.handleQuota(db, taskId, accountId, 1_700_000_000);

    expect(loadTask(db, taskId).retry_count).toBe(3);
  });
});

describe("flowLifecycle.handleCaptcha", () => {
  it("stamps recovery_reason + recovery_required_at and requeues the task", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    seedVideo(db, "v1");
    const taskId = seedDispatched(db, { accountId });
    const now = 1_700_000_500;

    flowLifecycle.handleCaptcha(db, taskId, accountId, now);

    const acct = db
      .prepare(
        "SELECT recovery_reason, recovery_required_at, paused_until FROM google_flow_accounts WHERE id = ?"
      )
      .get(accountId) as {
      recovery_reason: string | null;
      recovery_required_at: number | null;
      paused_until: number | null;
    };
    expect(acct.recovery_reason).toBe("captcha");
    expect(acct.recovery_required_at).toBe(now);
    // No paused_until — captcha is operator-gated, not time-based.
    expect(acct.paused_until).toBeNull();

    expect(loadTask(db, taskId).status).toBe("pending");
  });

  it("preserves retry_count (captcha is account-state, not task-shape)", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    seedVideo(db, "v1");
    const taskId = seedDispatched(db, { accountId, retryCount: 4 });

    flowLifecycle.handleCaptcha(db, taskId, accountId, 1_700_000_000);

    expect(loadTask(db, taskId).retry_count).toBe(4);
  });
});

describe("flowLifecycle.handleCreateProjectFailed", () => {
  it("pauses account, requeues task, and stamps the banner setting", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    seedVideo(db, "v1");
    const taskId = seedDispatched(db, { accountId });
    const pauseUntil = 1_700_000_000 + 24 * 3600;
    const payload = JSON.stringify({
      errorCode: "ENVELOPE_DRIFT",
      httpStatus: 500,
      taskId: "1_x",
      when: 1_700_000_000,
      accountId,
    });

    flowLifecycle.handleCreateProjectFailed(
      db,
      taskId,
      accountId,
      pauseUntil,
      payload
    );

    const acct = db
      .prepare("SELECT paused_until FROM google_flow_accounts WHERE id = ?")
      .get(accountId) as { paused_until: number };
    expect(acct.paused_until).toBe(pauseUntil);

    expect(loadTask(db, taskId).status).toBe("pending");

    expect(readSettingRaw(db, FlowBannerKeys.createProjectFailed)).toBe(payload);
  });

  it("preserves retry_count (requeue without burning retry budget)", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    seedVideo(db, "v1");
    const taskId = seedDispatched(db, { accountId, retryCount: 2 });

    flowLifecycle.handleCreateProjectFailed(
      db,
      taskId,
      accountId,
      1_700_000_000 + 24 * 3600,
      "{}"
    );

    expect(loadTask(db, taskId).retry_count).toBe(2);
  });
});

describe("flowLifecycle.handleServiceOverload", () => {
  it("pauses account, requeues task, stamps the banner timestamp", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    seedVideo(db, "v1");
    const taskId = seedDispatched(db, { accountId });
    const pauseUntil = 1_700_000_000 + 600;

    flowLifecycle.handleServiceOverload(db, taskId, accountId, pauseUntil);

    const acct = db
      .prepare("SELECT paused_until FROM google_flow_accounts WHERE id = ?")
      .get(accountId) as { paused_until: number };
    expect(acct.paused_until).toBe(pauseUntil);

    expect(loadTask(db, taskId).status).toBe("pending");

    expect(readSettingRaw(db, FlowBannerKeys.serviceOverloadUntil)).toBe(
      String(pauseUntil)
    );
  });

  it("overwrites the banner on a subsequent event (fresh push wins)", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    seedVideo(db, "v1");
    const taskId = seedDispatched(db, { accountId });

    flowLifecycle.handleServiceOverload(db, taskId, accountId, 1_700_000_100);
    flowLifecycle.handleServiceOverload(db, taskId, accountId, 1_700_000_900);

    expect(readSettingRaw(db, FlowBannerKeys.serviceOverloadUntil)).toBe(
      "1700000900"
    );
  });

  it("preserves retry_count (requeue without burning retry budget)", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    seedVideo(db, "v1");
    const taskId = seedDispatched(db, { accountId, retryCount: 2 });

    flowLifecycle.handleServiceOverload(db, taskId, accountId, 1_700_000_500);

    expect(loadTask(db, taskId).retry_count).toBe(2);
  });
});

describe("flowLifecycle.handleTransient", () => {
  it("bumps retry_count and requeues when below the cap", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    seedVideo(db, "v1");
    const taskId = seedDispatched(db, { accountId, retryCount: 1 });
    const task = loadTask(db, taskId);

    flowLifecycle.handleTransient(db, task, "boom", 5);

    const after = loadTask(db, taskId);
    expect(after.status).toBe("pending");
    expect(after.retry_count).toBe(2);
    expect(after.error_reason).toBeNull();
  });

  it("bumps retry_count and fails the task when the cap is reached", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    seedVideo(db, "v1");
    const taskId = seedDispatched(db, { accountId, retryCount: 4 });
    const task = loadTask(db, taskId);

    flowLifecycle.handleTransient(db, task, "fatal", 5);

    const after = loadTask(db, taskId);
    expect(after.status).toBe("failed");
    expect(after.retry_count).toBe(5);
    expect(after.error_reason).toBe("fatal");
  });
});

describe("flowLifecycle.editAccount", () => {
  function readAccount(
    db: DatabaseType,
    id: string
  ): {
    name: string;
    enabled: number;
    paused_until: number | null;
  } {
    return db
      .prepare(
        "SELECT name, enabled, paused_until FROM google_flow_accounts WHERE id = ?"
      )
      .get(id) as { name: string; enabled: number; paused_until: number | null };
  }

  it("updates only the name when name is provided", () => {
    const db = freshDb();
    const id = seedAccount(db);

    flowLifecycle.editAccount(db, id, { name: "renamed" });

    const acct = readAccount(db, id);
    expect(acct.name).toBe("renamed");
    expect(acct.enabled).toBe(1);
    expect(acct.paused_until).toBeNull();
  });

  it("updates only enabled when enabled is provided", () => {
    const db = freshDb();
    const id = seedAccount(db);

    flowLifecycle.editAccount(db, id, { enabled: false });

    const acct = readAccount(db, id);
    expect(acct.enabled).toBe(0);
    expect(acct.name).toBe("a");
  });

  it("pauses the account when pausedUntil is a number", () => {
    const db = freshDb();
    const id = seedAccount(db);

    flowLifecycle.editAccount(db, id, { pausedUntil: 1_700_000_500 });

    expect(readAccount(db, id).paused_until).toBe(1_700_000_500);
  });

  it("resumes the account when pausedUntil is null", () => {
    const db = freshDb();
    const id = seedAccount(db, { paused_until: 1_700_000_500 });

    flowLifecycle.editAccount(db, id, { pausedUntil: null });

    expect(readAccount(db, id).paused_until).toBeNull();
  });

  it("applies multiple fields in one call", () => {
    const db = freshDb();
    const id = seedAccount(db);

    flowLifecycle.editAccount(db, id, {
      name: "fresh",
      enabled: false,
      pausedUntil: 1_700_000_900,
    });

    const acct = readAccount(db, id);
    expect(acct.name).toBe("fresh");
    expect(acct.enabled).toBe(0);
    expect(acct.paused_until).toBe(1_700_000_900);
  });

  it("leaves all fields unchanged when patch is empty", () => {
    const db = freshDb();
    const id = seedAccount(db, { paused_until: 1_700_000_100 });

    flowLifecycle.editAccount(db, id, {});

    const acct = readAccount(db, id);
    expect(acct.name).toBe("a");
    expect(acct.enabled).toBe(1);
    expect(acct.paused_until).toBe(1_700_000_100);
  });
});

describe("flowLifecycle.requeueAllOnAccountDeletion", () => {
  it("requeues every dispatched task for the account, then deletes the account", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    seedVideo(db, "v1");
    const t1 = seedDispatched(db, { accountId, chunkId: "c1" });
    const t2 = seedDispatched(db, { accountId, chunkId: "c2" });

    flowLifecycle.requeueAllOnAccountDeletion(db, accountId);

    expect(gfRepo.findAccountById(db, accountId)).toBeUndefined();

    const after1 = loadTask(db, t1);
    expect(after1.status).toBe("pending");
    expect(after1.assigned_account_id).toBeNull();
    expect(after1.external_task_id).toBeNull();

    const after2 = loadTask(db, t2);
    expect(after2.status).toBe("pending");
    expect(after2.assigned_account_id).toBeNull();
  });

  it("deletes the account when no dispatched rows exist", () => {
    const db = freshDb();
    const accountId = seedAccount(db);

    flowLifecycle.requeueAllOnAccountDeletion(db, accountId);

    expect(gfRepo.findAccountById(db, accountId)).toBeUndefined();
  });

  it("leaves pending rows for other accounts untouched", () => {
    const db = freshDb();
    const a1 = seedAccount(db, { id: "acc1", token: "t1" });
    const a2 = seedAccount(db, { id: "acc2", token: "t2" });
    seedVideo(db, "v1");
    const t1 = seedDispatched(db, { accountId: a1, chunkId: "c1" });
    const t2 = seedDispatched(db, { accountId: a2, chunkId: "c2" });

    flowLifecycle.requeueAllOnAccountDeletion(db, a1);

    expect(loadTask(db, t1).status).toBe("pending");
    // a2's task is unchanged — still dispatched against a2.
    const t2After = loadTask(db, t2);
    expect(t2After.status).toBe("dispatched");
    expect(t2After.assigned_account_id).toBe(a2);
    expect(gfRepo.findAccountById(db, a2)).toBeDefined();
  });
});

describe("flowLifecycle.claimNextTask", () => {
  function seedPending(
    db: DatabaseType,
    args: {
      videoId?: string;
      chunkId?: string;
      kind?: "image" | "clip";
    } = {}
  ): number {
    const videoId = args.videoId ?? "v1";
    return gfRepo.enqueueTask(db, {
      video_id: videoId,
      chunk_id: args.chunkId ?? "c1",
      kind: args.kind ?? "image",
      mode: "createImage",
      prompt: "P",
      output_path: `images/${args.chunkId ?? "c1"}.png`,
      created_at: 100,
    });
  }

  function loadAccount(db: DatabaseType, id: string): GoogleFlowAccount {
    return gfRepo.findAccountById(db, id) as GoogleFlowAccount;
  }

  it("claims the next pending task and returns the row + parent video", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    seedVideo(db, "v1");
    const taskId = seedPending(db);
    const account = loadAccount(db, accountId);

    const claimed = flowLifecycle.claimNextTask(db, account, 1_700_000_000);

    expect(claimed).not.toBeNull();
    expect(claimed!.row.id).toBe(taskId);
    expect(claimed!.row.status).toBe("dispatched");
    expect(claimed!.video.id).toBe("v1");
  });

  it("returns null when no pending row is available", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const account = loadAccount(db, accountId);

    const claimed = flowLifecycle.claimNextTask(db, account, 1_700_000_000);

    expect(claimed).toBeNull();
  });

  it("clears paused_until when account.paused_until is set (elapsed pause)", () => {
    const db = freshDb();
    const accountId = seedAccount(db, { paused_until: 1_699_999_000 });
    seedVideo(db, "v1");
    seedPending(db);
    const account = loadAccount(db, accountId);

    flowLifecycle.claimNextTask(db, account, 1_700_000_000);

    const after = loadAccount(db, accountId);
    expect(after.paused_until).toBeNull();
  });

  it("leaves paused_until untouched when it was already null", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    seedVideo(db, "v1");
    seedPending(db);
    const account = loadAccount(db, accountId);

    flowLifecycle.claimNextTask(db, account, 1_700_000_000);

    expect(loadAccount(db, accountId).paused_until).toBeNull();
  });

  it("clears the relogin banner when it was set", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    seedVideo(db, "v1");
    seedPending(db);
    setSetting(FlowBannerKeys.reloginNeeded, true, db);
    const account = loadAccount(db, accountId);

    flowLifecycle.claimNextTask(db, account, 1_700_000_000);

    expect(readSettingRaw(db, FlowBannerKeys.reloginNeeded)).toBe("false");
  });

  it("returns null when the claimed task's parent video is missing", () => {
    // Defensive — the FK should prevent this in practice, but the
    // production code path returns null on a missing parent rather than
    // throwing.
    const db = freshDb();
    const accountId = seedAccount(db);
    seedVideo(db, "v1");
    seedPending(db);
    db.prepare("DELETE FROM videos WHERE id = 'v1'").run();
    const account = loadAccount(db, accountId);

    const claimed = flowLifecycle.claimNextTask(db, account, 1_700_000_000);
    expect(claimed).toBeNull();
  });
});

describe("flowLifecycle.recordModerationBatch", () => {
  it("inserts a moderation_events row and requeues with the rewritten prompt for each write", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    seedVideo(db, "v1");
    const t1 = seedDispatched(db, { accountId, chunkId: "c1" });
    const t2 = seedDispatched(db, { accountId, chunkId: "c2" });
    // Mark them failed first so requeueWithNewPrompt has a sensible
    // starting state (parity with the production caller's failed-row
    // selection).
    gfRepo.failTask(db, t1, "blocked: policy");
    gfRepo.failTask(db, t2, "blocked: policy");

    flowLifecycle.recordModerationBatch(db, [
      {
        videoId: "v1",
        chunkId: "c1",
        kind: "image",
        round: 1,
        originalPrompt: "P1",
        rewritten: "P1*",
        reasonTag: "violence",
        createdAt: 1_700_000_000,
        rowId: t1,
      },
      {
        videoId: "v1",
        chunkId: "c2",
        kind: "image",
        round: 1,
        originalPrompt: "P2",
        rewritten: "P2*",
        reasonTag: null,
        createdAt: 1_700_000_000,
        rowId: t2,
      },
    ]);

    const after1 = loadTask(db, t1);
    expect(after1.status).toBe("pending");
    expect(after1.prompt).toBe("P1*");
    expect(after1.moderation_round).toBe(1);

    const after2 = loadTask(db, t2);
    expect(after2.status).toBe("pending");
    expect(after2.prompt).toBe("P2*");

    const events = db
      .prepare(
        "SELECT chunk_id, rewritten_prompt, reason_tag FROM moderation_events WHERE video_id = ? ORDER BY id ASC"
      )
      .all("v1") as Array<{
      chunk_id: string;
      rewritten_prompt: string;
      reason_tag: string | null;
    }>;
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      chunk_id: "c1",
      rewritten_prompt: "P1*",
      reason_tag: "violence",
    });
    expect(events[1]).toMatchObject({
      chunk_id: "c2",
      rewritten_prompt: "P2*",
      reason_tag: null,
    });
  });

  it("is a no-op with empty writes", () => {
    const db = freshDb();

    flowLifecycle.recordModerationBatch(db, []);

    const count = (db
      .prepare("SELECT COUNT(*) as n FROM moderation_events")
      .get() as { n: number }).n;
    expect(count).toBe(0);
  });
});

describe("flowLifecycle.requeueFailedTask", () => {
  function seedFailedRow(
    db: DatabaseType,
    args: {
      videoId?: string;
      chunkId?: string | null;
      prompt?: string;
      moderationRound?: number;
    } = {}
  ): number {
    const videoId = args.videoId ?? "v1";
    const id = gfRepo.enqueueTask(db, {
      video_id: videoId,
      chunk_id: args.chunkId === undefined ? "c1" : args.chunkId,
      kind: "image",
      mode: "createImage",
      prompt: args.prompt ?? "old prompt",
      output_path: "images/c1.png",
      created_at: 100,
    });
    db.prepare(
      `UPDATE google_flow_queue
          SET status = 'failed', error_reason = 'boom',
              moderation_round = ?, retry_count = 1
        WHERE id = ?`
    ).run(args.moderationRound ?? 2, id);
    return id;
  }

  function seedFailedVideo(
    db: DatabaseType,
    failedStep: string = "generate_images"
  ): void {
    db.prepare(
      `INSERT INTO videos (id, title, topic_info, workflow_id, status,
                           failed_step, failed_reason, finished_at,
                           created_at)
       VALUES ('v1', 'T', 'info', 'google-flow', 'failed', ?, ?, ?, 100)`
    ).run(failedStep, "boom", 999);
    db.prepare(
      `INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at)
       VALUES ('v1', ?, 'failed', 100, 200)`
    ).run(failedStep);
  }

  it("plain retry: requeues the row in place with no moderation_events row", () => {
    const db = freshDb();
    seedVideo(db, "v1");
    const taskId = seedFailedRow(db, { moderationRound: 1 });
    const task = loadTask(db, taskId);

    const result = flowLifecycle.requeueFailedTask(db, task, {
      nowSec: 1_700_000_000,
    });

    expect(result).toEqual({ videoUnfailed: false });
    const after = loadTask(db, taskId);
    expect(after.status).toBe("pending");
    expect(after.prompt).toBe("old prompt");
    expect(after.moderation_round).toBe(1);
    expect(after.external_task_id).toBeNull();
    expect(after.assigned_account_id).toBeNull();
    const events = db
      .prepare("SELECT COUNT(*) as n FROM moderation_events")
      .get() as { n: number };
    expect(events.n).toBe(0);
  });

  it("edit mode: rewrites the prompt, resets moderation_round, inserts manual_edit event", () => {
    const db = freshDb();
    seedVideo(db, "v1");
    const taskId = seedFailedRow(db, { prompt: "old", moderationRound: 3 });
    const task = loadTask(db, taskId);

    const result = flowLifecycle.requeueFailedTask(db, task, {
      newPrompt: "operator override",
      chunkId: "c1",
      originalPrompt: "old",
      reasonTag: "manual_edit",
      nowSec: 1_700_000_000,
    });

    expect(result).toEqual({ videoUnfailed: false });
    const after = loadTask(db, taskId);
    expect(after.status).toBe("pending");
    expect(after.prompt).toBe("operator override");
    expect(after.moderation_round).toBe(0);
    const events = db
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
    expect(events).toEqual([
      {
        chunk_id: "c1",
        round: 0,
        original_prompt: "old",
        rewritten_prompt: "operator override",
        reason_tag: "manual_edit",
      },
    ]);
  });

  it("cascade: unfails the parent video when it is failed with a non-null failed_step", () => {
    const db = freshDb();
    seedFailedVideo(db, "generate_images");
    const taskId = seedFailedRow(db);
    const task = loadTask(db, taskId);

    const result = flowLifecycle.requeueFailedTask(db, task, {
      nowSec: 1_700_000_000,
    });

    expect(result).toEqual({ videoUnfailed: true });
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

  it("no cascade: leaves the parent video alone when it isn't failed", () => {
    const db = freshDb();
    seedVideo(db, "v1");
    const taskId = seedFailedRow(db);
    const task = loadTask(db, taskId);

    const result = flowLifecycle.requeueFailedTask(db, task, {
      nowSec: 1_700_000_000,
    });

    expect(result).toEqual({ videoUnfailed: false });
    const status = db
      .prepare("SELECT status FROM videos WHERE id = 'v1'")
      .get() as { status: string };
    expect(status.status).toBe("queued");
  });
});

describe("requeueFailedTask <-> unfailToQueued SAVEPOINT propagation", () => {
  // Load-bearing for ADR-0007 §3: the cross-module cascade relies on
  // better-sqlite3 nesting an inner `db.transaction(fn)` as a SAVEPOINT
  // under an outer one. If the inner method throws, the outer
  // transaction must roll back too — neither aggregate may commit.

  function seedFailedRow(db: DatabaseType, videoId: string = "v1"): number {
    const id = gfRepo.enqueueTask(db, {
      video_id: videoId,
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "P",
      output_path: "images/c1.png",
      created_at: 100,
    });
    db.prepare(
      `UPDATE google_flow_queue
          SET status = 'failed', error_reason = 'boom', retry_count = 1
        WHERE id = ?`
    ).run(id);
    return id;
  }

  function seedFailedVideoWithStep(db: DatabaseType): void {
    db.prepare(
      `INSERT INTO videos (id, title, topic_info, workflow_id, status,
                           failed_step, failed_reason, finished_at,
                           created_at)
       VALUES ('v1', 'T', 'info', 'google-flow', 'failed',
               'generate_images', 'boom', 999, 100)`
    ).run();
    db.prepare(
      `INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at)
       VALUES ('v1', 'generate_images', 'failed', 100, 200)`
    ).run();
  }

  it("rolls back both aggregates when the inner unfailToQueued throws", () => {
    const db = freshDb();
    seedFailedVideoWithStep(db);
    const taskId = seedFailedRow(db);
    const task = gfRepo.findTaskById(db, taskId) as GoogleFlowQueueItem;

    // Fault injection: make the last DB write inside `unfailToQueued`
    // throw, so we can prove the SAVEPOINT (and outer txn) both roll back.
    const spy = vi
      .spyOn(videosRepo, "setStatus")
      .mockImplementation(() => {
        throw new Error("forced rollback");
      });

    try {
      expect(() =>
        flowLifecycle.requeueFailedTask(db, task, { nowSec: 1_700_000_000 })
      ).toThrow("forced rollback");

      // Task must NOT be requeued — outer txn rolled back.
      const taskAfter = gfRepo.findTaskById(db, taskId) as GoogleFlowQueueItem;
      expect(taskAfter.status).toBe("failed");
      expect(taskAfter.error_reason).toBe("boom");

      // Video must NOT be unfailed — inner SAVEPOINT rolled back.
      const video = db
        .prepare("SELECT status, failed_step FROM videos WHERE id = 'v1'")
        .get() as { status: string; failed_step: string | null };
      expect(video.status).toBe("failed");
      expect(video.failed_step).toBe("generate_images");

      // Step row must NOT be reset.
      const step = db
        .prepare(
          "SELECT status FROM video_steps WHERE video_id = 'v1' AND step_name = 'generate_images'"
        )
        .get() as { status: string };
      expect(step.status).toBe("failed");
    } finally {
      spy.mockRestore();
    }
  });

  it("rolls the inner SAVEPOINT back from inside an even-larger outer txn (route loop pattern)", () => {
    const db = freshDb();
    seedFailedVideoWithStep(db);
    const taskId = seedFailedRow(db);
    const task = gfRepo.findTaskById(db, taskId) as GoogleFlowQueueItem;

    const spy = vi
      .spyOn(videosRepo, "setStatus")
      .mockImplementation(() => {
        throw new Error("forced rollback");
      });

    try {
      // Wrap in an outer txn the way `requeue-failed/route.ts` does.
      expect(() =>
        db.transaction(() => {
          flowLifecycle.requeueFailedTask(db, task, { nowSec: 1_700_000_000 });
        })()
      ).toThrow("forced rollback");

      const taskAfter = gfRepo.findTaskById(db, taskId) as GoogleFlowQueueItem;
      expect(taskAfter.status).toBe("failed");

      const video = db
        .prepare("SELECT status FROM videos WHERE id = 'v1'")
        .get() as { status: string };
      expect(video.status).toBe("failed");
    } finally {
      spy.mockRestore();
    }
  });
});
