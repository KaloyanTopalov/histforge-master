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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-magnific-status-"));
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
  db.exec("DELETE FROM settings;");
  seedDefaultSettings(db);
});

async function callStatus(
  token: string,
  body: unknown = {}
): Promise<Response> {
  const { POST } = await import("@/app/api/magnific/status/[token]/route");
  return POST(
    new Request(`http://localhost/api/magnific/status/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: { token } }
  );
}

describe("POST /api/magnific/status/:token", () => {
  it("404s on bad token", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "the-real-token");

    const res = await callStatus("not-the-token", { event: "session_expired" });
    expect(res.status).toBe(404);
  });

  it("sets magnific_relogin_needed=true on session_expired event", async () => {
    const { setSetting, getSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "T");
    expect(getSetting("magnific_relogin_needed")).toBe(false);

    const res = await callStatus("T", { event: "session_expired" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(getSetting("magnific_relogin_needed")).toBe(true);
  });

  it("accepts and no-ops on unknown advisory events (forward compatibility)", async () => {
    // Unknown events should not 400 — the extension may emit advisory
    // events HistForge doesn't track yet, and rejecting them just
    // clutters the SW console.
    const { setSetting, getSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "T");

    const res = await callStatus("T", { event: "rate_limited" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    // No-op: relogin flag stayed false.
    expect(getSetting("magnific_relogin_needed")).toBe(false);
  });

  it("400s on body missing the required event field", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "T");

    const res = await callStatus("T", {});
    expect(res.status).toBe(400);
  });
});
