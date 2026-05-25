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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-flow-status-"));
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
  db.exec("DELETE FROM google_flow_accounts; DELETE FROM settings;");
  seedDefaultSettings(db);
});

async function seedAccount(token: string): Promise<string> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const id = "acc_01";
  db.prepare(
    `INSERT INTO google_flow_accounts (id, name, token, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(id, "a1", token, Math.floor(Date.now() / 1000));
  return id;
}

function callStatus(token: string, body: unknown): Promise<Response> {
  return import("@/app/api/flow/status/[token]/route").then(({ POST }) =>
    POST(
      new Request(`http://localhost/api/flow/status/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: { token } }
    )
  );
}

describe("POST /api/flow/status/:token", () => {
  it("401s on token mismatch", async () => {
    await seedAccount("T");
    const res = await callStatus("T-url", {
      type: "StatusEvent",
      accountToken: "T",
      event: "credits",
      credits: 10,
    });
    expect(res.status).toBe(401);
  });

  it("404s on unknown token", async () => {
    const res = await callStatus("unknown", {
      type: "StatusEvent",
      accountToken: "unknown",
      event: "credits",
      credits: 10,
    });
    expect(res.status).toBe(404);
  });

  it("session_expired: sets the global relogin flag, leaves paused_until null, updates last_seen_at", async () => {
    await seedAccount("T");
    const res = await callStatus("T", {
      type: "StatusEvent",
      accountToken: "T",
      event: "session_expired",
      at: new Date().toISOString(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT paused_until, last_seen_at FROM google_flow_accounts WHERE token = ?"
      )
      .get("T") as { paused_until: number | null; last_seen_at: number | null };
    expect(row.paused_until).toBeNull();
    expect(row.last_seen_at).not.toBeNull();

    const { getSetting } = await import("@/lib/settings");
    expect(getSetting("google_flow_relogin_needed")).toBe(true);
  });

  it("credits: updates credits + credits_updated_at, accepts optional tier fields", async () => {
    await seedAccount("T");
    const res = await callStatus("T", {
      type: "StatusEvent",
      accountToken: "T",
      event: "credits",
      credits: 250,
      tier: "pro",
      serviceTier: "STANDARD",
      sku: "VEO_3",
      at: new Date().toISOString(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT credits, credits_updated_at, last_seen_at FROM google_flow_accounts WHERE token = ?"
      )
      .get("T") as {
      credits: number | null;
      credits_updated_at: number | null;
      last_seen_at: number | null;
    };
    expect(row.credits).toBe(250);
    expect(row.credits_updated_at).not.toBeNull();
    expect(row.last_seen_at).not.toBeNull();
  });

  it("credits: accepts payload without optional tier/serviceTier/sku", async () => {
    await seedAccount("T");
    const res = await callStatus("T", {
      type: "StatusEvent",
      accountToken: "T",
      event: "credits",
      credits: 10,
    });
    expect(res.status).toBe(200);
  });

  it("accepts unknown event kinds and no-ops (advisory events like progress/rate_limited)", async () => {
    await seedAccount("T");
    const res = await callStatus("T", {
      type: "StatusEvent",
      accountToken: "T",
      event: "quantum_flux",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it("rejects a body missing required fields with 400", async () => {
    await seedAccount("T");
    const res = await callStatus("T", { type: "StatusEvent" });
    expect(res.status).toBe(400);
  });
});
