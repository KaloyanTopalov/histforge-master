import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let projectsDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-flow-submit-"));
  projectsDir = join(tempDir, "projects");
  process.env.DATABASE_URL = join(tempDir, "test.db");
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
    "DELETE FROM google_flow_queue; DELETE FROM google_flow_accounts; DELETE FROM videos; DELETE FROM settings;"
  );
  seedDefaultSettings(db);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seedAccount(token: string): Promise<string> {
  const { getDb } = await import("@/lib/db");
  const id = "acc_01";
  getDb()
    .prepare(
      `INSERT INTO google_flow_accounts (id, name, token, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(id, "a1", token, Math.floor(Date.now() / 1000));
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

async function seedDispatched(args: {
  videoId: string;
  chunkId: string;
  externalTaskId: string;
  accountId: string;
  mode?: "createImage" | "text" | "image" | "frames";
  outputPath?: string;
  retryCount?: number;
  kind?: "image" | "clip";
}): Promise<number> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const gfRepo = await import("@/lib/repos/google-flow");
  const now = Math.floor(Date.now() / 1000);
  const id = gfRepo.enqueueTask(db, {
    video_id: args.videoId,
    chunk_id: args.chunkId,
    kind: args.kind ?? "image",
    mode: args.mode ?? "createImage",
    prompt: "prompt",
    output_path: args.outputPath ?? `images/${args.chunkId}.png`,
    created_at: now,
  });
  db.prepare(
    `UPDATE google_flow_queue
        SET status = 'dispatched',
            assigned_account_id = ?,
            dispatched_at = ?,
            external_task_id = ?,
            retry_count = ?
      WHERE id = ?`
  ).run(
    args.accountId,
    now,
    args.externalTaskId,
    args.retryCount ?? 0,
    id
  );
  return id;
}

function callSubmit(token: string, body: unknown): Promise<Response> {
  return import("@/app/api/flow/submit-result/[token]/route").then(
    ({ POST }) =>
      POST(
        new Request(`http://localhost/api/flow/submit-result/${token}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: { token } }
      )
  );
}

function dataUrlOf(bytes: number[] | Buffer): string {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return `data:image/png;base64,${b.toString("base64")}`;
}

