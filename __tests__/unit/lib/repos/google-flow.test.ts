import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb } from "@/lib/db";
import * as gfRepo from "@/lib/repos/google-flow";

function newDb() {
  return createDb(":memory:");
}

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

describe("createDb — google_flow_accounts", () => {
  it("creates the google_flow_accounts table", () => {
    const db = newDb();
    try {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toContain("google_flow_accounts");
    } finally {
      db.close();
    }
  });

  it("has the spec-defined columns with correct notnull/defaults", () => {
    const db = newDb();
    try {
      const cols = db
        .prepare("PRAGMA table_info(google_flow_accounts)")
        .all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

      // SQLite quirk: TEXT PRIMARY KEY does not imply NOT NULL (only INTEGER does).
      expect(byName.id).toMatchObject({ pk: 1 });
      expect(byName.name).toMatchObject({ notnull: 1 });
      expect(byName.token).toMatchObject({ notnull: 1 });
      expect(byName.quota_used_today).toMatchObject({
        notnull: 1,
        dflt_value: "0",
      });
      expect(byName.paused_until).toMatchObject({ notnull: 0 });
      expect(byName.last_seen_at).toMatchObject({ notnull: 0 });
      expect(byName.credits).toMatchObject({ notnull: 0 });
      expect(byName.credits_updated_at).toMatchObject({ notnull: 0 });
      expect(byName.enabled).toMatchObject({ notnull: 1, dflt_value: "1" });
      expect(byName.created_at).toMatchObject({ notnull: 1 });
    } finally {
      db.close();
    }
  });

  it("stores a fully-specified row round-trip", () => {
    const db = newDb();
    try {
      db.prepare(
        `INSERT INTO google_flow_accounts
           (id, name, token, quota_used_today, paused_until, last_seen_at,
            credits, credits_updated_at, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("acc_01", "Alpha", "tok1", 12, 1_800_000, 1_790_000, 900, 1_780_000, 1, 1_700_000);
      const row = db
        .prepare("SELECT * FROM google_flow_accounts WHERE id = ?")
        .get("acc_01");
      expect(row).toMatchObject({
        id: "acc_01",
        name: "Alpha",
        token: "tok1",
        quota_used_today: 12,
        paused_until: 1_800_000,
        last_seen_at: 1_790_000,
        credits: 900,
        credits_updated_at: 1_780_000,
        enabled: 1,
        created_at: 1_700_000,
      });
    } finally {
      db.close();
    }
  });

  it("rejects duplicate tokens (UNIQUE)", () => {
    const db = newDb();
    try {
      db.prepare(
        "INSERT INTO google_flow_accounts (id, name, token, created_at) VALUES (?, ?, ?, ?)"
      ).run("acc_01", "First", "tok_abc", 1);
      expect(() =>
        db
          .prepare(
            "INSERT INTO google_flow_accounts (id, name, token, created_at) VALUES (?, ?, ?, ?)"
          )
          .run("acc_02", "Second", "tok_abc", 2)
      ).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });
});

describe("google-flow repo — accounts", () => {
  it("insertAccount + findAccountById + findAccountByToken round-trip", () => {
    const db = freshDb();
    gfRepo.insertAccount(db, {
      id: "acc_01",
      name: "Alpha",
      token: "tok1",
      created_at: 1_700_000,
    });
    const byId = gfRepo.findAccountById(db, "acc_01");
    const byToken = gfRepo.findAccountByToken(db, "tok1");
    expect(byId?.name).toBe("Alpha");
    expect(byToken?.id).toBe("acc_01");
    expect(byId?.enabled).toBe(1);
    expect(byId?.paused_until).toBeNull();
  });

  it("findAccountById / findAccountByToken return undefined on miss", () => {
    const db = freshDb();
    expect(gfRepo.findAccountById(db, "acc_nope")).toBeUndefined();
    expect(gfRepo.findAccountByToken(db, "tok_nope")).toBeUndefined();
  });

  it("listAccounts returns every row; empty DB is []", () => {
    const db = freshDb();
    expect(gfRepo.listAccounts(db)).toEqual([]);
    gfRepo.insertAccount(db, { id: "acc_01", name: "A", token: "t1", created_at: 1 });
    gfRepo.insertAccount(db, { id: "acc_02", name: "B", token: "t2", created_at: 2 });
    expect(gfRepo.listAccounts(db).map((a) => a.id).sort()).toEqual([
      "acc_01",
      "acc_02",
    ]);
  });

  it("setAccountEnabled flips enabled to 0/1", () => {
    const db = freshDb();
    gfRepo.insertAccount(db, { id: "acc_01", name: "A", token: "t1", created_at: 1 });
    gfRepo.setAccountEnabled(db, "acc_01", false);
    expect(gfRepo.findAccountById(db, "acc_01")?.enabled).toBe(0);
    gfRepo.setAccountEnabled(db, "acc_01", true);
    expect(gfRepo.findAccountById(db, "acc_01")?.enabled).toBe(1);
  });

  it("resumeAccount clears paused_until", () => {
    const db = freshDb();
    gfRepo.insertAccount(db, { id: "acc_01", name: "A", token: "t1", created_at: 1 });
    gfRepo.pauseAccount(db, "acc_01", 1_800_000);

    gfRepo.resumeAccount(db, "acc_01");

    const row = gfRepo.findAccountById(db, "acc_01")!;
    expect(row.paused_until).toBeNull();
  });

  it("setAccountRecoveryReason writes both recovery_reason and recovery_required_at together", () => {
    const db = freshDb();
    gfRepo.insertAccount(db, { id: "acc_01", name: "A", token: "t1", created_at: 1 });

    gfRepo.setAccountRecoveryReason(db, "acc_01", "captcha", 1_800_000);

    const row = gfRepo.findAccountById(db, "acc_01")!;
    expect(row.recovery_reason).toBe("captcha");
    expect(row.recovery_required_at).toBe(1_800_000);
  });

  it("clearAccountRecovery NULLs both recovery columns", () => {
    const db = freshDb();
    gfRepo.insertAccount(db, { id: "acc_01", name: "A", token: "t1", created_at: 1 });
    gfRepo.setAccountRecoveryReason(db, "acc_01", "captcha", 1_800_000);

    gfRepo.clearAccountRecovery(db, "acc_01");

    const row = gfRepo.findAccountById(db, "acc_01")!;
    expect(row.recovery_reason).toBeNull();
    expect(row.recovery_required_at).toBeNull();
  });

  describe("listRecoveryAccounts", () => {
    it("returns only enabled accounts with recovery_reason set", () => {
      const db = freshDb();
      gfRepo.insertAccount(db, { id: "acc_01", name: "Healthy", token: "t1", created_at: 1 });
      gfRepo.insertAccount(db, { id: "acc_02", name: "Flagged", token: "t2", created_at: 2 });
      gfRepo.insertAccount(db, { id: "acc_03", name: "DisabledFlagged", token: "t3", created_at: 3 });

      gfRepo.setAccountRecoveryReason(db, "acc_02", "captcha", 1_000);
      gfRepo.setAccountRecoveryReason(db, "acc_03", "captcha", 2_000);
      gfRepo.setAccountEnabled(db, "acc_03", false);

      const rows = gfRepo.listRecoveryAccounts(db);
      expect(rows).toEqual([
        { id: "acc_02", name: "Flagged", required_at: 1_000 },
      ]);
    });

    it("orders by recovery_required_at ASC (oldest first)", () => {
      const db = freshDb();
      gfRepo.insertAccount(db, { id: "acc_01", name: "Newer", token: "t1", created_at: 1 });
      gfRepo.insertAccount(db, { id: "acc_02", name: "Oldest", token: "t2", created_at: 2 });
      gfRepo.insertAccount(db, { id: "acc_03", name: "Middle", token: "t3", created_at: 3 });

      gfRepo.setAccountRecoveryReason(db, "acc_01", "captcha", 3_000);
      gfRepo.setAccountRecoveryReason(db, "acc_02", "captcha", 1_000);
      gfRepo.setAccountRecoveryReason(db, "acc_03", "captcha", 2_000);

      const rows = gfRepo.listRecoveryAccounts(db);
      expect(rows.map((r) => r.id)).toEqual(["acc_02", "acc_03", "acc_01"]);
    });

    it("returns empty when no accounts are in recovery", () => {
      const db = freshDb();
      gfRepo.insertAccount(db, { id: "acc_01", name: "A", token: "t1", created_at: 1 });
      expect(gfRepo.listRecoveryAccounts(db)).toEqual([]);
    });
  });

  it("updateAccountLastSeen sets the timestamp", () => {
    const db = freshDb();
    gfRepo.insertAccount(db, { id: "acc_01", name: "A", token: "t1", created_at: 1 });
    gfRepo.updateAccountLastSeen(db, "acc_01", 1_800_000);
    expect(gfRepo.findAccountById(db, "acc_01")?.last_seen_at).toBe(1_800_000);
  });

  it("updateAccountCredits sets credits and the updated_at stamp together", () => {
    const db = freshDb();
    gfRepo.insertAccount(db, { id: "acc_01", name: "A", token: "t1", created_at: 1 });
    gfRepo.updateAccountCredits(db, "acc_01", 900, 1_800_000);
    const row = gfRepo.findAccountById(db, "acc_01")!;
    expect(row.credits).toBe(900);
    expect(row.credits_updated_at).toBe(1_800_000);
  });

  it("deleteAccount removes the row", () => {
    const db = freshDb();
    gfRepo.insertAccount(db, { id: "acc_01", name: "A", token: "t1", created_at: 1 });
    gfRepo.deleteAccount(db, "acc_01");
    expect(gfRepo.findAccountById(db, "acc_01")).toBeUndefined();
  });

  it("firstAccountPausedUntil returns the earliest paused_until among enabled+paused accounts", () => {
    const db = freshDb();
    gfRepo.insertAccount(db, { id: "acc_a", name: "A", token: "ta", created_at: 1 });
    gfRepo.insertAccount(db, { id: "acc_b", name: "B", token: "tb", created_at: 2 });
    gfRepo.insertAccount(db, { id: "acc_c", name: "C", token: "tc", created_at: 3 });

    gfRepo.pauseAccount(db, "acc_a", 3000);
    gfRepo.pauseAccount(db, "acc_b", 2000); // earliest
    gfRepo.pauseAccount(db, "acc_c", 1000); // earliest BUT disabled
    gfRepo.setAccountEnabled(db, "acc_c", false);

    expect(gfRepo.firstAccountPausedUntil(db)).toBe(2000);
  });

  it("firstAccountPausedUntil returns null when no enabled paused accounts exist", () => {
    const db = freshDb();
    gfRepo.insertAccount(db, { id: "acc_a", name: "A", token: "ta", created_at: 1 });
    expect(gfRepo.firstAccountPausedUntil(db)).toBeNull();
  });

  it("anyAccountAvailable is true iff any enabled+not-paused account exists", () => {
    const db = freshDb();
    expect(gfRepo.anyAccountAvailable(db)).toBe(false);

    gfRepo.insertAccount(db, { id: "acc_a", name: "A", token: "ta", created_at: 1 });
    expect(gfRepo.anyAccountAvailable(db)).toBe(true);

    gfRepo.pauseAccount(db, "acc_a", 1_800_000);
    expect(gfRepo.anyAccountAvailable(db)).toBe(false);

    gfRepo.insertAccount(db, { id: "acc_b", name: "B", token: "tb", created_at: 2 });
    gfRepo.setAccountEnabled(db, "acc_b", false);
    expect(gfRepo.anyAccountAvailable(db)).toBe(false);

    gfRepo.setAccountEnabled(db, "acc_b", true);
    expect(gfRepo.anyAccountAvailable(db)).toBe(true);
  });
});

describe("google-flow repo — queue", () => {
  function seedVideo(db: DatabaseType, id = "v_1") {
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, "V", "info", "google-flow", "in_progress", 1);
  }

  function seedAccount(db: DatabaseType, id = "acc_01") {
    gfRepo.insertAccount(db, { id, name: id, token: `tok_${id}`, created_at: 1 });
  }

  it("enqueueTask + findTaskById round-trip", () => {
    const db = freshDb();
    seedVideo(db);
    const id = gfRepo.enqueueTask(db, {
      video_id: "v_1",
      chunk_id: "c_abc",
      kind: "image",
      mode: "createImage",
      prompt: "a historical scene",
      output_path: "images/c_abc.png",
      priority: 5,
      created_at: 100,
    });
    const row = gfRepo.findTaskById(db, id)!;
    expect(row).toMatchObject({
      video_id: "v_1",
      chunk_id: "c_abc",
      kind: "image",
      mode: "createImage",
      prompt: "a historical scene",
      output_path: "images/c_abc.png",
      priority: 5,
      status: "pending",
      retry_count: 0,
      assigned_account_id: null,
      external_task_id: null,
    });
  });

  it("findOpenTaskForChunk returns non-done/non-failed rows only", () => {
    const db = freshDb();
    seedVideo(db);

    const pendingId = gfRepo.enqueueTask(db, {
      video_id: "v_1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
      priority: 0,
      created_at: 1,
    });
    // same chunk in a different kind doesn't count
    gfRepo.enqueueTask(db, {
      video_id: "v_1",
      chunk_id: "c1",
      kind: "clip",
      mode: "text",
      prompt: "p",
      output_path: "videos/clip/c1.mp4",
      priority: 0,
      created_at: 2,
    });

    expect(gfRepo.findOpenTaskForChunk(db, "v_1", "image", "c1")?.id).toBe(
      pendingId
    );

    gfRepo.failTask(db, pendingId, "content policy");
    expect(gfRepo.findOpenTaskForChunk(db, "v_1", "image", "c1")).toBeUndefined();
  });

  it("takeNextTaskForAccount claims exactly one pending row; second caller gets null", () => {
    const db = freshDb();
    seedVideo(db);
    seedAccount(db, "acc_01");
    seedAccount(db, "acc_02");
    gfRepo.enqueueTask(db, {
      video_id: "v_1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
      priority: 0,
      created_at: 1,
    });

    const first = gfRepo.takeNextTaskForAccount(db, "acc_01", 1_700_000);
    const second = gfRepo.takeNextTaskForAccount(db, "acc_02", 1_700_001);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(first!.status).toBe("dispatched");
    expect(first!.assigned_account_id).toBe("acc_01");
    expect(first!.dispatched_at).toBe(1_700_000);
    expect(first!.external_task_id).toBe(`${first!.id}_1700000`);
  });

  it("takeNextTaskForAccount picks by priority DESC, id ASC", () => {
    const db = freshDb();
    seedVideo(db);
    seedAccount(db);

    const lowEarly = gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c1", kind: "image", mode: "createImage",
      prompt: "p", output_path: "images/c1.png", priority: 0, created_at: 1,
    });
    const highLate = gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c2", kind: "image", mode: "createImage",
      prompt: "p", output_path: "images/c2.png", priority: 5, created_at: 2,
    });
    const highEarly = gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c3", kind: "image", mode: "createImage",
      prompt: "p", output_path: "images/c3.png", priority: 5, created_at: 0,
    });
    // priority 5 rows claim first; among equals the lower id wins.
    // highLate was enqueued second → higher id than highEarly (third).
    // Actually AUTOINCREMENT gives ids in insert order regardless of
    // created_at, so highLate.id < highEarly.id here.
    const firstClaim = gfRepo.takeNextTaskForAccount(db, "acc_01", 100)!;
    expect(firstClaim.id).toBe(highLate);
    expect(firstClaim.priority).toBe(5);

    const secondClaim = gfRepo.takeNextTaskForAccount(db, "acc_01", 101)!;
    expect(secondClaim.id).toBe(highEarly);

    const thirdClaim = gfRepo.takeNextTaskForAccount(db, "acc_01", 102)!;
    expect(thirdClaim.id).toBe(lowEarly);
  });

  it("takeNextTaskForAccount skips rows whose video is paused", () => {
    // Hard-pause semantics: once a video is paused, its pending rows are
    // not dispatched even when an account is available. A non-paused
    // video's rows still claim normally, even if they were enqueued later.
    const db = freshDb();
    seedVideo(db, "v_paused");
    seedVideo(db, "v_live");
    seedAccount(db);

    gfRepo.enqueueTask(db, {
      video_id: "v_paused", chunk_id: "c1", kind: "image", mode: "createImage",
      prompt: "p", output_path: "images/c1.png", priority: 10, created_at: 1,
    });
    const liveId = gfRepo.enqueueTask(db, {
      video_id: "v_live", chunk_id: "c2", kind: "image", mode: "createImage",
      prompt: "p", output_path: "images/c2.png", priority: 0, created_at: 2,
    });
    db.prepare("UPDATE videos SET paused = 1 WHERE id = ?").run("v_paused");

    const claim = gfRepo.takeNextTaskForAccount(db, "acc_01", 1_700_000);
    expect(claim).not.toBeNull();
    expect(claim!.id).toBe(liveId);
    // The paused video's higher-priority row is untouched.
    const pausedRow = db
      .prepare("SELECT status FROM google_flow_queue WHERE video_id = ?")
      .get("v_paused") as { status: string };
    expect(pausedRow.status).toBe("pending");
  });

  it("takeNextTaskForAccount returns null when the only pending video is paused", () => {
    const db = freshDb();
    seedVideo(db, "v_paused");
    seedAccount(db);

    gfRepo.enqueueTask(db, {
      video_id: "v_paused", chunk_id: "c1", kind: "image", mode: "createImage",
      prompt: "p", output_path: "images/c1.png", priority: 0, created_at: 1,
    });
    db.prepare("UPDATE videos SET paused = 1 WHERE id = ?").run("v_paused");

    expect(gfRepo.takeNextTaskForAccount(db, "acc_01", 1_700_000)).toBeNull();
  });

  it("takeNextTaskForAccount with wantBucket='image' skips higher-priority non-image rows and claims createImage", () => {
    const db = freshDb();
    seedVideo(db);
    seedAccount(db);

    // Higher priority text (video bucket) — should be skipped.
    gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c1", kind: "clip", mode: "text",
      prompt: "p", output_path: "videos/clip/c1.mp4", priority: 10, created_at: 1,
    });
    const imageId = gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c2", kind: "image", mode: "createImage",
      prompt: "p", output_path: "images/c2.png", priority: 0, created_at: 2,
    });

    const claim = gfRepo.takeNextTaskForAccount(db, "acc_01", 1_700_000, "image");
    expect(claim).not.toBeNull();
    expect(claim!.id).toBe(imageId);
    expect(claim!.mode).toBe("createImage");
  });

  it("takeNextTaskForAccount with wantBucket='video' skips createImage and claims text/image/frames in priority order", () => {
    const db = freshDb();
    seedVideo(db);
    seedAccount(db);

    // Higher priority createImage (image bucket) — should be skipped.
    gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c1", kind: "image", mode: "createImage",
      prompt: "p", output_path: "images/c1.png", priority: 10, created_at: 1,
    });
    // Three video-bucket rows at varying priorities to verify ordering.
    const textRow = gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c2", kind: "clip", mode: "text",
      prompt: "p", output_path: "videos/clip/c2.mp4", priority: 0, created_at: 2,
    });
    const imageRow = gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c3", kind: "clip", mode: "image",
      prompt: "p", output_path: "videos/clip/c3.mp4", priority: 5, created_at: 3,
    });
    const framesRow = gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c4", kind: "clip", mode: "frames",
      prompt: "p", output_path: "videos/clip/c4.mp4", priority: 5, created_at: 4,
    });

    const first = gfRepo.takeNextTaskForAccount(db, "acc_01", 100, "video")!;
    expect(first.id).toBe(imageRow); // priority 5, lower id wins
    expect(first.mode).toBe("image");

    const second = gfRepo.takeNextTaskForAccount(db, "acc_01", 101, "video")!;
    expect(second.id).toBe(framesRow);
    expect(second.mode).toBe("frames");

    const third = gfRepo.takeNextTaskForAccount(db, "acc_01", 102, "video")!;
    expect(third.id).toBe(textRow);
    expect(third.mode).toBe("text");
  });

  it("takeNextTaskForAccount returns null when no rows match the requested bucket, even with other-bucket rows pending", () => {
    const db = freshDb();
    seedVideo(db);
    seedAccount(db);

    gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c1", kind: "clip", mode: "text",
      prompt: "p", output_path: "videos/clip/c1.mp4", priority: 0, created_at: 1,
    });

    expect(
      gfRepo.takeNextTaskForAccount(db, "acc_01", 1_700_000, "image")
    ).toBeNull();
    // The video-bucket row is untouched.
    const row = db
      .prepare("SELECT status FROM google_flow_queue WHERE chunk_id = ?")
      .get("c1") as { status: string };
    expect(row.status).toBe("pending");
  });

  it("takeNextTaskForAccount without a bucket preserves highest-priority-any-mode behaviour", () => {
    const db = freshDb();
    seedVideo(db);
    seedAccount(db);

    gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c1", kind: "image", mode: "createImage",
      prompt: "p", output_path: "images/c1.png", priority: 0, created_at: 1,
    });
    const highVideoId = gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c2", kind: "clip", mode: "text",
      prompt: "p", output_path: "videos/clip/c2.mp4", priority: 10, created_at: 2,
    });

    const claim = gfRepo.takeNextTaskForAccount(db, "acc_01", 1_700_000)!;
    expect(claim.id).toBe(highVideoId);
    expect(claim.mode).toBe("text");
  });

  it("takeNextTaskForAccount dispatches a paused video's rows again once unpaused", () => {
    const db = freshDb();
    seedVideo(db, "v1");
    seedAccount(db);

    gfRepo.enqueueTask(db, {
      video_id: "v1", chunk_id: "c1", kind: "image", mode: "createImage",
      prompt: "p", output_path: "images/c1.png", priority: 0, created_at: 1,
    });
    db.prepare("UPDATE videos SET paused = 1 WHERE id = ?").run("v1");
    expect(gfRepo.takeNextTaskForAccount(db, "acc_01", 100)).toBeNull();

    db.prepare("UPDATE videos SET paused = 0 WHERE id = ?").run("v1");
    const claim = gfRepo.takeNextTaskForAccount(db, "acc_01", 200);
    expect(claim).not.toBeNull();
    expect(claim!.status).toBe("dispatched");
  });

  it("findTaskByExternalId looks up dispatched rows", () => {
    const db = freshDb();
    seedVideo(db);
    seedAccount(db);
    gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c1", kind: "image", mode: "createImage",
      prompt: "p", output_path: "images/c1.png", priority: 0, created_at: 1,
    });
    const claimed = gfRepo.takeNextTaskForAccount(db, "acc_01", 100)!;
    const looked = gfRepo.findTaskByExternalId(db, claimed.external_task_id!);
    expect(looked?.id).toBe(claimed.id);
  });

  it("requeueTask clears assignment + external_task_id; preserves retry_count", () => {
    const db = freshDb();
    seedVideo(db);
    seedAccount(db);
    const id = gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c1", kind: "image", mode: "createImage",
      prompt: "p", output_path: "images/c1.png", priority: 0, created_at: 1,
    });
    gfRepo.takeNextTaskForAccount(db, "acc_01", 100);
    // Simulate a prior retry.
    db.prepare("UPDATE google_flow_queue SET retry_count = 2 WHERE id = ?").run(id);

    gfRepo.requeueTask(db, id);

    const row = gfRepo.findTaskById(db, id)!;
    expect(row.status).toBe("pending");
    expect(row.assigned_account_id).toBeNull();
    expect(row.dispatched_at).toBeNull();
    expect(row.external_task_id).toBeNull();
    // retry_count survives the requeue (callers bump it separately).
    expect(row.retry_count).toBe(2);
  });

  it("requeueTask preserves google_operation_id when requeueing a dispatched row (operation may still be live; resume avoids dupes)", () => {
    const db = freshDb();
    seedVideo(db);
    seedAccount(db);
    const id = gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c1", kind: "image", mode: "createImage",
      prompt: "p", output_path: "images/c1.png", priority: 0, created_at: 1,
    });
    gfRepo.takeNextTaskForAccount(db, "acc_01", 100);
    gfRepo.setOperationStarted(db, id, "operations/op-live", "proj-live");
    // Row is now in 'dispatched' status with operation_id set.

    gfRepo.requeueTask(db, id);

    const row = gfRepo.findTaskById(db, id)!;
    expect(row.status).toBe("pending");
    expect(row.google_operation_id).toBe("operations/op-live");
    expect(row.google_operation_project_id).toBe("proj-live");
  });

  it("requeueTask clears google_operation_id when requeueing a failed row (failed op on Google is terminal; resume-poll returns the same error forever)", () => {
    const db = freshDb();
    seedVideo(db);
    seedAccount(db);
    const id = gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c1", kind: "image", mode: "createImage",
      prompt: "p", output_path: "images/c1.png", priority: 0, created_at: 1,
    });
    gfRepo.takeNextTaskForAccount(db, "acc_01", 100);
    gfRepo.setOperationStarted(db, id, "operations/op-dead", "proj-dead");
    gfRepo.failTask(db, id, "Video generation failed: Content policy violation");
    // Row is now in 'failed' status with operation_id still set (failTask
    // intentionally preserves the operation_id for debugging).

    gfRepo.requeueTask(db, id);

    const row = gfRepo.findTaskById(db, id)!;
    expect(row.status).toBe("pending");
    expect(row.google_operation_id).toBeNull();
    expect(row.google_operation_project_id).toBeNull();
  });

  it("requeueWithNewPrompt always clears google_operation_id (different prompt = different operation; resuming would silently run the old prompt)", () => {
    const db = freshDb();
    seedVideo(db);
    seedAccount(db);
    const id = gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c1", kind: "image", mode: "createImage",
      prompt: "old", output_path: "images/c1.png", priority: 0, created_at: 1,
    });
    gfRepo.takeNextTaskForAccount(db, "acc_01", 100);
    gfRepo.setOperationStarted(db, id, "operations/op-old", "proj-old");
    gfRepo.failTask(db, id, "PUBLIC_ERROR_DANGER_FILTER");

    gfRepo.requeueWithNewPrompt(db, id, "fresh prompt", 0);

    const row = gfRepo.findTaskById(db, id)!;
    expect(row.prompt).toBe("fresh prompt");
    expect(row.status).toBe("pending");
    expect(row.moderation_round).toBe(0);
    expect(row.google_operation_id).toBeNull();
    expect(row.google_operation_project_id).toBeNull();
  });

  it("setOperationStarted writes both operation fields without disturbing dispatch state", () => {
    // Called by the operation-started webhook the SW posts after submit
    // returns. The row is in `dispatched` and the SW is about to start
    // polling — this write must not flip status, clear external_task_id,
    // or interfere with retry accounting.
    const db = freshDb();
    seedVideo(db);
    seedAccount(db);
    const id = gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c1", kind: "image", mode: "createImage",
      prompt: "p", output_path: "images/c1.png", priority: 0, created_at: 1,
    });
    const claimed = gfRepo.takeNextTaskForAccount(db, "acc_01", 100)!;
    db.prepare("UPDATE google_flow_queue SET retry_count = 2 WHERE id = ?").run(id);

    gfRepo.setOperationStarted(db, id, "operations/op-abc", "proj-xyz");

    const row = gfRepo.findTaskById(db, id)!;
    expect(row.google_operation_id).toBe("operations/op-abc");
    expect(row.google_operation_project_id).toBe("proj-xyz");
    expect(row.status).toBe("dispatched");
    expect(row.external_task_id).toBe(claimed.external_task_id);
    expect(row.assigned_account_id).toBe("acc_01");
    expect(row.retry_count).toBe(2);
  });

  it("setOperationStarted is last-writer-wins (NOT_FOUND fallback resubmit overwrites)", () => {
    // If poll-resume gets NOT_FOUND from Google, the SW re-submits and
    // posts a fresh operation. The repo helper must overwrite the stale
    // pair, not error or no-op.
    const db = freshDb();
    seedVideo(db);
    seedAccount(db);
    const id = gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c1", kind: "image", mode: "createImage",
      prompt: "p", output_path: "images/c1.png", priority: 0, created_at: 1,
    });
    gfRepo.takeNextTaskForAccount(db, "acc_01", 100);

    gfRepo.setOperationStarted(db, id, "operations/op-stale", "proj-old");
    gfRepo.setOperationStarted(db, id, "operations/op-fresh", "proj-new");

    const row = gfRepo.findTaskById(db, id)!;
    expect(row.google_operation_id).toBe("operations/op-fresh");
    expect(row.google_operation_project_id).toBe("proj-new");
  });

  it("completeTask sets result_url + status=done + completed_at", () => {
    const db = freshDb();
    seedVideo(db);
    seedAccount(db);
    const id = gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c1", kind: "image", mode: "createImage",
      prompt: "p", output_path: "images/c1.png", priority: 0, created_at: 1,
    });
    gfRepo.takeNextTaskForAccount(db, "acc_01", 100);

    gfRepo.completeTask(db, id, "https://storage.googleapis.com/foo.png", 200);

    const row = gfRepo.findTaskById(db, id)!;
    expect(row.status).toBe("done");
    expect(row.result_url).toBe("https://storage.googleapis.com/foo.png");
    expect(row.completed_at).toBe(200);
  });

  it("failTask sets error_reason + status=failed", () => {
    const db = freshDb();
    seedVideo(db);
    const id = gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c1", kind: "image", mode: "createImage",
      prompt: "p", output_path: "images/c1.png", priority: 0, created_at: 1,
    });
    gfRepo.failTask(db, id, "PUBLIC_ERROR_INAPPROPRIATE_CONTENT");
    const row = gfRepo.findTaskById(db, id)!;
    expect(row.status).toBe("failed");
    expect(row.error_reason).toBe("PUBLIC_ERROR_INAPPROPRIATE_CONTENT");
  });

  it("countByStatusForVideo aggregates only the (video_id, kind) pair", () => {
    const db = freshDb();
    seedVideo(db, "v_a");
    seedVideo(db, "v_b");

    const enqueue = (video_id: string, kind: "image" | "clip", status: "pending" | "dispatched" | "done" | "failed") => {
      const id = gfRepo.enqueueTask(db, {
        video_id, chunk_id: "c", kind, mode: "createImage",
        prompt: "p", output_path: "x", priority: 0, created_at: 1,
      });
      if (status !== "pending") {
        db.prepare("UPDATE google_flow_queue SET status = ? WHERE id = ?").run(status, id);
      }
    };
    enqueue("v_a", "image", "pending");
    enqueue("v_a", "image", "pending");
    enqueue("v_a", "image", "done");
    enqueue("v_a", "image", "failed");
    enqueue("v_a", "image", "dispatched");
    enqueue("v_a", "clip", "pending"); // excluded by kind
    enqueue("v_b", "image", "pending"); // excluded by video

    expect(gfRepo.countByStatusForVideo(db, "v_a", "image")).toEqual({
      pending: 2,
      dispatched: 1,
      done: 1,
      failed: 1,
    });
  });

  it("listFailedForVideo returns only failed rows for the video", () => {
    const db = freshDb();
    seedVideo(db);
    const failedId = gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c1", kind: "image", mode: "createImage",
      prompt: "p", output_path: "x", priority: 0, created_at: 1,
    });
    gfRepo.failTask(db, failedId, "policy");
    gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c2", kind: "image", mode: "createImage",
      prompt: "p", output_path: "y", priority: 0, created_at: 2,
    });
    const rows = gfRepo.listFailedForVideo(db, "v_1");
    expect(rows.map((r) => r.id)).toEqual([failedId]);
    expect(rows[0].error_reason).toBe("policy");
  });

  it("resetAllDispatchedOnStartup flips every dispatched row to pending", () => {
    const db = freshDb();
    seedVideo(db, "v_a");
    seedVideo(db, "v_b");
    seedAccount(db);

    const ids: number[] = [];
    for (const v of ["v_a", "v_b"]) {
      for (const c of ["c1", "c2"]) {
        ids.push(
          gfRepo.enqueueTask(db, {
            video_id: v, chunk_id: c, kind: "image", mode: "createImage",
            prompt: "p", output_path: `${v}/${c}.png`, priority: 0, created_at: 1,
          })
        );
      }
    }
    // Claim all four — spread across videos.
    gfRepo.takeNextTaskForAccount(db, "acc_01", 100);
    gfRepo.takeNextTaskForAccount(db, "acc_01", 101);
    gfRepo.takeNextTaskForAccount(db, "acc_01", 102);
    gfRepo.takeNextTaskForAccount(db, "acc_01", 103);

    gfRepo.resetAllDispatchedOnStartup(db);

    for (const id of ids) {
      const row = gfRepo.findTaskById(db, id)!;
      expect(row.status).toBe("pending");
      expect(row.assigned_account_id).toBeNull();
      expect(row.external_task_id).toBeNull();
      expect(row.dispatched_at).toBeNull();
    }
  });

  it("listStaleDispatched returns rows whose dispatched_at is older than the cutoff", () => {
    const db = freshDb();
    seedVideo(db);
    seedAccount(db);

    gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c1", kind: "image", mode: "createImage",
      prompt: "p", output_path: "x1", priority: 0, created_at: 1,
    });
    gfRepo.enqueueTask(db, {
      video_id: "v_1", chunk_id: "c2", kind: "image", mode: "createImage",
      prompt: "p", output_path: "x2", priority: 0, created_at: 2,
    });

    gfRepo.takeNextTaskForAccount(db, "acc_01", 1_000_000); // stale
    gfRepo.takeNextTaskForAccount(db, "acc_01", 1_999_999); // fresh

    // Cutoff: 30 min = 1800s. Now: 2_000_000. Anything dispatched before
    // 1_998_200 is stale.
    const stale = gfRepo.listStaleDispatched(db, 1800, 2_000_000);
    expect(stale.map((r) => r.dispatched_at)).toEqual([1_000_000]);
  });
});

describe("google-flow repo — video projects", () => {
  function seedVideo(db: DatabaseType, id = "v_1") {
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, "V", "info", "google-flow", "in_progress", 1);
  }

  function seedAccount(db: DatabaseType, id = "acc_01") {
    gfRepo.insertAccount(db, { id, name: id, token: `tok_${id}`, created_at: 1 });
  }

  it("findFlowProjectForAccount returns undefined when no row exists", () => {
    const db = freshDb();
    seedVideo(db);
    seedAccount(db);
    expect(
      gfRepo.findFlowProjectForAccount(db, "v_1", "acc_01")
    ).toBeUndefined();
  });

  it("upsertFlowProjectForAccount on first call inserts and returns {inserted:true}", () => {
    const db = freshDb();
    seedVideo(db);
    seedAccount(db);

    const result = gfRepo.upsertFlowProjectForAccount(
      db,
      "v_1",
      "acc_01",
      "proj-1",
      100
    );

    expect(result).toEqual({ inserted: true, existingProjectId: null });
    const row = gfRepo.findFlowProjectForAccount(db, "v_1", "acc_01")!;
    expect(row).toMatchObject({
      video_id: "v_1",
      account_id: "acc_01",
      flow_project_id: "proj-1",
      created_at: 100,
    });
  });

  it("upsertFlowProjectForAccount idempotent on repost with same id", () => {
    const db = freshDb();
    seedVideo(db);
    seedAccount(db);
    gfRepo.upsertFlowProjectForAccount(db, "v_1", "acc_01", "proj-1", 100);

    const result = gfRepo.upsertFlowProjectForAccount(
      db,
      "v_1",
      "acc_01",
      "proj-1",
      200
    );

    expect(result).toEqual({ inserted: false, existingProjectId: "proj-1" });
    // created_at preserved from first write.
    expect(gfRepo.findFlowProjectForAccount(db, "v_1", "acc_01")?.created_at).toBe(
      100
    );
  });

  it("upsertFlowProjectForAccount first-writer-wins on different id", () => {
    const db = freshDb();
    seedVideo(db);
    seedAccount(db);
    gfRepo.upsertFlowProjectForAccount(db, "v_1", "acc_01", "proj-1", 100);

    const result = gfRepo.upsertFlowProjectForAccount(
      db,
      "v_1",
      "acc_01",
      "proj-2",
      200
    );

    expect(result).toEqual({ inserted: false, existingProjectId: "proj-1" });
    expect(gfRepo.findFlowProjectForAccount(db, "v_1", "acc_01")?.flow_project_id).toBe(
      "proj-1"
    );
  });

  it("clearFlowProjectForAccount removes the row for (video, account)", () => {
    const db = freshDb();
    seedVideo(db);
    seedAccount(db);
    gfRepo.upsertFlowProjectForAccount(db, "v_1", "acc_01", "proj-1", 100);

    gfRepo.clearFlowProjectForAccount(db, "v_1", "acc_01");

    expect(
      gfRepo.findFlowProjectForAccount(db, "v_1", "acc_01")
    ).toBeUndefined();
  });

  it("clearFlowProjectForAccount on a non-existent (video, account) is a no-op", () => {
    const db = freshDb();
    seedVideo(db);
    seedAccount(db);
    expect(() =>
      gfRepo.clearFlowProjectForAccount(db, "v_1", "acc_01")
    ).not.toThrow();
  });

  it("listFlowProjectsForVideo returns all per-account rows for the video", () => {
    const db = freshDb();
    seedVideo(db, "v_1");
    seedVideo(db, "v_2");
    seedAccount(db, "acc_a");
    seedAccount(db, "acc_b");
    gfRepo.upsertFlowProjectForAccount(db, "v_1", "acc_a", "proj-a", 100);
    gfRepo.upsertFlowProjectForAccount(db, "v_1", "acc_b", "proj-b", 101);
    // unrelated row on a different video — must not be returned.
    gfRepo.upsertFlowProjectForAccount(db, "v_2", "acc_a", "proj-other", 102);

    const rows = gfRepo.listFlowProjectsForVideo(db, "v_1");

    expect(rows.map((r) => r.account_id).sort()).toEqual(["acc_a", "acc_b"]);
    expect(rows.map((r) => r.flow_project_id).sort()).toEqual([
      "proj-a",
      "proj-b",
    ]);
  });

  it("hard-deleting a video cascades the rows", () => {
    const db = freshDb();
    seedVideo(db, "v_1");
    seedAccount(db, "acc_a");
    seedAccount(db, "acc_b");
    gfRepo.upsertFlowProjectForAccount(db, "v_1", "acc_a", "proj-a", 100);
    gfRepo.upsertFlowProjectForAccount(db, "v_1", "acc_b", "proj-b", 101);

    db.prepare("DELETE FROM videos WHERE id = ?").run("v_1");

    expect(gfRepo.listFlowProjectsForVideo(db, "v_1")).toEqual([]);
  });

  it("hard-deleting an account leaves rows in place (orphan-by-design)", () => {
    const db = freshDb();
    seedVideo(db);
    seedAccount(db, "acc_01");
    gfRepo.upsertFlowProjectForAccount(db, "v_1", "acc_01", "proj-1", 100);

    gfRepo.deleteAccount(db, "acc_01");

    expect(gfRepo.findFlowProjectForAccount(db, "v_1", "acc_01")).toMatchObject({
      flow_project_id: "proj-1",
    });
  });
});

describe("createDb — videos.deferred_until migration", () => {
  it("adds the deferred_until column on fresh DB", () => {
    const db = newDb();
    try {
      const cols = db
        .prepare("PRAGMA table_info(videos)")
        .all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("deferred_until");
    } finally {
      db.close();
    }
  });

  it("adds deferred_until to a legacy videos table that predates it", async () => {
    // Build a pre-defer schema by hand, then open with createDb which ALTERs.
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "histforge-defer-test-"));
    const path = join(dir, "legacy.db");
    const raw = new (require("better-sqlite3"))(path);
    try {
      raw.exec(`
        CREATE TABLE videos (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, topic_info TEXT NOT NULL,
          workflow_id TEXT NOT NULL, status TEXT NOT NULL,
          current_step TEXT, failed_step TEXT, failed_reason TEXT,
          started_at INTEGER, finished_at INTEGER, output_path TEXT,
          delete_requested INTEGER NOT NULL DEFAULT 0,
          paused INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
      `);
      raw
        .prepare(
          "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("v_legacy", "Legacy", "info", "comfyui", "queued", 1);
    } finally {
      raw.close();
    }

    const db = createDb(path);
    try {
      const cols = db
        .prepare("PRAGMA table_info(videos)")
        .all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("deferred_until");
      const row = db
        .prepare("SELECT deferred_until FROM videos WHERE id = ?")
        .get("v_legacy") as { deferred_until: number | null };
      expect(row.deferred_until).toBeNull();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createDb — google_flow_queue", () => {
  function seedVideoAndAccount(db: ReturnType<typeof newDb>) {
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("v_1", "V", "info", "google-flow", "in_progress", 1);
    db.prepare(
      "INSERT INTO google_flow_accounts (id, name, token, created_at) VALUES (?, ?, ?, ?)"
    ).run("acc_01", "Alpha", "tok1", 1);
  }

  it("creates the google_flow_queue table with the spec columns", () => {
    const db = newDb();
    try {
      const cols = db
        .prepare("PRAGMA table_info(google_flow_queue)")
        .all() as Array<{ name: string; notnull: number; dflt_value: string | null; pk: number }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

      expect(byName.id).toMatchObject({ pk: 1 });
      expect(byName.video_id).toMatchObject({ notnull: 1 });
      expect(byName.kind).toMatchObject({ notnull: 1 });
      expect(byName.mode).toMatchObject({ notnull: 1 });
      expect(byName.prompt).toMatchObject({ notnull: 1 });
      expect(byName.output_path).toMatchObject({ notnull: 1 });
      expect(byName.status).toMatchObject({ notnull: 1 });
      expect(byName.retry_count).toMatchObject({ notnull: 1, dflt_value: "0" });
      expect(byName.priority).toMatchObject({ notnull: 1, dflt_value: "0" });
      expect(byName.created_at).toMatchObject({ notnull: 1 });
    } finally {
      db.close();
    }
  });

  it("has an index on (status, priority, id)", () => {
    const db = newDb();
    try {
      const idxList = db
        .prepare("PRAGMA index_list(google_flow_queue)")
        .all() as Array<{ name: string }>;
      const idxCols = idxList.flatMap((i) =>
        (
          db.prepare(`PRAGMA index_info(${i.name})`).all() as Array<{ name: string }>
        ).map((c) => c.name)
      );
      // At least one index covers these three columns in order.
      expect(idxCols.slice(0, 3)).toEqual(["status", "priority", "id"]);
    } finally {
      db.close();
    }
  });

  it("cascades deletes when the parent video is removed", () => {
    const db = newDb();
    try {
      seedVideoAndAccount(db);
      db.prepare(
        `INSERT INTO google_flow_queue
           (video_id, kind, mode, prompt, output_path, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("v_1", "image", "createImage", "p", "images/c1.png", "pending", 1);

      db.prepare("DELETE FROM videos WHERE id = ?").run("v_1");
      const rows = db
        .prepare("SELECT * FROM google_flow_queue WHERE video_id = ?")
        .all("v_1");
      expect(rows).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("sets assigned_account_id to NULL when the account is deleted", () => {
    const db = newDb();
    try {
      seedVideoAndAccount(db);
      db.prepare(
        `INSERT INTO google_flow_queue
           (video_id, kind, mode, prompt, output_path, status, assigned_account_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("v_1", "image", "createImage", "p", "images/c1.png", "dispatched", "acc_01", 1);

      db.prepare("DELETE FROM google_flow_accounts WHERE id = ?").run("acc_01");
      const row = db
        .prepare("SELECT assigned_account_id, status FROM google_flow_queue WHERE video_id = ?")
        .get("v_1") as { assigned_account_id: string | null; status: string };
      expect(row.assigned_account_id).toBeNull();
      // Row is preserved (not cascaded) — only the reference is nulled.
      expect(row.status).toBe("dispatched");
    } finally {
      db.close();
    }
  });
});
