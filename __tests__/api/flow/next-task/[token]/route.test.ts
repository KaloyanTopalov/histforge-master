import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-flow-next-task-"));
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
});

interface AccountSeed {
  id?: string;
  name?: string;
  token: string;
  enabled?: 0 | 1;
  paused_until?: number | null;
}

async function seedAccount(seed: AccountSeed): Promise<string> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const id = seed.id ?? "acc_01";
  db.prepare(
    `INSERT INTO google_flow_accounts (id, name, token,
        paused_until, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    seed.name ?? "acc1",
    seed.token,
    seed.paused_until ?? null,
    seed.enabled ?? 1,
    Math.floor(Date.now() / 1000)
  );
  return id;
}

async function seedVideo(id: string): Promise<void> {
  const { getDb } = await import("@/lib/db");
  getDb()
    .prepare(
      `INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?)`
    )
    .run(id, "T", "info", "google-flow", Date.now());
}

async function enqueue(row: {
  video_id: string;
  chunk_id?: string | null;
  kind: "image" | "clip";
  mode: "createImage" | "text" | "image" | "frames";
  prompt: string;
  output_path: string;
  reference_image?: string | null;
  start_frame?: string | null;
  end_frame?: string | null;
}): Promise<number> {
  const gfRepo = await import("@/lib/repos/google-flow");
  const { getDb } = await import("@/lib/db");
  return gfRepo.enqueueTask(getDb(), {
    video_id: row.video_id,
    chunk_id: row.chunk_id ?? null,
    kind: row.kind,
    mode: row.mode,
    prompt: row.prompt,
    output_path: row.output_path,
    reference_image: row.reference_image ?? null,
    start_frame: row.start_frame ?? null,
    end_frame: row.end_frame ?? null,
    created_at: Math.floor(Date.now() / 1000),
  });
}

function callNextTask(token: string, body: unknown): Promise<Response> {
  return import("@/app/api/flow/next-task/[token]/route").then(({ POST }) =>
    POST(
      new Request(`http://localhost/api/flow/next-task/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: { token } }
    )
  );
}

