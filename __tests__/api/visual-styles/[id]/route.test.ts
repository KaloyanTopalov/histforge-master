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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-vs-id-"));
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

async function seed(
  id: string,
  title: string,
  prompt: string
): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const visualStylesRepo = await import("@/lib/repos/visual-styles");
  const now = 1700000000000;
  visualStylesRepo.insert(getDb(), {
    id,
    title,
    prompt,
    created_at: now,
    updated_at: now,
  });
}

describe("GET /api/visual-styles/[id]", () => {
  it("returns 404 when the row is missing", async () => {
    const { GET } = await import("@/app/api/visual-styles/[id]/route");
    const res = await GET(new Request("http://localhost/x"), {
      params: { id: "nope" },
    });
    expect(res.status).toBe(404);
  });

  it("returns { visual_style } when present", async () => {
    await seed("vs_1", "Noir", "high contrast");
    const { GET } = await import("@/app/api/visual-styles/[id]/route");
    const res = await GET(new Request("http://localhost/x"), {
      params: { id: "vs_1" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      visual_style: { id: string; title: string };
    };
    expect(body.visual_style.id).toBe("vs_1");
    expect(body.visual_style.title).toBe("Noir");
  });
});

describe("PATCH /api/visual-styles/[id]", () => {
  it("404s when the row is missing", async () => {
    const { PATCH } = await import("@/app/api/visual-styles/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New" }),
      }),
      { params: { id: "nope" } }
    );
    expect(res.status).toBe(404);
  });

  it("updates only the named field and returns the refreshed row", async () => {
    await seed("vs_1", "Old", "p1");
    const { PATCH } = await import("@/app/api/visual-styles/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New" }),
      }),
      { params: { id: "vs_1" } }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      visual_style: { title: string; prompt: string };
    };
    expect(body.visual_style.title).toBe("New");
    expect(body.visual_style.prompt).toBe("p1");
  });

  it("rejects an empty body (no fields) with 400", async () => {
    await seed("vs_1", "Old", "p1");
    const { PATCH } = await import("@/app/api/visual-styles/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: { id: "vs_1" } }
    );
    expect(res.status).toBe(400);
  });

  it("rejects empty title with 400", async () => {
    await seed("vs_1", "Old", "p1");
    const { PATCH } = await import("@/app/api/visual-styles/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "" }),
      }),
      { params: { id: "vs_1" } }
    );
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/visual-styles/[id]", () => {
  it("returns 204 when the row is deleted", async () => {
    await seed("vs_1", "X", "p");
    const { DELETE } = await import("@/app/api/visual-styles/[id]/route");
    const res = await DELETE(new Request("http://localhost/x"), {
      params: { id: "vs_1" },
    });
    expect(res.status).toBe(204);
    const { getDb } = await import("@/lib/db");
    const visualStylesRepo = await import("@/lib/repos/visual-styles");
    expect(visualStylesRepo.findById(getDb(), "vs_1")).toBeNull();
  });

  it("returns 204 when the row was already missing (no 404)", async () => {
    const { DELETE } = await import("@/app/api/visual-styles/[id]/route");
    const res = await DELETE(new Request("http://localhost/x"), {
      params: { id: "nope" },
    });
    expect(res.status).toBe(204);
  });
});
