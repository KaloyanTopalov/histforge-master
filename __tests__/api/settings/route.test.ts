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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-settings-"));
  process.env.DATABASE_URL = join(tempDir, "test.db");
});

afterAll(async () => {
  const { getDb } = await import("@/lib/db");
  try {
    getDb().close();
  } catch {
    // already closed
  }
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { getDb, seedDefaultSettings } = await import("@/lib/db");
  const db = getDb();
  // Reset settings to defaults between tests.
  db.exec("DELETE FROM settings;");
  seedDefaultSettings(db);
});

function patchRequest(body: unknown): Request {
  return new Request("http://localhost/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/settings", () => {
  it("returns all settings keys with their native-typed values", async () => {
    const { GET } = await import("@/app/api/settings/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    // Spot-check representative types — getAllSettings is already
    // exhaustively tested in __tests__/unit/lib/settings.test.ts.
    expect(body.script_length_minutes).toBe(90);
    expect(body.voice_stability).toBe(0.75);
    expect(body.voice_use_speaker_boost).toBe(true);
    expect(body.aspect_ratio).toBe("16:9");
  });
});

describe("PATCH /api/settings", () => {
  it("updates valid keys and persists them", async () => {
    const { PATCH } = await import("@/app/api/settings/route");
    const res = await PATCH(
      patchRequest({
        openrouter_script_model: "openai/gpt-4o",
        voice_stability: 0.5,
      })
    );
    expect(res.status).toBe(200);

    const { getSetting } = await import("@/lib/settings");
    expect(getSetting("openrouter_script_model")).toBe("openai/gpt-4o");
    expect(getSetting("voice_stability")).toBe(0.5);
  });

  it("rejects out-of-range numeric values with 400 and does not persist", async () => {
    const { PATCH } = await import("@/app/api/settings/route");
    // voice_speed is constrained to 0.7..1.2 in the schema.
    const res = await PATCH(patchRequest({ voice_speed: 2.0 }));
    expect(res.status).toBe(400);

    const { getSetting } = await import("@/lib/settings");
    expect(getSetting("voice_speed")).toBe(1.0); // untouched
  });

  it("rejects invalid enum values with 400", async () => {
    const { PATCH } = await import("@/app/api/settings/route");
    const res = await PATCH(patchRequest({ aspect_ratio: "21:9" }));
    expect(res.status).toBe(400);
  });

  it("rejects unknown keys with 400", async () => {
    const { PATCH } = await import("@/app/api/settings/route");
    const res = await PATCH(patchRequest({ not_a_real_key: 42 }));
    expect(res.status).toBe(400);
  });

});
