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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-import-"));
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

const VALID_PAYLOAD = {
  id: "imported",
  label: "Imported",
  short_label: "Imp",
  description: "From a JSON file",
  script_llm_provider: "openrouter",
  tts_provider: "ai33",
  image_provider: "comfyui",
  video_provider: "comfyui",
  enabled: true,
  steps: [
    { step_name: "research_outline" },
    { step_name: "write_hook" },
  ],
};

describe("POST /api/workflows/import", () => {
  it("inserts a new row with is_builtin=0, version=1 and returns 201", async () => {
    const { POST } = await import("@/app/api/workflows/import/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(VALID_PAYLOAD),
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.workflow).toMatchObject({
      id: "imported",
      label: "Imported",
      shortLabel: "Imp",
      description: "From a JSON file",
      isBuiltin: 0,
      enabled: 1,
      version: 1,
      stepCount: 2,
    });
  });

  it("returns 409 when id exists and ?overwrite is not set", async () => {
    const { POST } = await import("@/app/api/workflows/import/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...VALID_PAYLOAD, id: "comfyui" }),
      })
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      error: "workflow_id_exists",
      current_version: 1,
    });
  });

  it("overwrites an existing custom row with ?overwrite=1 (200, version bumped)", async () => {
    const { POST: importPost } = await import(
      "@/app/api/workflows/import/route"
    );
    const create = await importPost(
      new Request("http://localhost/api/workflows/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(VALID_PAYLOAD),
      })
    );
    expect(create.status).toBe(201);

    const overwrite = await importPost(
      new Request("http://localhost/api/workflows/import?overwrite=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...VALID_PAYLOAD,
          label: "Imported v2",
          steps: [{ step_name: "write_chapters" }],
        }),
      })
    );
    expect(overwrite.status).toBe(200);
    const body = await overwrite.json();
    expect(body.workflow).toMatchObject({
      id: "imported",
      label: "Imported v2",
      isBuiltin: 0,
      version: 2,
      stepCount: 1,
    });
    expect(body.workflow.steps).toEqual([{ step_name: "write_chapters" }]);
  });

  it("preserves is_builtin=1 when overwriting a built-in", async () => {
    const { POST } = await import("@/app/api/workflows/import/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/import?overwrite=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...VALID_PAYLOAD,
          id: "comfyui",
          label: "Edited Builtin",
        }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflow).toMatchObject({
      id: "comfyui",
      label: "Edited Builtin",
      isBuiltin: 1,
      version: 2,
    });
  });

  it("returns 400 invalid_input on bad shape", async () => {
    const { POST } = await import("@/app/api/workflows/import/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "bad", label: "x" }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_input");
  });

  it("strips is_builtin from the body for new rows (forces 0)", async () => {
    const { POST } = await import("@/app/api/workflows/import/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...VALID_PAYLOAD,
          id: "sneaky",
          is_builtin: 1,
        }),
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.workflow.isBuiltin).toBe(0);
  });

  it("returns warnings: [] on a clean new-row import (additive contract)", async () => {
    const { POST } = await import("@/app/api/workflows/import/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...VALID_PAYLOAD,
          id: "clean-import",
          steps: [
            { step_name: "research_outline" },
            { step_name: "write_hook" },
            { step_name: "write_chapters" },
          ],
        }),
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warnings).toEqual([]);
  });

  it("returns warnings on a broken new-row import (still 201)", async () => {
    const { POST } = await import("@/app/api/workflows/import/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...VALID_PAYLOAD,
          id: "broken-import",
          steps: [
            { step_name: "research_outline" },
            { step_name: "write_chapters" },
          ],
        }),
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0].step_name).toBe("assemble_script");
  });

  it("returns warnings on the overwrite branch too", async () => {
    const { POST } = await import("@/app/api/workflows/import/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/import?overwrite=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...VALID_PAYLOAD,
          id: "comfyui",
          steps: [
            { step_name: "research_outline" },
            { step_name: "write_chapters" },
          ],
        }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0].step_name).toBe("assemble_script");
  });

  it("round-trips: export a workflow → re-import under a different id", async () => {
    const { GET: exportGet } = await import(
      "@/app/api/workflows/[id]/export/route"
    );
    const { POST: importPost } = await import(
      "@/app/api/workflows/import/route"
    );

    const exportRes = await exportGet(
      new Request("http://localhost/api/workflows/comfyui/export"),
      { params: { id: "comfyui" } }
    );
    expect(exportRes.status).toBe(200);
    const exported = await exportRes.json();

    const reimport = await importPost(
      new Request("http://localhost/api/workflows/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...exported, id: "comfyui-roundtrip" }),
      })
    );
    expect(reimport.status).toBe(201);
    const body = await reimport.json();
    expect(body.workflow).toMatchObject({
      id: "comfyui-roundtrip",
      label: exported.label,
      shortLabel: exported.short_label,
      description: exported.description,
      isBuiltin: 0,
      enabled: 1,
      version: 1,
      providers: {
        script: exported.script_llm_provider,
        tts: exported.tts_provider,
        image: exported.image_provider,
        video: exported.video_provider,
      },
    });
    expect(body.workflow.steps).toEqual(exported.steps);
  });
});