describe("POST /api/flow/submit-result/:token", () => {
  it("401s on token mismatch", async () => {
    await seedAccount("T");
    const res = await callSubmit("T-url", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "1_1",
      mode: "createImage",
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(401);
  });

  it("200 + duplicate=true when the external_task_id is unknown", async () => {
    await seedAccount("T");
    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "999_999",
      resultUrl: "https://storage.googleapis.com/x.png",
      mode: "createImage",
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, duplicate: true });
  });

  it("200 + duplicate=true when the task is already done", async () => {
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "1_111",
      accountId: accId,
    });
    const { getDb } = await import("@/lib/db");
    getDb()
      .prepare(
        "UPDATE google_flow_queue SET status='done', result_url='done-url' WHERE id = ?"
      )
      .run(id);

    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "1_111",
      resultUrl: "https://storage.googleapis.com/x.png",
      mode: "createImage",
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, duplicate: true });
  });

  it("downloads the media, marks the task done, and returns success on a dispatched row", async () => {
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "1_222",
      accountId: accId,
      outputPath: "images/c1.png",
    });

    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "1_222",
      resultUrl: dataUrlOf(payload),
      mode: "createImage",
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT status, result_url FROM google_flow_queue WHERE id = ?")
      .get(id) as { status: string; result_url: string };
    expect(row.status).toBe("done");
    expect(row.result_url).toContain("data:image/png;base64,");

    const finalPath = join(projectsDir, "v1", "images/c1.png");
    expect(existsSync(finalPath)).toBe(true);
    expect(readFileSync(finalPath).equals(payload)).toBe(true);
  });

  it("takes the first entry of a comma-separated HTTPS resultUrl", async () => {
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const first = new Uint8Array([1, 1, 1]);
    const fetchSpy = vi
      .fn(async (url: unknown) => {
        // Fetch must only see the first URL — splitting downstream
        // would mean we fetched the second.
        expect(url).toBe("https://storage.googleapis.com/first.png");
        return new Response(first, { status: 200 });
      });
    vi.stubGlobal("fetch", fetchSpy);

    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c2",
      externalTaskId: "2_333",
      accountId: accId,
      outputPath: "images/c2.png",
    });

    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "2_333",
      resultUrl:
        "https://storage.googleapis.com/first.png,https://storage.googleapis.com/second.png",
      mode: "createImage",
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT status FROM google_flow_queue WHERE id = ?")
      .get(id) as { status: string };
    expect(row.status).toBe("done");
    expect(
      Array.from(
        readFileSync(join(projectsDir, "v1", "images/c2.png"))
      )
    ).toEqual(Array.from(first));
  });

  it("content-policy error → permanent fail, no requeue, no account pause", async () => {
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "3_1",
      accountId: accId,
    });

    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "3_1",
      error: "PUBLIC_ERROR_INAPPROPRIATE_CONTENT",
      mode: "createImage",
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT status, error_reason FROM google_flow_queue WHERE id = ?")
      .get(id) as { status: string; error_reason: string };
    expect(row.status).toBe("failed");
    expect(row.error_reason).toContain("INAPPROPRIATE_CONTENT");

    const acct = getDb()
      .prepare("SELECT paused_until FROM google_flow_accounts WHERE id = ?")
      .get(accId) as { paused_until: number | null };
    expect(acct.paused_until).toBeNull();
  });

  it("quota error pauses the account and requeues the task", async () => {
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "4_1",
      accountId: accId,
    });

    const before = Math.floor(Date.now() / 1000);
    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "4_1",
      error: "HTTP 429: RESOURCE_EXHAUSTED",
      mode: "createImage",
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT status, assigned_account_id FROM google_flow_queue WHERE id = ?")
      .get(id) as { status: string; assigned_account_id: string | null };
    expect(row.status).toBe("pending");
    expect(row.assigned_account_id).toBeNull();

    const acct = getDb()
      .prepare("SELECT paused_until FROM google_flow_accounts WHERE id = ?")
      .get(accId) as { paused_until: number };
    expect(acct.paused_until).not.toBeNull();
    // default cooldown is 4h.
    const expected = before + 4 * 3600;
    expect(acct.paused_until).toBeGreaterThanOrEqual(expected - 5);
    expect(acct.paused_until).toBeLessThanOrEqual(expected + 5);
  });

  it("PUBLIC_ERROR_UNUSUAL_ACTIVITY (without RECAPTCHA in the body) is treated as quota (pause account + requeue)", async () => {
    // Pure UNUSUAL_ACTIVITY without a reCAPTCHA challenge in the body
    // still hits the quota cooldown — only the RECAPTCHA literal pushes
    // an error onto the captcha override path (see test below).
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "4u_1",
      accountId: accId,
    });

    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "4u_1",
      error:
        '403: {"error":{"code":403,"message":"unusual activity detected","status":"PERMISSION_DENIED","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"PUBLIC_ERROR_UNUSUAL_ACTIVITY"}]}}',
      mode: "createImage",
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT status, assigned_account_id FROM google_flow_queue WHERE id = ?")
      .get(id) as { status: string; assigned_account_id: string | null };
    expect(row.status).toBe("pending");
    expect(row.assigned_account_id).toBeNull();

    const acct = getDb()
      .prepare("SELECT paused_until FROM google_flow_accounts WHERE id = ?")
      .get(accId) as { paused_until: number | null };
    expect(acct.paused_until).not.toBeNull();
  });

  it("does not flip google_flow_relogin_needed on UNUSUAL_ACTIVITY", async () => {
    // The flag is reserved for the extension's explicit session_expired
    // event. Quota-class errors only pause one account and don't
    // require user intervention on the Chrome profile.
    const accId = await seedAccount("T");
    await seedVideo("v1");
    await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "4r_1",
      accountId: accId,
    });

    await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "4r_1",
      error: "PUBLIC_ERROR_UNUSUAL_ACTIVITY",
      mode: "createImage",
      timestamp: new Date().toISOString(),
    });

    const { getSetting } = await import("@/lib/settings");
    expect(getSetting("google_flow_relogin_needed")).toBe(false);
  });

  it("captcha override: errorCategory='auth' + errorText containing RECAPTCHA → handleCaptcha (flags account, requeues, no paused_until)", async () => {
    // Wire reality: the extension's parseFlowApiError maps every HTTP 403
    // to category='auth' (extensions/youforge-flow/src/flow-error.js),
    // so RECAPTCHA failures arrive labeled 'auth'. The captcha override
    // at the top of handleError must take precedence so they don't get
    // silently requeued by handleAuth.
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "cap_1",
      accountId: accId,
    });

    const before = Math.floor(Date.now() / 1000);
    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "cap_1",
      mode: "createImage",
      error:
        '403: {"error":{"code":403,"message":"reCAPTCHA evaluation failed","status":"PERMISSION_DENIED"}}',
      errorCategory: "auth",
      errorCode: "HTTP_403",
      httpStatus: 403,
      schemaVersion: 2,
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT status, assigned_account_id, retry_count FROM google_flow_queue WHERE id = ?"
      )
      .get(id) as {
      status: string;
      assigned_account_id: string | null;
      retry_count: number;
    };
    expect(row.status).toBe("pending");
    expect(row.assigned_account_id).toBeNull();
    expect(row.retry_count).toBe(0); // captcha does not bump retry budget

    const acct = getDb()
      .prepare(
        "SELECT paused_until, recovery_reason, recovery_required_at FROM google_flow_accounts WHERE id = ?"
      )
      .get(accId) as {
      paused_until: number | null;
      recovery_reason: string | null;
      recovery_required_at: number | null;
    };
    expect(acct.paused_until).toBeNull(); // operator-gated, not time-paused
    expect(acct.recovery_reason).toBe("captcha");
    expect(acct.recovery_required_at).not.toBeNull();
    expect(acct.recovery_required_at!).toBeGreaterThanOrEqual(before - 1);
  });

  it("captcha override does NOT false-positive on errorCategory='auth' without RECAPTCHA — handleAuth still fires", async () => {
    // Plain auth failures (SESSION_EXPIRED etc.) must still flow through
    // handleAuth: silent requeue, no recovery flag, no retry bump.
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "auth_plain_1",
      accountId: accId,
      retryCount: 1,
    });

    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "auth_plain_1",
      mode: "createImage",
      error: "SESSION_EXPIRED: createProject",
      errorCategory: "auth",
      errorCode: "HTTP_401",
      httpStatus: 401,
      schemaVersion: 2,
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT status, retry_count FROM google_flow_queue WHERE id = ?"
      )
      .get(id) as { status: string; retry_count: number };
    expect(row.status).toBe("pending");
    expect(row.retry_count).toBe(1); // unchanged

    const acct = getDb()
      .prepare(
        "SELECT paused_until, recovery_reason, recovery_required_at FROM google_flow_accounts WHERE id = ?"
      )
      .get(accId) as {
      paused_until: number | null;
      recovery_reason: string | null;
      recovery_required_at: number | null;
    };
    expect(acct.paused_until).toBeNull();
    expect(acct.recovery_reason).toBeNull(); // override did not fire
    expect(acct.recovery_required_at).toBeNull();
  });

  it("synthetic fallback: no v2 envelope + errorText containing RECAPTCHA → handleCaptcha via LEGACY_HANDLERS['captcha']", async () => {
    // Synthetic call sites (download-failure path, empty submission)
    // pass no `parsed` object, so the v2 errorCategory dispatch can't
    // see anything. The LEGACY_HANDLERS['captcha'] registration is the
    // safety net that catches these cases.
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "cap_legacy_1",
      accountId: accId,
    });

    const before = Math.floor(Date.now() / 1000);
    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "cap_legacy_1",
      mode: "createImage",
      error: "HTTP 403: reCAPTCHA evaluation failed",
      // No errorCategory — legacy classifier is the only signal.
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT status FROM google_flow_queue WHERE id = ?")
      .get(id) as { status: string };
    expect(row.status).toBe("pending");

    const acct = getDb()
      .prepare(
        "SELECT paused_until, recovery_reason, recovery_required_at FROM google_flow_accounts WHERE id = ?"
      )
      .get(accId) as {
      paused_until: number | null;
      recovery_reason: string | null;
      recovery_required_at: number | null;
    };
    expect(acct.paused_until).toBeNull();
    expect(acct.recovery_reason).toBe("captcha");
    expect(acct.recovery_required_at).not.toBeNull();
    expect(acct.recovery_required_at!).toBeGreaterThanOrEqual(before - 1);
  });

  it("transient error under max_retries: bumps retry_count and requeues", async () => {
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "5_1",
      accountId: accId,
      retryCount: 0,
    });

    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "5_1",
      error: "ECONNRESET while waiting for videogen",
      mode: "text",
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT status, retry_count FROM google_flow_queue WHERE id = ?")
      .get(id) as { status: string; retry_count: number };
    expect(row.status).toBe("pending");
    expect(row.retry_count).toBe(1);
  });

  it("transient error at/over max_retries: permanent fail", async () => {
    const accId = await seedAccount("T");
    await seedVideo("v1");
    // default max_retries=3; seeding at 3 means the next bump hits the ceiling.
    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "6_1",
      accountId: accId,
      retryCount: 3,
    });

    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "6_1",
      error: "connection reset",
      mode: "text",
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT status, retry_count FROM google_flow_queue WHERE id = ?")
      .get(id) as { status: string; retry_count: number };
    expect(row.status).toBe("failed");
  });

  it("disallowed resultUrl host → failTask('invalid result host')", async () => {
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "7_1",
      accountId: accId,
    });

    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "7_1",
      resultUrl: "http://127.0.0.1/leak.png",
      mode: "createImage",
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT status, error_reason FROM google_flow_queue WHERE id = ?")
      .get(id) as { status: string; error_reason: string };
    expect(row.status).toBe("failed");
    expect(row.error_reason.toLowerCase()).toContain("invalid result host");
  });

  it("failed task + valid resultUrl: salvage by flipping to done", async () => {
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const payload = Buffer.from([7, 7, 7]);
    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c9",
      externalTaskId: "9_1",
      accountId: accId,
      outputPath: "images/c9.png",
    });
    const { getDb } = await import("@/lib/db");
    getDb()
      .prepare(
        "UPDATE google_flow_queue SET status='failed', error_reason='reaper timeout' WHERE id = ?"
      )
      .run(id);

    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "9_1",
      resultUrl: dataUrlOf(payload),
      mode: "createImage",
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);

    const row = getDb()
      .prepare("SELECT status FROM google_flow_queue WHERE id = ?")
      .get(id) as { status: string };
    expect(row.status).toBe("done");
    expect(
      readFileSync(join(projectsDir, "v1", "images/c9.png")).equals(payload)
    ).toBe(true);
  });

  it("400 on a body missing required fields", async () => {
    await seedAccount("T");
    const res = await callSubmit("T", { type: "ResultSubmission" });
    expect(res.status).toBe(400);
  });

  it("errorCategory create_project_failed: pauses 24h, requeues without retry bump, writes flow_create_project_failed setting", async () => {
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "cp_1",
      accountId: accId,
      retryCount: 2,
    });

    const before = Math.floor(Date.now() / 1000);
    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "cp_1",
      mode: "createImage",
      error: "createProject HTTP 500: ...",
      errorCategory: "create_project_failed",
      errorCode: "HTTP_500",
      httpStatus: 500,
      schemaVersion: 2,
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT status, retry_count, assigned_account_id FROM google_flow_queue WHERE id = ?"
      )
      .get(id) as {
      status: string;
      retry_count: number;
      assigned_account_id: string | null;
    };
    expect(row.status).toBe("pending");
    expect(row.retry_count).toBe(2); // unchanged
    expect(row.assigned_account_id).toBeNull();

    const acct = getDb()
      .prepare("SELECT paused_until FROM google_flow_accounts WHERE id = ?")
      .get(accId) as { paused_until: number | null };
    expect(acct.paused_until).not.toBeNull();
    const expected = before + 24 * 3600;
    expect(acct.paused_until).toBeGreaterThanOrEqual(expected - 5);
    expect(acct.paused_until).toBeLessThanOrEqual(expected + 5);

    const { getSetting } = await import("@/lib/settings");
    const flagRaw = getSetting("flow_create_project_failed");
    expect(flagRaw).not.toBe("");
    const parsed = JSON.parse(flagRaw);
    expect(parsed.errorCode).toBe("HTTP_500");
    expect(parsed.httpStatus).toBe(500);
    expect(parsed.accountId).toBe(accId);
    expect(parsed.taskId).toBe("cp_1");
    expect(typeof parsed.when).toBe("number");
  });

  it("errorCategory service_overload: pauses account ~15 min, requeues without retry bump, writes flow_service_overload_until", async () => {
    // Mirrors the bug-fix path: a v2 envelope with the SW's new
    // service_overload category must route through handleServiceOverload —
    // a per-account minute-scale pause + requeue (no retry burn) + a
    // banner timestamp write, all in one transaction.
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "so_1",
      accountId: accId,
      retryCount: 2,
    });

    const before = Math.floor(Date.now() / 1000);
    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "so_1",
      mode: "createImage",
      error: "PUBLIC_ERROR_HIGH_TRAFFIC",
      errorCategory: "service_overload",
      schemaVersion: 2,
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT status, retry_count, assigned_account_id FROM google_flow_queue WHERE id = ?"
      )
      .get(id) as {
      status: string;
      retry_count: number;
      assigned_account_id: string | null;
    };
    expect(row.status).toBe("pending");
    expect(row.retry_count).toBe(2); // unchanged — service_overload doesn't burn retries
    expect(row.assigned_account_id).toBeNull();

    const acct = getDb()
      .prepare("SELECT paused_until FROM google_flow_accounts WHERE id = ?")
      .get(accId) as { paused_until: number | null };
    expect(acct.paused_until).not.toBeNull();
    const expected = before + 15 * 60;
    expect(acct.paused_until).toBeGreaterThanOrEqual(expected - 5);
    expect(acct.paused_until).toBeLessThanOrEqual(expected + 5);

    const { getSetting } = await import("@/lib/settings");
    const bannerRaw = getSetting("flow_service_overload_until");
    expect(bannerRaw).not.toBe("");
    const bannerTs = parseInt(bannerRaw, 10);
    expect(bannerTs).toBe(acct.paused_until);
  });

  it("legacy classifier routes HIGH_TRAFFIC errorText (no v2 envelope) through the same service_overload path", async () => {
    // Synthetic callers (download failure, empty submission) pass only
    // `errorText` — no v2 envelope. The legacy classifier must catch
    // PUBLIC_ERROR_HIGH_TRAFFIC and route to handleServiceOverload, not
    // permanent-fail via content_policy or burn retries via transient.
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "so_2",
      accountId: accId,
      retryCount: 1,
    });

    const before = Math.floor(Date.now() / 1000);
    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "so_2",
      mode: "createImage",
      error:
        'MEDIA_GENERATION_STATUS_FAILED: {"code":8,"message":"PUBLIC_ERROR_HIGH_TRAFFIC"}',
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT status, retry_count FROM google_flow_queue WHERE id = ?"
      )
      .get(id) as { status: string; retry_count: number };
    expect(row.status).toBe("pending");
    expect(row.retry_count).toBe(1); // unchanged

    const acct = getDb()
      .prepare("SELECT paused_until FROM google_flow_accounts WHERE id = ?")
      .get(accId) as { paused_until: number | null };
    expect(acct.paused_until).not.toBeNull();
    const expected = before + 15 * 60;
    expect(acct.paused_until!).toBeGreaterThanOrEqual(expected - 5);
    expect(acct.paused_until!).toBeLessThanOrEqual(expected + 5);
  });

  it("service_overload pause length honors google_flow_service_overload_cooldown_minutes", async () => {
    // Proves the read-from-setting wiring — operator override at e.g.
    // 30 min must produce a 30-min pause, not the 15-min default.
    const { setSetting } = await import("@/lib/settings");
    setSetting("google_flow_service_overload_cooldown_minutes", 30);

    const accId = await seedAccount("T");
    await seedVideo("v1");
    await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "so_3",
      accountId: accId,
    });

    const before = Math.floor(Date.now() / 1000);
    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "so_3",
      mode: "createImage",
      error: "PUBLIC_ERROR_HIGH_TRAFFIC",
      errorCategory: "service_overload",
      schemaVersion: 2,
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const acct = getDb()
      .prepare("SELECT paused_until FROM google_flow_accounts WHERE id = ?")
      .get(accId) as { paused_until: number | null };
    const expected = before + 30 * 60;
    expect(acct.paused_until!).toBeGreaterThanOrEqual(expected - 5);
    expect(acct.paused_until!).toBeLessThanOrEqual(expected + 5);
  });

  it("errorCategory auth: requeues without retry bump, does NOT re-set google_flow_relogin_needed", async () => {
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "auth_1",
      accountId: accId,
      retryCount: 1,
    });
    // Simulate the StatusEvent path having set the flag earlier; the
    // auth branch must leave it alone (no flip back to false here).
    const { setSetting, getSetting } = await import("@/lib/settings");
    setSetting("google_flow_relogin_needed", true);

    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "auth_1",
      mode: "createImage",
      error: "SESSION_EXPIRED: createProject",
      errorCategory: "auth",
      errorCode: "HTTP_401",
      httpStatus: 401,
      schemaVersion: 2,
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT status, retry_count FROM google_flow_queue WHERE id = ?"
      )
      .get(id) as { status: string; retry_count: number };
    expect(row.status).toBe("pending");
    expect(row.retry_count).toBe(1); // unchanged

    const acct = getDb()
      .prepare("SELECT paused_until FROM google_flow_accounts WHERE id = ?")
      .get(accId) as { paused_until: number | null };
    expect(acct.paused_until).toBeNull();

    // Flag still true — branch did not touch it.
    expect(getSetting("google_flow_relogin_needed")).toBe(true);
  });

  it("errorCategory stale_project_id: clears (video, account) project row and requeues without retry bump", async () => {
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "stale_1",
      accountId: accId,
      retryCount: 1,
    });
    const gfRepo = await import("@/lib/repos/google-flow");
    const { getDb } = await import("@/lib/db");
    gfRepo.upsertFlowProjectForAccount(
      getDb(),
      "v1",
      accId,
      "stale-proj",
      Math.floor(Date.now() / 1000)
    );

    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "stale_1",
      mode: "createImage",
      error: "HTTP 404 from /projects/stale-proj/...",
      errorCategory: "stale_project_id",
      errorCode: "HTTP_404",
      httpStatus: 404,
      schemaVersion: 2,
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);

    expect(gfRepo.findFlowProjectForAccount(getDb(), "v1", accId)).toBeUndefined();
    const row = getDb()
      .prepare("SELECT status, retry_count FROM google_flow_queue WHERE id = ?")
      .get(id) as { status: string; retry_count: number };
    expect(row.status).toBe("pending");
    expect(row.retry_count).toBe(1); // unchanged
  });

  it("download failure (synthetic) routes through legacy transient — no v2 branch even if request body had v2 fields", async () => {
    // Sanity guard for the refactor: the download-failure caller passes
    // only errorText (no `parsed`), so v2 branches must not fire even
    // when the original submission carried v2 envelope fields. A
    // disallowed host triggers an early failTask before download, so
    // we use a stub fetch that throws to drive the download-failure
    // path on a valid host instead.
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "dl_1",
      accountId: accId,
      retryCount: 0,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom: simulated download failure");
      })
    );

    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "dl_1",
      mode: "createImage",
      resultUrl: "https://storage.googleapis.com/x.png",
      // v2 fields present on the original submission, but the synthetic
      // download-failure caller MUST NOT pass `parsed` — these fields
      // should be ignored entirely on this code path.
      errorCategory: "create_project_failed",
      errorCode: "HTTP_500",
      httpStatus: 500,
      schemaVersion: 2,
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT status, retry_count FROM google_flow_queue WHERE id = ?"
      )
      .get(id) as { status: string; retry_count: number };
    // Legacy transient: bumped retry_count, requeued.
    expect(row.status).toBe("pending");
    expect(row.retry_count).toBe(1);

    // Account NOT paused (would be the v2 create_project_failed branch).
    const acct = getDb()
      .prepare("SELECT paused_until FROM google_flow_accounts WHERE id = ?")
      .get(accId) as { paused_until: number | null };
    expect(acct.paused_until).toBeNull();

    // Setting NOT written.
    const { getSetting } = await import("@/lib/settings");
    expect(getSetting("flow_create_project_failed")).toBe("");
  });

  it("accepts the v2 envelope with explicit nulls (httpStatus/contentPolicyTag/etc.)", async () => {
    // Regression: webhook.js submitFailure sends `null` (not undefined)
    // for any structured field it doesn't have — its own contract
    // declares them as `T | null`. The schema previously used
    // `.optional()`, which rejects null and stranded the row in
    // `dispatched` (extension didn't retry, count never dropped).
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "200_1777232839",
      accountId: accId,
      mode: "text",
      kind: "clip",
    });

    const res = await callSubmit("T", {
      type: "ResultSubmission",
      schemaVersion: 2,
      accountToken: "T",
      taskId: "200_1777232839",
      mode: "text",
      error: "Video generation succeeded but no URL could be resolved after retry",
      errorCode: "NO_URL",
      errorCategory: "not_found",
      httpStatus: null,
      retryable: false,
      contentPolicyTag: null,
      correlationId: "a00fd28b-af75-4c8b-bf62-3071bb14c69b",
      timings: null,
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);

    // Unknown errorCategory ("not_found") → falls through to legacy
    // classifier, which tags this as transient (no QUOTA / SAFETY hit).
    // retry_count starts at 0, so we expect requeue with bump to 1.
    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT status, retry_count FROM google_flow_queue WHERE id = ?")
      .get(id) as { status: string; retry_count: number };
    expect(row.status).toBe("pending");
    expect(row.retry_count).toBe(1);
  });

  it("errorCategory missing falls back to the legacy string-based classifier", async () => {
    // No errorCategory → legacy `classifyError(error)` runs. A 429 string
    // should still route to the quota branch (pause + requeue).
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const id = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      externalTaskId: "legacy_1",
      accountId: accId,
    });

    const res = await callSubmit("T", {
      type: "ResultSubmission",
      accountToken: "T",
      taskId: "legacy_1",
      mode: "createImage",
      error: "HTTP 429: RESOURCE_EXHAUSTED",
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT status FROM google_flow_queue WHERE id = ?")
      .get(id) as { status: string };
    expect(row.status).toBe("pending");
    const acct = getDb()
      .prepare("SELECT paused_until FROM google_flow_accounts WHERE id = ?")
      .get(accId) as { paused_until: number | null };
    expect(acct.paused_until).not.toBeNull();
  });
});
