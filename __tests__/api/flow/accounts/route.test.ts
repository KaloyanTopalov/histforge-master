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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-flow-accounts-"));
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

async function postAccount(
  body: unknown,
  host = "http://flow.example.com:8443"
): Promise<Response> {
  const { POST } = await import("@/app/api/flow/accounts/route");
  return POST(
    new Request(`${host}/api/flow/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

async function listAccounts(): Promise<Response> {
  const { GET } = await import("@/app/api/flow/accounts/route");
  return GET();
}

async function patchAccount(
  id: string,
  body: unknown
): Promise<Response> {
  const { PATCH } = await import("@/app/api/flow/accounts/[id]/route");
  return PATCH(
    new Request(`http://localhost/api/flow/accounts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: { id } }
  );
}

async function deleteAccount(id: string): Promise<Response> {
  const { DELETE } = await import("@/app/api/flow/accounts/[id]/route");
  return DELETE(
    new Request(`http://localhost/api/flow/accounts/${id}`, {
      method: "DELETE",
    }),
    { params: { id } }
  );
}

describe("POST /api/flow/accounts", () => {
  it("mints acc_01 with a 32-char base64url token and absolute webhook URLs", async () => {
    const res = await postAccount({ name: "Primary" }, "http://hf.local:3000");
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("acc_01");
    expect(body.name).toBe("Primary");
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(body.pollUrl).toBe(
      `http://hf.local:3000/api/flow/next-task/${body.token}`
    );
    expect(body.resultUrl).toBe(
      `http://hf.local:3000/api/flow/submit-result/${body.token}`
    );
    expect(body.statusUrl).toBe(
      `http://hf.local:3000/api/flow/status/${body.token}`
    );
    expect(body.projectUrl).toBe(
      `http://hf.local:3000/api/flow/project/${body.token}`
    );

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT id, name, token FROM google_flow_accounts WHERE id = ?")
      .get("acc_01") as { id: string; name: string; token: string };
    expect(row.token).toBe(body.token);
  });

  it("increments to acc_02 on the second create", async () => {
    await postAccount({ name: "A" });
    const res = await postAccount({ name: "B" });
    expect((await res.json()).id).toBe("acc_02");
  });

  it("preserves gaps: MAX+1 never renumbers survivors", async () => {
    await postAccount({ name: "A" }); // acc_01
    await postAccount({ name: "B" }); // acc_02
    await deleteAccount("acc_01");
    const res = await postAccount({ name: "C" });
    // acc_02 still exists, so MAX+1 gives acc_03 — the gap at acc_01
    // is preserved and survivors keep their ids.
    expect((await res.json()).id).toBe("acc_03");
  });

  it("400s on an empty name or a name longer than 64 chars", async () => {
    expect((await postAccount({ name: "" })).status).toBe(400);
    expect((await postAccount({ name: "x".repeat(65) })).status).toBe(400);
  });
});

describe("GET /api/flow/accounts", () => {
  it("lists accounts with the token redacted to the last 4 chars", async () => {
    const created = await (await postAccount({ name: "A" })).json();
    const res = await listAccounts();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accounts).toHaveLength(1);
    const account = body.accounts[0];
    expect(account.id).toBe("acc_01");
    expect(account.name).toBe("A");
    expect(account.token).toBeUndefined();
    expect(account.token_display).toBe(`…${created.token.slice(-4)}`);
  });

  it("returns an empty list when no accounts exist", async () => {
    const res = await listAccounts();
    expect(await res.json()).toEqual({ accounts: [] });
  });

  it("surfaces recovery_reason and recovery_required_at via the wire payload (both nullable)", async () => {
    // Two accounts: one flagged for captcha recovery, one unflagged.
    await postAccount({ name: "Flagged" });
    await postAccount({ name: "Healthy" });

    const { getDb } = await import("@/lib/db");
    const gfRepo = await import("@/lib/repos/google-flow");
    const recoveredAt = 1_700_000_000;
    gfRepo.setAccountRecoveryReason(getDb(), "acc_01", "captcha", recoveredAt);

    const res = await listAccounts();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accounts).toHaveLength(2);

    const flagged = body.accounts.find(
      (a: { id: string }) => a.id === "acc_01"
    );
    expect(flagged.recovery_reason).toBe("captcha");
    expect(flagged.recovery_required_at).toBe(recoveredAt);

    const healthy = body.accounts.find(
      (a: { id: string }) => a.id === "acc_02"
    );
    expect(healthy.recovery_reason).toBeNull();
    expect(healthy.recovery_required_at).toBeNull();
  });
});

