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
  tempDir = mkdtempSync(
    join(tmpdir(), "histforge-clear-captcha-recovery-")
  );
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
    "DELETE FROM google_flow_queue; DELETE FROM google_flow_accounts; DELETE FROM settings;"
  );
  seedDefaultSettings(db);
});

async function seedAccount(id: string, token: string): Promise<void> {
  const { getDb } = await import("@/lib/db");
  getDb()
    .prepare(
      `INSERT INTO google_flow_accounts (id, name, token, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(id, id, token, Math.floor(Date.now() / 1000));
}

function callClear(id: string): Promise<Response> {
  return import(
    "@/app/api/flow/accounts/[id]/clear-captcha-recovery/route"
  ).then(({ POST }) =>
    POST(
      new Request(
        `http://localhost/api/flow/accounts/${id}/clear-captcha-recovery`,
        { method: "POST" }
      ),
      { params: { id } }
    )
  );
}

describe("POST /api/flow/accounts/:id/clear-captcha-recovery", () => {
  it("clears recovery_reason + recovery_required_at on a flagged account", async () => {
    await seedAccount("acc_01", "T-01");
    const { getDb } = await import("@/lib/db");
    const gfRepo = await import("@/lib/repos/google-flow");
    gfRepo.setAccountRecoveryReason(
      getDb(),
      "acc_01",
      "captcha",
      Math.floor(Date.now() / 1000)
    );

    const res = await callClear("acc_01");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const row = getDb()
      .prepare(
        "SELECT recovery_reason, recovery_required_at FROM google_flow_accounts WHERE id = ?"
      )
      .get("acc_01") as {
      recovery_reason: string | null;
      recovery_required_at: number | null;
    };
    expect(row.recovery_reason).toBeNull();
    expect(row.recovery_required_at).toBeNull();
  });

  it("returns 404 + {error: 'unknown_account'} when the account id is unknown", async () => {
    const res = await callClear("acc_does_not_exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_account" });
  });

  it("is idempotent — clearing an already-clear account is a 200 no-op", async () => {
    await seedAccount("acc_02", "T-02");
    // Account has no recovery flag set — clearing is a no-op success.
    const res = await callClear("acc_02");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT recovery_reason, recovery_required_at FROM google_flow_accounts WHERE id = ?"
      )
      .get("acc_02") as {
      recovery_reason: string | null;
      recovery_required_at: number | null;
    };
    expect(row.recovery_reason).toBeNull();
    expect(row.recovery_required_at).toBeNull();
  });

  it("does not touch other accounts' recovery state", async () => {
    await seedAccount("acc_a", "T-A");
    await seedAccount("acc_b", "T-B");
    const { getDb } = await import("@/lib/db");
    const gfRepo = await import("@/lib/repos/google-flow");
    const now = Math.floor(Date.now() / 1000);
    gfRepo.setAccountRecoveryReason(getDb(), "acc_a", "captcha", now);
    gfRepo.setAccountRecoveryReason(getDb(), "acc_b", "captcha", now);

    const res = await callClear("acc_a");
    expect(res.status).toBe(200);

    const rowA = getDb()
      .prepare(
        "SELECT recovery_reason FROM google_flow_accounts WHERE id = ?"
      )
      .get("acc_a") as { recovery_reason: string | null };
    const rowB = getDb()
      .prepare(
        "SELECT recovery_reason FROM google_flow_accounts WHERE id = ?"
      )
      .get("acc_b") as { recovery_reason: string | null };
    expect(rowA.recovery_reason).toBeNull();
    expect(rowB.recovery_reason).toBe("captcha");
  });
});