describe("POST /api/flow/next-task/:token", () => {
  it("401s when the URL token differs from the body accountToken", async () => {
    await seedAccount({ token: "T-body" });
    const res = await callNextTask("T-url", {
      type: "TaskRequest",
      accountToken: "T-body",
      mode: "createImage",
    });
    expect(res.status).toBe(401);
  });

  it("404s when no account has the token", async () => {
    const res = await callNextTask("T-nope", {
      type: "TaskRequest",
      accountToken: "T-nope",
      mode: "createImage",
    });
    expect(res.status).toBe(404);
  });

  it("403s when the account is disabled, but still bumps last_seen_at", async () => {
    await seedAccount({ token: "T-off", enabled: 0 });
    const res = await callNextTask("T-off", {
      type: "TaskRequest",
      accountToken: "T-off",
      mode: "createImage",
    });
    expect(res.status).toBe(403);

    // Liveness: a disabled Chrome profile is still an operational
    // signal — the dashboard needs to see it's alive even if we won't
    // dispatch to it.
    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT last_seen_at FROM google_flow_accounts WHERE token = ?"
      )
      .get("T-off") as { last_seen_at: number | null };
    expect(row.last_seen_at).not.toBeNull();
  });

  it("returns empty body + Retry-After when paused_until is still in the future", async () => {
    const now = Math.floor(Date.now() / 1000);
    const future = now + 60;
    await seedAccount({ token: "T-paused", paused_until: future });

    const res = await callNextTask("T-paused", {
      type: "TaskRequest",
      accountToken: "T-paused",
      mode: "createImage",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);

    // last_seen_at was still updated even on empty return.
    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT last_seen_at FROM google_flow_accounts WHERE token = ?"
      )
      .get("T-paused") as { last_seen_at: number | null };
    expect(row.last_seen_at).not.toBeNull();
  });

  it("clears paused_until when pause has elapsed", async () => {
    const now = Math.floor(Date.now() / 1000);
    const past = now - 60;
    await seedAccount({ token: "T-resume", paused_until: past });
    await seedVideo("vid_r");
    await enqueue({
      video_id: "vid_r",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p1",
      output_path: "images/c1.png",
    });

    const res = await callNextTask("T-resume", {
      type: "TaskRequest",
      accountToken: "T-resume",
      mode: "createImage",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBeDefined();

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT paused_until FROM google_flow_accounts WHERE token = ?"
      )
      .get("T-resume") as { paused_until: number | null };
    expect(row.paused_until).toBeNull();
  });

  it("dispatches a createImage task with prompt duplicated into imagePrompt, clears relogin flag", async () => {
    await seedAccount({ token: "T-ok" });
    await seedVideo("vid_ok");
    const taskRowId = await enqueue({
      video_id: "vid_ok",
      chunk_id: "chunk_01",
      kind: "image",
      mode: "createImage",
      prompt: "a Roman aqueduct at sunset",
      output_path: "images/chunk_01.png",
    });
    const { setSetting } = await import("@/lib/settings");
    setSetting("google_flow_relogin_needed", true);

    const res = await callNextTask("T-ok", {
      type: "TaskRequest",
      accountToken: "T-ok",
      mode: "createImage",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: String(taskRowId).length > 0 ? expect.any(String) : undefined,
      prompt: "a Roman aqueduct at sunset",
      imagePrompt: "a Roman aqueduct at sunset",
      mode: "createImage",
    });
    // No bleed of optional fields for createImage.
    expect(body.referenceImage).toBeUndefined();
    expect(body.startFrame).toBeUndefined();
    expect(body.endFrame).toBeUndefined();

    const { getDb } = await import("@/lib/db");
    const dbInstance = getDb();
    const queue = dbInstance
      .prepare(
        "SELECT status, assigned_account_id, external_task_id FROM google_flow_queue WHERE id = ?"
      )
      .get(taskRowId) as {
      status: string;
      assigned_account_id: string;
      external_task_id: string;
    };
    expect(queue.status).toBe("dispatched");
    expect(queue.assigned_account_id).toBe("acc_01");
    expect(queue.external_task_id).toMatch(/^\d+_\d+$/);
    expect(body.id).toBe(queue.external_task_id);

    const { getSetting } = await import("@/lib/settings");
    expect(getSetting("google_flow_relogin_needed")).toBe(false);
  });

  it("emits a referenceImage URL for createImage when reference_image is set on the row (phase A step 3)", async () => {
    // When the worker found a per-video character_reference.png at
    // enqueue time, it sets reference_image to the relative path. The
    // dispatch route must project this into an absolute artifact URL
    // the youforge-flow extension can GET. Mirrors Magnific's pattern.
    await seedAccount({ token: "T-ref" });
    await seedVideo("vid_ref");
    await enqueue({
      video_id: "vid_ref",
      chunk_id: "img_ref",
      kind: "image",
      mode: "createImage",
      prompt: "scene with character",
      reference_image: "character_reference.png",
      output_path: "images/img_ref.png",
    });

    const res = await callNextTask("T-ref", {
      type: "TaskRequest",
      accountToken: "T-ref",
      mode: "createImage",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // URL is bound to (token, external_task_id) so the artifact route
    // can verify the calling account owns the dispatched task.
    expect(body.referenceImage).toMatch(
      /^http:\/\/localhost\/api\/flow\/artifact\/T-ref\/\d+_\d+$/
    );
    // Sanity: no leaked path/videoId in the URL — the artifact route
    // resolves them from the task lookup.
    expect(body.referenceImage).not.toContain("path=");
    expect(body.referenceImage).not.toContain("videoId=");
    // The legacy imagePrompt mirror still fires.
    expect(body.imagePrompt).toBe("scene with character");
  });

  it("omits referenceImage on createImage when reference_image is null (no per-video reference uploaded)", async () => {
    // Default state: operator hasn't uploaded a character_reference.png
    // for this video. The artifact URL has nothing to point at, so we
    // simply don't emit the field. The extension treats absence as
    // "text-only generation" (its existing branch).
    await seedAccount({ token: "T-noref" });
    await seedVideo("vid_noref");
    await enqueue({
      video_id: "vid_noref",
      chunk_id: "img_noref",
      kind: "image",
      mode: "createImage",
      prompt: "scene without character",
      output_path: "images/img_noref.png",
      // reference_image omitted → null in DB
    });

    const res = await callNextTask("T-noref", {
      type: "TaskRequest",
      accountToken: "T-noref",
      mode: "createImage",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.referenceImage).toBeUndefined();
    expect(body.imagePrompt).toBe("scene without character");
  });

  it("routes the claim to the requested bucket when wantBucket='image' is set", async () => {
    // wantBucket scopes the dispatch to a single concurrency bucket so a
    // free image slot can't claim a higher-priority video row (which would
    // re-create the starvation the split was introduced to fix).
    await seedAccount({ token: "T-bucket" });
    await seedVideo("vid_b");
    const hookVideoId = await enqueue({
      video_id: "vid_b",
      chunk_id: "c1",
      kind: "clip",
      mode: "text",
      prompt: "video prompt",
      output_path: "videos/clip/c1.mp4",
    });
    const mainImageId = await enqueue({
      video_id: "vid_b",
      chunk_id: "c2",
      kind: "image",
      mode: "createImage",
      prompt: "image prompt",
      output_path: "images/c2.png",
    });

    const res = await callNextTask("T-bucket", {
      type: "TaskRequest",
      accountToken: "T-bucket",
      mode: "createImage",
      wantBucket: "image",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("createImage");
    expect(body.prompt).toBe("image prompt");

    const { getDb } = await import("@/lib/db");
    const rows = getDb()
      .prepare(
        "SELECT id, status FROM google_flow_queue ORDER BY id ASC"
      )
      .all() as Array<{ id: number; status: string }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(byId[mainImageId]).toBe("dispatched");
    expect(byId[hookVideoId]).toBe("pending");
  });

  it("rejects wantBucket values outside of 'image'|'video' with 400", async () => {
    await seedAccount({ token: "T-badbucket" });
    const res = await callNextTask("T-badbucket", {
      type: "TaskRequest",
      accountToken: "T-badbucket",
      mode: "createImage",
      wantBucket: "audio",
    });
    expect(res.status).toBe(400);
  });

  it("skips the settings write for google_flow_relogin_needed when the flag is already false", async () => {
    // The flag-clear on every dispatch is correct behavior; the bug is
    // that an unconditional setSetting issues a redundant INSERT INTO
    // settings UPSERT inside the dispatch transaction on every claim,
    // even when the value is already false (the steady-state default).
    await seedAccount({ token: "T-guard" });
    await seedVideo("vid_guard");
    await enqueue({
      video_id: "vid_guard",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
    });

    const { getDb } = await import("@/lib/db");
    const { getSetting } = await import("@/lib/settings");
    const db = getDb();
    expect(getSetting("google_flow_relogin_needed")).toBe(false);

    // Instrument better-sqlite3 (npm boundary) to capture every parametrized
    // INSERT INTO settings, so the guard fix is observable without inspecting
    // SQLite's write-ahead log.
    const settingsWrites: unknown[][] = [];
    const originalPrepare = db.prepare.bind(db);
    const spy = vi
      .spyOn(db, "prepare")
      .mockImplementation((sql: string) => {
        const stmt = originalPrepare(sql);
        if (sql.includes("INSERT INTO settings")) {
          const originalRun = stmt.run.bind(stmt);
          (stmt as unknown as { run: (...args: unknown[]) => unknown }).run =
            (...params: unknown[]) => {
              settingsWrites.push(params);
              return originalRun(...(params as [])) as unknown;
            };
        }
        return stmt;
      });

    try {
      const res = await callNextTask("T-guard", {
        type: "TaskRequest",
        accountToken: "T-guard",
        mode: "createImage",
      });
      expect(res.status).toBe(200);
    } finally {
      spy.mockRestore();
    }

    const writesForFlag = settingsWrites.filter(
      (params) => params[0] === "google_flow_relogin_needed"
    );
    expect(writesForFlag).toEqual([]);
    // End-state preserved.
    expect(getSetting("google_flow_relogin_needed")).toBe(false);
  });

  it("shapes the response per mode (text/image/frames)", async () => {
    await seedAccount({ token: "T-mode" });
    await seedVideo("vid_m");

    // text: no extra fields.
    await enqueue({
      video_id: "vid_m",
      chunk_id: "h1",
      kind: "clip",
      mode: "text",
      prompt: "text prompt",
      output_path: "videos/clip/h1.mp4",
    });
    let body: Record<string, unknown> = await (await callNextTask("T-mode", {
      type: "TaskRequest",
      accountToken: "T-mode",
      mode: "text",
    })).json();
    expect(body).toMatchObject({ prompt: "text prompt", mode: "text" });
    expect(body.imagePrompt).toBeUndefined();
    expect(body.referenceImage).toBeUndefined();

    // image: + referenceImage.
    await enqueue({
      video_id: "vid_m",
      chunk_id: "h2",
      kind: "clip",
      mode: "image",
      prompt: "image-mode prompt",
      output_path: "videos/clip/h2.mp4",
      reference_image: "https://storage.googleapis.com/ref/x.png",
    });
    body = await (await callNextTask("T-mode", {
      type: "TaskRequest",
      accountToken: "T-mode",
      mode: "image",
    })).json();
    expect(body).toMatchObject({
      mode: "image",
      referenceImage: "https://storage.googleapis.com/ref/x.png",
    });
    expect(body.startFrame).toBeUndefined();

    // frames: + startFrame + endFrame.
    await enqueue({
      video_id: "vid_m",
      chunk_id: "h3",
      kind: "clip",
      mode: "frames",
      prompt: "frames-mode prompt",
      output_path: "videos/clip/h3.mp4",
      start_frame: "https://storage.googleapis.com/sf.png",
      end_frame: "https://storage.googleapis.com/ef.png",
    });
    body = await (await callNextTask("T-mode", {
      type: "TaskRequest",
      accountToken: "T-mode",
      mode: "frames",
    })).json();
    expect(body).toMatchObject({
      mode: "frames",
      startFrame: "https://storage.googleapis.com/sf.png",
      endFrame: "https://storage.googleapis.com/ef.png",
    });
  });

  it("includes mode-specific fields unconditionally (null surfaces, doesn't silently vanish)", async () => {
    // A mode=image row enqueued without a reference_image is a bug —
    // but if one slips through, the response must still include the
    // key so the extension validator rejects loudly.
    await seedAccount({ token: "T-null" });
    await seedVideo("vid_null");
    await enqueue({
      video_id: "vid_null",
      chunk_id: "broken",
      kind: "clip",
      mode: "image",
      prompt: "image-mode prompt",
      output_path: "videos/clip/broken.mp4",
      // reference_image omitted → null in DB
    });
    const body = await (await callNextTask("T-null", {
      type: "TaskRequest",
      accountToken: "T-null",
      mode: "image",
    })).json();
    expect(body).toHaveProperty("referenceImage");
    expect(body.referenceImage).toBeNull();
  });

  it("returns empty body (no Retry-After) when recovery_reason is set, even with a dispatchable row", async () => {
    // Operator-gated recovery (ADR-0003): unlike paused_until, the flag
    // can't clear with elapsed time. The dispatch gate intentionally
    // omits Retry-After so the extension's empty-response handling
    // treats the response as "no work right now" — the dashboard
    // banner is what surfaces the actual reason.
    await seedAccount({ token: "T-recovery" });
    await seedVideo("vid_rec");
    const taskId = await enqueue({
      video_id: "vid_rec",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
    });

    const { getDb } = await import("@/lib/db");
    const gfRepo = await import("@/lib/repos/google-flow");
    gfRepo.setAccountRecoveryReason(
      getDb(),
      "acc_01",
      "captcha",
      Math.floor(Date.now() / 1000)
    );

    const res = await callNextTask("T-recovery", {
      type: "TaskRequest",
      accountToken: "T-recovery",
      mode: "createImage",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(res.headers.get("Retry-After")).toBeNull();

    // Row was NOT claimed — it stays pending.
    const row = getDb()
      .prepare(
        "SELECT status, assigned_account_id FROM google_flow_queue WHERE id = ?"
      )
      .get(taskId) as { status: string; assigned_account_id: string | null };
    expect(row.status).toBe("pending");
    expect(row.assigned_account_id).toBeNull();
  });

  it("recovery_reason wins over a paused_until in the past (no auto-resume from inside next-task)", async () => {
    // Per ADR-0003 §4 "first match wins" — the recovery gate sits
    // BEFORE the paused_until clearance, so a stale past paused_until
    // must not trigger the resume-and-claim path while recovery_reason
    // is still set.
    const now = Math.floor(Date.now() / 1000);
    await seedAccount({ token: "T-rec-past", paused_until: now - 60 });
    await seedVideo("vid_recp");
    const taskId = await enqueue({
      video_id: "vid_recp",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
    });

    const { getDb } = await import("@/lib/db");
    const gfRepo = await import("@/lib/repos/google-flow");
    gfRepo.setAccountRecoveryReason(getDb(), "acc_01", "captcha", now);

    const res = await callNextTask("T-rec-past", {
      type: "TaskRequest",
      accountToken: "T-rec-past",
      mode: "createImage",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});

    // recovery_reason is unchanged — next-task does NOT auto-clear it.
    const acct = getDb()
      .prepare(
        "SELECT recovery_reason, paused_until FROM google_flow_accounts WHERE token = ?"
      )
      .get("T-rec-past") as {
      recovery_reason: string | null;
      paused_until: number | null;
    };
    expect(acct.recovery_reason).toBe("captcha");
    // paused_until was NOT cleared either — the resume path is below
    // the recovery gate, so we never reach it.
    expect(acct.paused_until).toBe(now - 60);

    // Task remains pending.
    const row = getDb()
      .prepare("SELECT status FROM google_flow_queue WHERE id = ?")
      .get(taskId) as { status: string };
    expect(row.status).toBe("pending");
  });

  it("dispatch resumes normally after clearAccountRecovery is called", async () => {
    // The recovery gate is fully reversible: clear the flag and the
    // next claim flows through to dispatch like any other account.
    await seedAccount({ token: "T-rec-cleared" });
    await seedVideo("vid_recc");
    const taskId = await enqueue({
      video_id: "vid_recc",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
    });

    const { getDb } = await import("@/lib/db");
    const gfRepo = await import("@/lib/repos/google-flow");
    gfRepo.setAccountRecoveryReason(
      getDb(),
      "acc_01",
      "captcha",
      Math.floor(Date.now() / 1000)
    );
    // Blocked first.
    let res = await callNextTask("T-rec-cleared", {
      type: "TaskRequest",
      accountToken: "T-rec-cleared",
      mode: "createImage",
    });
    expect(await res.json()).toEqual({});

    gfRepo.clearAccountRecovery(getDb(), "acc_01");

    // Unblocked second.
    res = await callNextTask("T-rec-cleared", {
      type: "TaskRequest",
      accountToken: "T-rec-cleared",
      mode: "createImage",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBeDefined();

    const row = getDb()
      .prepare("SELECT status FROM google_flow_queue WHERE id = ?")
      .get(taskId) as { status: string };
    expect(row.status).toBe("dispatched");
  });

  it("queue_state='paused' still wins over recovery_reason (queue pause is global, first gate)", async () => {
    // Order of gates: queue paused → recovery → time-paused. A globally
    // paused queue must short-circuit before the recovery branch (this
    // is just an ordering sanity check; the observable effect is the
    // same empty body either way, but it documents the intended order).
    await seedAccount({ token: "T-both" });
    await seedVideo("vid_both");
    await enqueue({
      video_id: "vid_both",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
    });

    const { getDb } = await import("@/lib/db");
    const gfRepo = await import("@/lib/repos/google-flow");
    gfRepo.setAccountRecoveryReason(
      getDb(),
      "acc_01",
      "captcha",
      Math.floor(Date.now() / 1000)
    );
    const { setSetting } = await import("@/lib/settings");
    setSetting("queue_state", "paused");

    const res = await callNextTask("T-both", {
      type: "TaskRequest",
      accountToken: "T-both",
      mode: "createImage",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("returns empty body when queue_state='paused', even with a dispatchable row", async () => {
    await seedAccount({ token: "T-global-paused" });
    await seedVideo("vid_gp");
    const taskId = await enqueue({
      video_id: "vid_gp",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
    });

    const { setSetting } = await import("@/lib/settings");
    setSetting("queue_state", "paused");

    const res = await callNextTask("T-global-paused", {
      type: "TaskRequest",
      accountToken: "T-global-paused",
      mode: "createImage",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});

    // Row was NOT claimed — it stays pending.
    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT status, assigned_account_id FROM google_flow_queue WHERE id = ?")
      .get(taskId) as { status: string; assigned_account_id: string | null };
    expect(row.status).toBe("pending");
    expect(row.assigned_account_id).toBeNull();
  });

  it("skips paused videos but still dispatches other videos' rows", async () => {
    await seedAccount({ token: "T-pv" });
    await seedVideo("vid_paused");
    await seedVideo("vid_live");
    await enqueue({
      video_id: "vid_paused",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "paused prompt",
      output_path: "images/c1.png",
    });
    const liveId = await enqueue({
      video_id: "vid_live",
      chunk_id: "c2",
      kind: "image",
      mode: "createImage",
      prompt: "live prompt",
      output_path: "images/c2.png",
    });

    const { getDb } = await import("@/lib/db");
    getDb().prepare("UPDATE videos SET paused = 1 WHERE id = ?").run("vid_paused");

    const res = await callNextTask("T-pv", {
      type: "TaskRequest",
      accountToken: "T-pv",
      mode: "createImage",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prompt).toBe("live prompt");

    // The live row is dispatched; the paused row is untouched.
    const rows = getDb()
      .prepare("SELECT video_id, status FROM google_flow_queue ORDER BY id")
      .all() as Array<{ video_id: string; status: string }>;
    expect(rows).toEqual([
      { video_id: "vid_paused", status: "pending" },
      { video_id: "vid_live", status: "dispatched" },
    ]);
    expect(liveId).toBeGreaterThan(0);
  });

  it("returns empty body when no pending task, still updating last_seen_at", async () => {
    await seedAccount({ token: "T-empty" });
    const res = await callNextTask("T-empty", {
      type: "TaskRequest",
      accountToken: "T-empty",
      mode: "createImage",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT last_seen_at FROM google_flow_accounts WHERE token = ?"
      )
      .get("T-empty") as { last_seen_at: number | null };
    expect(row.last_seen_at).not.toBeNull();
  });

  it("rejects a body missing required fields with 400", async () => {
    await seedAccount({ token: "T-bad" });
    const res = await callNextTask("T-bad", { type: "TaskRequest" });
    expect(res.status).toBe(400);
  });

  it("includes flowProjectId from the (video, account) row when present", async () => {
    const accId = await seedAccount({ token: "T-proj" });
    await seedVideo("vid_p");
    await enqueue({
      video_id: "vid_p",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p1",
      output_path: "images/c1.png",
    });
    const gfRepo = await import("@/lib/repos/google-flow");
    const { getDb } = await import("@/lib/db");
    gfRepo.upsertFlowProjectForAccount(
      getDb(),
      "vid_p",
      accId,
      "proj-A",
      Math.floor(Date.now() / 1000)
    );

    const res = await callNextTask("T-proj", {
      type: "TaskRequest",
      accountToken: "T-proj",
      mode: "createImage",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flowProjectId).toBe("proj-A");
    expect(body.videoId).toBe("vid_p");
    expect(body.projectTitle).toBe("T");
  });

  it("includes flowProjectId: null when no (video, claiming account) mapping exists", async () => {
    await seedAccount({ token: "T-noproj" });
    await seedVideo("vid_n");
    await enqueue({
      video_id: "vid_n",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p1",
      output_path: "images/c1.png",
    });

    const res = await callNextTask("T-noproj", {
      type: "TaskRequest",
      accountToken: "T-noproj",
      mode: "createImage",
    });
    const body = await res.json();
    expect(body.flowProjectId).toBeNull();
    expect(body.videoId).toBe("vid_n");
    expect(body.projectTitle).toBe("T");
  });

  it("includes flowProjectId: null even when a mapping exists for a different account", async () => {
    // Cross-account isolation: A must not receive B's projectId.
    await seedAccount({ id: "acc_a", token: "T-A" });
    const bId = "acc_b";
    const { getDb } = await import("@/lib/db");
    getDb()
      .prepare(
        `INSERT INTO google_flow_accounts (id, name, token, enabled, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(bId, "B", "T-B", 1, Math.floor(Date.now() / 1000));
    await seedVideo("vid_iso");
    await enqueue({
      video_id: "vid_iso",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p1",
      output_path: "images/c1.png",
    });
    const gfRepo = await import("@/lib/repos/google-flow");
    gfRepo.upsertFlowProjectForAccount(
      getDb(),
      "vid_iso",
      bId,
      "proj-B",
      Math.floor(Date.now() / 1000)
    );

    // Account A claims the task — must not see B's project id.
    const res = await callNextTask("T-A", {
      type: "TaskRequest",
      accountToken: "T-A",
      mode: "createImage",
    });
    const body = await res.json();
    expect(body.flowProjectId).toBeNull();
    expect(body.videoId).toBe("vid_iso");
  });

  it("emits imageModel + videoModel with seeded defaults on a createImage dispatch", async () => {
    await seedAccount({ token: "T-img-model" });
    await seedVideo("vid_im");
    await enqueue({
      video_id: "vid_im",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "a Roman bridge",
      output_path: "images/c1.png",
    });

    const res = await callNextTask("T-img-model", {
      type: "TaskRequest",
      accountToken: "T-img-model",
      mode: "createImage",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imageModel).toBe("NARWHAL");
    expect(body.videoModel).toBe("veo_3_1_t2v_lite_low_priority");
  });

  it("emits imageModel + videoModel on a text-mode dispatch too (mode-independent)", async () => {
    await seedAccount({ token: "T-vid-model" });
    await seedVideo("vid_vm");
    await enqueue({
      video_id: "vid_vm",
      chunk_id: "h1",
      kind: "clip",
      mode: "text",
      prompt: "a galloping horse",
      output_path: "videos/clip/h1.mp4",
    });

    const res = await callNextTask("T-vid-model", {
      type: "TaskRequest",
      accountToken: "T-vid-model",
      mode: "text",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("text");
    expect(body.imageModel).toBe("NARWHAL");
    expect(body.videoModel).toBe("veo_3_1_t2v_lite_low_priority");
  });

  it("includes googleOperationId + googleOperationProjectId when the claimed row carries them (resume case)", async () => {
    // Reaper has requeued a row that previously kicked off a Google
    // operation; the SW needs both fields back so it can resume polling
    // instead of re-submitting (which creates a duplicate gallery entry).
    const accId = await seedAccount({ token: "T-resume" });
    await seedVideo("vid_resume");
    const taskId = await enqueue({
      video_id: "vid_resume",
      chunk_id: "h1",
      kind: "clip",
      mode: "text",
      prompt: "a galloping horse",
      output_path: "videos/clip/h1.mp4",
    });
    // Pre-set the operation pair on the pending row, simulating the
    // post-requeue state Phase 1 leaves behind (no clear on requeue).
    const { getDb } = await import("@/lib/db");
    getDb()
      .prepare(
        `UPDATE google_flow_queue
            SET google_operation_id = ?, google_operation_project_id = ?
          WHERE id = ?`
      )
      .run("operations/op-abc", "proj-xyz", taskId);

    const res = await callNextTask("T-resume", {
      type: "TaskRequest",
      accountToken: "T-resume",
      mode: "text",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.googleOperationId).toBe("operations/op-abc");
    expect(body.googleOperationProjectId).toBe("proj-xyz");
    expect(accId).toBe("acc_01");
  });

  it("omits googleOperationId + googleOperationProjectId on a fresh row (no operation pair set)", async () => {
    // First dispatch: row was just enqueued, the pair is still null.
    // Emitting the keys would trick the SW into the resume branch with
    // garbage values — keep them off the payload entirely.
    await seedAccount({ token: "T-fresh-op" });
    await seedVideo("vid_fresh_op");
    await enqueue({
      video_id: "vid_fresh_op",
      chunk_id: "h1",
      kind: "clip",
      mode: "text",
      prompt: "a Roman bridge",
      output_path: "videos/clip/h1.mp4",
    });

    const res = await callNextTask("T-fresh-op", {
      type: "TaskRequest",
      accountToken: "T-fresh-op",
      mode: "text",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty("googleOperationId");
    expect(body).not.toHaveProperty("googleOperationProjectId");
  });

  it("resolves the effective videoModel for clip rows from google_flow_hook_clip_seconds", async () => {
    // Hook tasks need the variant model key (the clip duration is encoded
    // INTO the model key, not a separate field). Picking 4s + base
    // veo_3_1_t2v must surface veo_3_1_t2v_quality_4s on the dispatch DTO.
    await seedAccount({ token: "T-hook4" });
    await seedVideo("vid_h4");
    await enqueue({
      video_id: "vid_h4",
      chunk_id: "h1",
      kind: "clip",
      mode: "text",
      prompt: "a charging cavalry",
      output_path: "videos/clip/h1.mp4",
    });
    const { setSetting } = await import("@/lib/settings");
    setSetting("google_flow_video_model", "veo_3_1_t2v");
    setSetting("google_flow_hook_clip_seconds", "4");

    const res = await callNextTask("T-hook4", {
      type: "TaskRequest",
      accountToken: "T-hook4",
      mode: "text",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.videoModel).toBe("veo_3_1_t2v_quality_4s");
  });

  it("clip 6s with base lite_low_priority resolves to the suffix-around variant", async () => {
    // Sanity-check the irregular base→variant mapping for the
    // _low_priority base: the 6s variant inserts _6s BEFORE _low_priority,
    // not after it.
    await seedAccount({ token: "T-hook6" });
    await seedVideo("vid_h6");
    await enqueue({
      video_id: "vid_h6",
      chunk_id: "h1",
      kind: "clip",
      mode: "text",
      prompt: "p",
      output_path: "videos/clip/h1.mp4",
    });
    const { setSetting } = await import("@/lib/settings");
    setSetting("google_flow_video_model", "veo_3_1_t2v_lite_low_priority");
    setSetting("google_flow_hook_clip_seconds", "6");

    const res = await callNextTask("T-hook6", {
      type: "TaskRequest",
      accountToken: "T-hook6",
      mode: "text",
    });
    const body = await res.json();
    expect(body.videoModel).toBe("veo_3_1_t2v_lite_6s_low_priority");
  });

  it("clip 8s passes the base model through unchanged (identity column)", async () => {
    await seedAccount({ token: "T-hook8" });
    await seedVideo("vid_h8");
    await enqueue({
      video_id: "vid_h8",
      chunk_id: "h1",
      kind: "clip",
      mode: "text",
      prompt: "p",
      output_path: "videos/clip/h1.mp4",
    });
    const { setSetting } = await import("@/lib/settings");
    setSetting("google_flow_video_model", "veo_3_1_t2v_fast_ultra");
    setSetting("google_flow_hook_clip_seconds", "8");

    const res = await callNextTask("T-hook8", {
      type: "TaskRequest",
      accountToken: "T-hook8",
      mode: "text",
    });
    const body = await res.json();
    expect(body.videoModel).toBe("veo_3_1_t2v_fast_ultra");
  });

  it("non-hook rows pass the raw videoModel setting through unchanged regardless of clip_seconds", async () => {
    // Image rows must NOT pick up the hook-clip variant resolution — the
    // setting only governs hook dispatches. Set clip_seconds=4 to make a
    // bug here visible: if image accidentally went through the
    // resolver, the dispatched videoModel would become veo_3_1_t2v_lite_4s.
    await seedAccount({ token: "T-img-pass" });
    await seedVideo("vid_ip");
    await enqueue({
      video_id: "vid_ip",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p",
      output_path: "images/c1.png",
    });
    const { setSetting } = await import("@/lib/settings");
    setSetting("google_flow_video_model", "veo_3_1_t2v_lite");
    setSetting("google_flow_hook_clip_seconds", "4");

    const res = await callNextTask("T-img-pass", {
      type: "TaskRequest",
      accountToken: "T-img-pass",
      mode: "createImage",
    });
    const body = await res.json();
    expect(body.videoModel).toBe("veo_3_1_t2v_lite");
  });

  it("re-reads model settings on every dispatch (per-dispatch, not cached at claim time)", async () => {
    // Two pending rows; mutate the model settings between dispatches.
    // The second response must reflect the mutation, proving the route
    // doesn't snapshot settings at enqueue time.
    await seedAccount({ token: "T-fresh" });
    await seedVideo("vid_fresh");
    await enqueue({
      video_id: "vid_fresh",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "first prompt",
      output_path: "images/c1.png",
    });
    await enqueue({
      video_id: "vid_fresh",
      chunk_id: "c2",
      kind: "image",
      mode: "createImage",
      prompt: "second prompt",
      output_path: "images/c2.png",
    });

    const first = await (await callNextTask("T-fresh", {
      type: "TaskRequest",
      accountToken: "T-fresh",
      mode: "createImage",
    })).json();
    expect(first.imageModel).toBe("NARWHAL");
    expect(first.videoModel).toBe("veo_3_1_t2v_lite_low_priority");

    const { setSetting } = await import("@/lib/settings");
    setSetting("google_flow_image_model", "GEM_PIX_2");
    setSetting("google_flow_video_model", "veo_3_1_t2v_fast_ultra");

    const second = await (await callNextTask("T-fresh", {
      type: "TaskRequest",
      accountToken: "T-fresh",
      mode: "createImage",
    })).json();
    expect(second.imageModel).toBe("GEM_PIX_2");
    expect(second.videoModel).toBe("veo_3_1_t2v_fast_ultra");
  });
});
