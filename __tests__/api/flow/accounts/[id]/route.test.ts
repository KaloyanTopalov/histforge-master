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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-flow-accounts-id-"));
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

async function seedAccount(
  id: string,
  token: string,
  overrides: { enabled?: 0 | 1; paused_until?: number | null } = {}
): Promise<void> {
  const { getDb } = await import("@/lib/db");
  getDb()
    .prepare(
      `INSERT INTO google_flow_accounts (id, name, token, enabled, paused_until, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      id,
      token,
      overrides.enabled ?? 1,
      overrides.paused_until ?? null,
      Math.floor(Date.now() / 1000)
    );
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
  accountId: string;
}): Promise<number> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const gfRepo = await import("@/lib/repos/google-flow");
  const now = Math.floor(Date.now() / 1000);
  const id = gfRepo.enqueueTask(db, {
    video_id: args.videoId,
    chunk_id: args.chunkId,
    kind: "image",
    mode: "createImage",
    prompt: "p",
    output_path: `images/${args.chunkId}.png`,
    created_at: now,
  });
  db.prepare(
    `UPDATE google_flow_queue
        SET status = 'dispatched',
            assigned_account_id = ?,
            dispatched_at = ?,
            external_task_id = ?
      WHERE id = ?`
  ).run(args.accountId, now, `${id}_${now}`, id);
  return id;
}

function callPatch(id: string, body: unknown): Promise<Response> {
  return import("@/app/api/flow/accounts/[id]/route").then(({ PATCH }) =>
    PATCH(
      new Request(`http://localhost/api/flow/accounts/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: { id } }
    )
  );
}

function callPatchRaw(id: string, raw: string): Promise<Response> {
  return import("@/app/api/flow/accounts/[id]/route").then(({ PATCH }) =>
    PATCH(
      new Request(`http://localhost/api/flow/accounts/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: raw,
      }),
      { params: { id } }
    )
  );
}

function callDelete(id: string): Promise<Response> {
  return import("@/app/api/flow/accounts/[id]/route").then(({ DELETE }) =>
    DELETE(
      new Request(`http://localhost/api/flow/accounts/${id}`, {
        method: "DELETE",
      }),
      { params: { id } }
    )
  );
}

describe("PATCH /api/flow/accounts/:id", () => {
  it("returns 404 when the account id is unknown", async () => {
    const res = await callPatch("acc_missing", { name: "x" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("returns 400 when the body has no patchable fields", async () => {
    await seedAccount("acc_01", "T-01");
    const res = await callPatch("acc_01", {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_input");
  });

  it("returns 400 when the JSON body is malformed", async () => {
    await seedAccount("acc_01", "T-01");
    const res = await callPatchRaw("acc_01", "{not-valid-json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_input" });
  });

  it("returns 400 when paused_until_iso is not a parseable date", async () => {
    await seedAccount("acc_01", "T-01");
    const res = await callPatch("acc_01", {
      paused_until_iso: "not-a-date",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_input" });
  });

  it("updates the account name", async () => {
    await seedAccount("acc_01", "T-01");
    const res = await callPatch("acc_01", { name: "renamed" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT name FROM google_flow_accounts WHERE id = ?")
      .get("acc_01") as { name: string };
    expect(row.name).toBe("renamed");
  });

  it("toggles enabled=false", async () => {
    await seedAccount("acc_01", "T-01");
    const res = await callPatch("acc_01", { enabled: false });
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT enabled FROM google_flow_accounts WHERE id = ?")
      .get("acc_01") as { enabled: number };
    expect(row.enabled).toBe(0);
  });

  it("pauses the account when paused_until_iso is an ISO string", async () => {
    await seedAccount("acc_01", "T-01");
    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await callPatch("acc_01", { paused_until_iso: future });
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT paused_until FROM google_flow_accounts WHERE id = ?")
      .get("acc_01") as { paused_until: number | null };
    expect(row.paused_until).toBe(Math.floor(Date.parse(future) / 1000));
  });

  it("resumes the account when paused_until_iso is null", async () => {
    await seedAccount("acc_01", "T-01", { paused_until: 1_700_000_500 });
    const res = await callPatch("acc_01", { paused_until_iso: null });
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT paused_until FROM google_flow_accounts WHERE id = ?")
      .get("acc_01") as { paused_until: number | null };
    expect(row.paused_until).toBeNull();
  });

  it("applies name + enabled + paused_until_iso in one request", async () => {
    await seedAccount("acc_01", "T-01");
    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await callPatch("acc_01", {
      name: "combo",
      enabled: false,
      paused_until_iso: future,
    });
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
    expect(row.name).toBe("combo");
    expect(row.enabled).toBe(0);
    expect(row.paused_until).toBe(Math.floor(Date.parse(future) / 1000));
  });
});

describe("DELETE /api/flow/accounts/:id", () => {
  it("returns 404 when the account id is unknown", async () => {
    const res = await callDelete("acc_missing");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("deletes an account that has no queue rows", async () => {
    await seedAccount("acc_01", "T-01");
    const res = await callDelete("acc_01");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT id FROM google_flow_accounts WHERE id = ?")
      .get("acc_01");
    expect(row).toBeUndefined();
  });

  it("requeues every dispatched row for the account before deleting it", async () => {
    await seedAccount("acc_01", "T-01");
    await seedVideo("v1");
    const t1 = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      accountId: "acc_01",
    });
    const t2 = await seedDispatched({
      videoId: "v1",
      chunkId: "c2",
      accountId: "acc_01",
    });

    const res = await callDelete("acc_01");
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const db = getDb();
    expect(
      db
        .prepare("SELECT id FROM google_flow_accounts WHERE id = ?")
        .get("acc_01")
    ).toBeUndefined();

    const rows = db
      .prepare(
        "SELECT id, status, assigned_account_id, external_task_id FROM google_flow_queue WHERE id IN (?, ?) ORDER BY id ASC"
      )
      .all(t1, t2) as Array<{
      id: number;
      status: string;
      assigned_account_id: string | null;
      external_task_id: string | null;
    }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("pending");
      expect(row.assigned_account_id).toBeNull();
      expect(row.external_task_id).toBeNull();
    }
  });

  it("does not touch dispatched rows owned by other accounts", async () => {
    await seedAccount("acc_a", "T-A");
    await seedAccount("acc_b", "T-B");
    await seedVideo("v1");
    const myTask = await seedDispatched({
      videoId: "v1",
      chunkId: "c1",
      accountId: "acc_a",
    });
    const otherTask = await seedDispatched({
      videoId: "v1",
      chunkId: "c2",
      accountId: "acc_b",
    });

    const res = await callDelete("acc_a");
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const db = getDb();
    const mine = db
      .prepare("SELECT status FROM google_flow_queue WHERE id = ?")
      .get(myTask) as { status: string };
    const theirs = db
      .prepare(
        "SELECT status, assigned_account_id FROM google_flow_queue WHERE id = ?"
      )
      .get(otherTask) as { status: string; assigned_account_id: string };
    expect(mine.status).toBe("pending");
    expect(theirs.status).toBe("dispatched");
    expect(theirs.assigned_account_id).toBe("acc_b");
  });
});