describe("PATCH /api/flow/accounts/[id]", () => {
  it("renames, toggles enabled, and sets / clears paused_until", async () => {
    const { token } = await (await postAccount({ name: "old" })).json();
    let res = await patchAccount("acc_01", { name: "new" });
    expect(res.status).toBe(200);

    res = await patchAccount("acc_01", { enabled: false });
    expect(res.status).toBe(200);

    const futureIso = new Date(Date.now() + 3600_000).toISOString();
    res = await patchAccount("acc_01", { paused_until_iso: futureIso });
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT name, enabled, paused_until FROM google_flow_accounts WHERE id = ?"
      )
      .get("acc_01") as {
      name: string;
      enabled: number;
      paused_until: number | null;
    };
    expect(row.name).toBe("new");
    expect(row.enabled).toBe(0);
    expect(row.paused_until).toBe(Math.floor(Date.parse(futureIso) / 1000));

    // Clear pause — paused_until goes back to null.
    res = await patchAccount("acc_01", { paused_until_iso: null });
    expect(res.status).toBe(200);
    const cleared = getDb()
      .prepare(
        "SELECT paused_until FROM google_flow_accounts WHERE id = ?"
      )
      .get("acc_01") as { paused_until: number | null };
    expect(cleared.paused_until).toBeNull();

    // Token still intact — PATCH never touches it.
    const tokenRow = getDb()
      .prepare("SELECT token FROM google_flow_accounts WHERE id = ?")
      .get("acc_01") as { token: string };
    expect(tokenRow.token).toBe(token);
  });

  it("404s on unknown id", async () => {
    const res = await patchAccount("acc_99", { name: "x" });
    expect(res.status).toBe(404);
  });

  it("400s on a body with no fields", async () => {
    await postAccount({ name: "a" });
    const res = await patchAccount("acc_01", {});
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/flow/accounts/[id]", () => {
  it("requeues dispatched rows and lets ON DELETE SET NULL handle pending rows", async () => {
    const { getDb } = await import("@/lib/db");
    const db = getDb();

    const { token: _token } = await (await postAccount({ name: "A" })).json();

    db.prepare(
      `INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?)`
    ).run("v_1", "T", "info", "google-flow", Date.now());

    const gfRepo = await import("@/lib/repos/google-flow");
    const now = Math.floor(Date.now() / 1000);
    const pendingId = gfRepo.enqueueTask(db, {
      video_id: "v_1",
      chunk_id: "c1",
      kind: "image",
      mode: "createImage",
      prompt: "p1",
      output_path: "images/c1.png",
      created_at: now,
    });
    const dispatchedId = gfRepo.enqueueTask(db, {
      video_id: "v_1",
      chunk_id: "c2",
      kind: "image",
      mode: "createImage",
      prompt: "p2",
      output_path: "images/c2.png",
      created_at: now,
    });
    // Make the pending row reference the account (would normally happen
    // via the atomic claim, but we're exercising the delete flow).
    db.prepare(
      "UPDATE google_flow_queue SET assigned_account_id = ? WHERE id = ?"
    ).run("acc_01", pendingId);
    db.prepare(
      `UPDATE google_flow_queue
          SET status = 'dispatched',
              assigned_account_id = ?,
              dispatched_at = ?,
              external_task_id = ?
        WHERE id = ?`
    ).run("acc_01", now, `${dispatchedId}_${now}`, dispatchedId);

    const res = await deleteAccount("acc_01");
    expect(res.status).toBe(200);

    // Account is gone.
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM google_flow_accounts WHERE id = ?")
        .get("acc_01")
    ).toMatchObject({ n: 0 });

    // Dispatched row requeued to pending with assignment cleared and
    // external_task_id wiped.
    const dispatched = db
      .prepare("SELECT * FROM google_flow_queue WHERE id = ?")
      .get(dispatchedId) as {
      status: string;
      assigned_account_id: string | null;
      external_task_id: string | null;
      dispatched_at: number | null;
    };
    expect(dispatched.status).toBe("pending");
    expect(dispatched.assigned_account_id).toBeNull();
    expect(dispatched.external_task_id).toBeNull();
    expect(dispatched.dispatched_at).toBeNull();

    // The pending row was still assigned — ON DELETE SET NULL nulls it.
    const pending = db
      .prepare("SELECT status, assigned_account_id FROM google_flow_queue WHERE id = ?")
      .get(pendingId) as { status: string; assigned_account_id: string | null };
    expect(pending.status).toBe("pending");
    expect(pending.assigned_account_id).toBeNull();
  });

  it("404s on unknown id", async () => {
    const res = await deleteAccount("acc_99");
    expect(res.status).toBe(404);
  });
});
