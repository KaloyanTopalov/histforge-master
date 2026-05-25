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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-vs-list-"));
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
  db.exec("DELETE FROM visual_styles; DELETE FROM settings;");
  seedDefaultSettings(db);
});

describe("GET /api/visual-styles", () => {
  it("returns an empty envelope when the table is empty", async () => {
    const { GET } = await import("@/app/api/visual-styles/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ visual_styles: [] });
  });

  it("returns rows alphabetically by title (case-insensitive)", async () => {
    const { getDb } = await import("@/lib/db");
    const visualStylesRepo = await import("@/lib/repos/visual-styles");
    const db = getDb();
    visualStylesRepo.insert(db, {
      id: "a",
      title: "banana",
      prompt: "p1",
      created_at: 1,
      updated_at: 1,
    });
    visualStylesRepo.insert(db, {
      id: "b",
      title: "Apple",
      prompt: "p2",
      created_at: 2,
      updated_at: 2,
    });
    const { GET } = await import("@/app/api/visual-styles/route");
    const res = await GET();
    const body = (await res.json()) as {
      visual_styles: { title: string }[];
    };
    expect(body.visual_styles.map((r) => r.title)).toEqual([
      "Apple",
      "banana",
    ]);
  });
});

describe("POST /api/visual-styles", () => {
  it("creates a row with created_at == updated_at, returns 201", async () => {
    const { POST } = await import("@/app/api/visual-styles/route");
    const res = await POST(
      new Request("http://localhost/api/visual-styles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Noir", prompt: "high contrast" }),
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      visual_style: {
        id: string;
        title: string;
        prompt: string;
        created_at: number;
        updated_at: number;
      };
    };
    expect(body.visual_style.title).toBe("Noir");
    expect(body.visual_style.prompt).toBe("high contrast");
    expect(typeof body.visual_style.id).toBe("string");
    expect(body.visual_style.id.length).toBeGreaterThan(0);
    expect(body.visual_style.created_at).toBe(body.visual_style.updated_at);
  });

  it("rejects an empty title with 400 invalid_input", async () => {
    const { POST } = await import("@/app/api/visual-styles/route");
    const res = await POST(
      new Request("http://localhost/api/visual-styles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "", prompt: "x" }),
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_input");
  });

  it("accepts an empty prompt string", async () => {
    const { POST } = await import("@/app/api/visual-styles/route");
    const res = await POST(
      new Request("http://localhost/api/visual-styles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Minimal", prompt: "" }),
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      visual_style: { prompt: string };
    };
    expect(body.visual_style.prompt).toBe("");
  });
});
