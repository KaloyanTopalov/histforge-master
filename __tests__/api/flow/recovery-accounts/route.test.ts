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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-recovery-accounts-"));
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

async function callGet(): Promise<Response> {
  const { GET } = await import("@/app/api/flow/recovery-accounts/route");
  return GET();
}

describe("GET /api/flow/recovery-accounts", () => {
  it("returns an empty list when no accounts are in recovery", async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accounts: [] });
  });

  it("returns enabled flagged accounts in oldest-first order", async () => {
    const { getDb } = await import("@/lib/db");
    const gfRepo = await import("@/lib/repos/google-flow");
    const db = getDb();
    gfRepo.insertAccount(db, { id: "acc_01", name: "Newer", token: "t1", created_at: 1 });
    gfRepo.insertAccount(db, { id: "acc_02", name: "Older", token: "t2", created_at: 2 });
    gfRepo.insertAccount(db, { id: "acc_03", name: "Disabled", token: "t3", created_at: 3 });
    gfRepo.setAccountRecoveryReason(db, "acc_01", "captcha", 3_000);
    gfRepo.setAccountRecoveryReason(db, "acc_02", "captcha", 1_000);
    gfRepo.setAccountRecoveryReason(db, "acc_03", "captcha", 2_000);
    gfRepo.setAccountEnabled(db, "acc_03", false);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accounts).toEqual([
      { id: "acc_02", name: "Older", required_at: 1_000 },
      { id: "acc_01", name: "Newer", required_at: 3_000 },
    ]);
  });
});
