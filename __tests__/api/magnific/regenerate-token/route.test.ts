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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-magnific-regen-"));
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

async function callRegenerate(): Promise<Response> {
  const { POST } = await import(
    "@/app/api/magnific/regenerate-token/route"
  );
  return POST(
    new Request("http://localhost/api/magnific/regenerate-token", {
      method: "POST",
    })
  );
}

describe("POST /api/magnific/regenerate-token", () => {
  it("mints a new token, persists it, and returns it in the response body", async () => {
    const { getSetting } = await import("@/lib/settings");
    expect(getSetting("magnific_token")).toBe("");

    const res = await callRegenerate();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(20);
    expect(getSetting("magnific_token")).toBe(body.token);
  });

  it("returns a different token on each call (real entropy, not stubbed)", async () => {
    const first = (await (await callRegenerate()).json()) as { token: string };
    const second = (await (await callRegenerate()).json()) as { token: string };
    expect(second.token).not.toBe(first.token);
  });
});
