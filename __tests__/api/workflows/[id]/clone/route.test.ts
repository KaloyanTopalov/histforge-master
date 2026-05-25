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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-clone-"));
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
  const { getDb, seedDefaultSettings, seedDefaultWorkflows } = await import(
    "@/lib/db"
  );
  const db = getDb();
  db.exec(
    "DELETE FROM video_steps; DELETE FROM videos; DELETE FROM workflow_steps; DELETE FROM workflows; DELETE FROM settings;"
  );
  seedDefaultSettings(db);
  seedDefaultWorkflows(db);
});

describe("POST /api/workflows/:id/clone", () => {
  it("clones row + steps with defaulted label, is_builtin=0, version=1", async () => {
    const { POST } = await import("@/app/api/workflows/[id]/clone/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/comfyui/clone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ new_id: "comfyui-copy" }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.workflow).toMatchObject({
      id: "comfyui-copy",
      label: "ComfyUI (local images, local hook video) (copy)",
      shortLabel: "ComfyUI",
      isBuiltin: 0,
      enabled: 1,
      version: 1,
      providers: {
        script: "openrouter",
        tts: "ai33",
        image: "comfyui",
        video: "comfyui",
      },
      stepCount: 3,
    });
    expect(body.workflow.steps).toEqual([
      { step_name: "research_outline" },
      { step_name: "write_hook" },
      { step_name: "write_chapters" },
    ]);
  });

  it("uses provided new_label and new_short_label when given", async () => {
    const { POST } = await import("@/app/api/workflows/[id]/clone/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/comfyui/clone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          new_id: "trim",
          new_label: "Trimmed Variant",
          new_short_label: "Trim",
        }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.workflow.label).toBe("Trimmed Variant");
    expect(body.workflow.shortLabel).toBe("Trim");
  });

  it("returns 409 workflow_id_exists when new_id already exists", async () => {
    const { POST } = await import("@/app/api/workflows/[id]/clone/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/comfyui/clone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ new_id: "google-flow" }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("workflow_id_exists");
  });

  it("returns 409 when cloning into self (new_id === id)", async () => {
    const { POST } = await import("@/app/api/workflows/[id]/clone/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/comfyui/clone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ new_id: "comfyui" }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("workflow_id_exists");
  });

  it("returns 400 invalid_input on bad new_id slug", async () => {
    const { POST } = await import("@/app/api/workflows/[id]/clone/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/comfyui/clone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ new_id: "Bad Slug" }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_input");
  });

  it("returns 404 when source workflow is missing", async () => {
    const { POST } = await import("@/app/api/workflows/[id]/clone/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/missing/clone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ new_id: "anything" }),
      }),
      { params: { id: "missing" } }
    );
    expect(res.status).toBe(404);
  });
});
