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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-workflow-id-"));
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

describe("PATCH /api/workflows/:id", () => {
  it("updates fields and bumps version", async () => {
    const { PATCH } = await import("@/app/api/workflows/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/workflows/comfyui", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_version: 1,
          label: "ComfyUI Renamed",
          short_label: "CFY",
        }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflow).toMatchObject({
      id: "comfyui",
      label: "ComfyUI Renamed",
      shortLabel: "CFY",
      version: 2,
    });
  });

  it("returns 404 for unknown id", async () => {
    const { PATCH } = await import("@/app/api/workflows/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/workflows/missing", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_version: 1, label: "x" }),
      }),
      { params: { id: "missing" } }
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 version_conflict on stale expected_version", async () => {
    const { PATCH } = await import("@/app/api/workflows/[id]/route");
    const first = await PATCH(
      new Request("http://localhost/api/workflows/comfyui", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_version: 1, label: "first" }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(first.status).toBe(200);

    const second = await PATCH(
      new Request("http://localhost/api/workflows/comfyui", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_version: 1, label: "second" }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body).toMatchObject({
      error: "version_conflict",
      current_version: 2,
    });
  });

  it("replaces the step list when steps is present", async () => {
    const { PATCH } = await import("@/app/api/workflows/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/workflows/comfyui", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_version: 1,
          steps: [
            { step_name: "write_hook" },
            { step_name: "write_chapters" },
          ],
        }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflow.steps).toEqual([
      { step_name: "write_hook" },
      { step_name: "write_chapters" },
    ]);
    expect(body.workflow.stepCount).toBe(2);
  });

  it("toggles `enabled` from boolean body to 0/1 in SQLite", async () => {
    const { PATCH } = await import("@/app/api/workflows/[id]/route");
    const off = await PATCH(
      new Request("http://localhost/api/workflows/comfyui", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_version: 1, enabled: false }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(off.status).toBe(200);
    expect((await off.json()).workflow.enabled).toBe(0);

    const on = await PATCH(
      new Request("http://localhost/api/workflows/comfyui", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_version: 2, enabled: true }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(on.status).toBe(200);
    expect((await on.json()).workflow.enabled).toBe(1);
  });

  it("writes SQL NULL for description when explicitly null", async () => {
    const { PATCH } = await import("@/app/api/workflows/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/workflows/comfyui", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_version: 1, description: null }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflow.description).toBeNull();
  });

  it("returns 400 when expected_version is missing", async () => {
    const { PATCH } = await import("@/app/api/workflows/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/workflows/comfyui", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "x" }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_input");
  });

  it("rejects non-script step_name with 400 invalid_input", async () => {
    const { PATCH } = await import("@/app/api/workflows/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/workflows/comfyui", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_version: 1,
          steps: [{ step_name: "voiceover" }],
        }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_input");
  });

  it("ignores `id` in body (slug not writable from PATCH)", async () => {
    const { PATCH } = await import("@/app/api/workflows/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/workflows/comfyui", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_version: 1,
          id: "renamed-slug",
          label: "still comfyui",
        }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflow.id).toBe("comfyui");

    const { getDb } = await import("@/lib/db");
    const renamed = getDb()
      .prepare("SELECT id FROM workflows WHERE id = ?")
      .get("renamed-slug");
    expect(renamed).toBeUndefined();
  });

  it("allows editing built-in workflows", async () => {
    const { PATCH } = await import("@/app/api/workflows/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/workflows/comfyui", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_version: 1,
          label: "Built-in Edited",
        }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflow.label).toBe("Built-in Edited");
    expect(body.workflow.isBuiltin).toBe(1);
  });

  it("returns warnings: [] on a clean PATCH (additive contract)", async () => {
    const { PATCH } = await import("@/app/api/workflows/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/workflows/comfyui", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_version: 1, label: "Renamed" }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings).toEqual([]);
  });

  it("returns warnings array when PATCH removes a producer (write_hook)", async () => {
    const { PATCH } = await import("@/app/api/workflows/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/workflows/comfyui", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_version: 1,
          steps: [
            { step_name: "research_outline" },
            { step_name: "write_chapters" },
          ],
        }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Save is never blocked by warnings.
    expect(body.workflow.version).toBe(2);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings).toHaveLength(1);
    const w = body.warnings[0];
    expect(w.step_name).toBe("assemble_script");
    expect(w.missing_input).toBe("script/03_hook.md");
    // Phase 6's drafts UI consumes `message` directly per Invariant D —
    // confirm the route surfaces the validator's human-readable text.
    expect(typeof w.message).toBe("string");
    expect(w.message).toContain("script/03_hook.md");
  });

  it("returns a chunker_step consistency warning when PATCH nulls image_provider on a clips-then-images workflow", async () => {
    // Seeded comfyui workflow uses chunk_clips_then_images, which requires
    // both providers. Setting image_provider=null violates the rule;
    // validateChunkerStepConsistency must surface it alongside any
    // input-availability warnings.
    const { PATCH } = await import("@/app/api/workflows/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/workflows/comfyui", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_version: 1,
          image_provider: null,
        }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Save is never blocked.
    expect(body.workflow.version).toBe(2);
    const chunkerWarnings = body.warnings.filter(
      (w: { step_name: string }) => w.step_name === "chunk_clips_then_images"
    );
    expect(chunkerWarnings).toHaveLength(1);
    expect(chunkerWarnings[0].missing_input).toBe("image_provider");
  });

  it("PATCH without `steps` still validates against the unchanged step list", async () => {
    // Seed a custom workflow whose step list is already broken (missing
    // write_hook), then PATCH only the label. The validator must read
    // the unchanged steps from DB and still warn.
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO workflows
         (id, label, short_label, description, script_llm_provider,
          tts_provider, image_provider, video_provider,
          is_builtin, enabled, version, created_at, updated_at,
          chunker_step)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 1, ?, ?, ?)`
    ).run(
      "preexisting-broken",
      "Broken",
      "B",
      null,
      "openrouter",
      "ai33",
      "comfyui",
      "comfyui",
      now,
      now,
      "chunk_clips_then_images"
    );
    db.prepare(
      "INSERT INTO workflow_steps (workflow_id, position, step_name) VALUES (?, ?, ?)"
    ).run("preexisting-broken", 0, "research_outline");
    db.prepare(
      "INSERT INTO workflow_steps (workflow_id, position, step_name) VALUES (?, ?, ?)"
    ).run("preexisting-broken", 1, "write_chapters");

    const { PATCH } = await import("@/app/api/workflows/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/workflows/preexisting-broken", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_version: 1, label: "Renamed" }),
      }),
      { params: { id: "preexisting-broken" } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0].step_name).toBe("assemble_script");
    expect(body.warnings[0].missing_input).toBe("script/03_hook.md");
  });

  it("clone+PATCH removing write_hook surfaces a warning end-to-end", async () => {
    const { POST: CLONE } = await import(
      "@/app/api/workflows/[id]/clone/route"
    );
    const cloneRes = await CLONE(
      new Request("http://localhost/api/workflows/comfyui/clone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ new_id: "comfyui-broken" }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(cloneRes.status).toBe(201);
    const clonedVersion = (await cloneRes.json()).workflow.version;

    const { PATCH } = await import("@/app/api/workflows/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/workflows/comfyui-broken", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_version: clonedVersion,
          steps: [
            { step_name: "research_outline" },
            { step_name: "write_chapters" },
          ],
        }),
      }),
      { params: { id: "comfyui-broken" } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflow.version).toBe(clonedVersion + 1);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0].step_name).toBe("assemble_script");
    expect(body.warnings[0].missing_input).toBe("script/03_hook.md");
  });

  it("chained PATCH removing write_hook propagates a warning into assemble_script glue", async () => {
    const { POST: CLONE } = await import(
      "@/app/api/workflows/[id]/clone/route"
    );
    const cloneRes = await CLONE(
      new Request("http://localhost/api/workflows/comfyui/clone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ new_id: "comfyui-broken" }),
      }),
      { params: { id: "comfyui" } }
    );
    const clonedVersion = (await cloneRes.json()).workflow.version;

    const { PATCH } = await import("@/app/api/workflows/[id]/route");
    const first = await PATCH(
      new Request("http://localhost/api/workflows/comfyui-broken", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_version: clonedVersion,
          label: "Renamed",
        }),
      }),
      { params: { id: "comfyui-broken" } }
    );
    expect(first.status).toBe(200);
    const firstVersion = (await first.json()).workflow.version;
    expect(firstVersion).toBe(clonedVersion + 1);

    const second = await PATCH(
      new Request("http://localhost/api/workflows/comfyui-broken", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_version: firstVersion,
          steps: [
            { step_name: "research_outline" },
            { step_name: "write_chapters" },
          ],
        }),
      }),
      { params: { id: "comfyui-broken" } }
    );
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.workflow.version).toBe(firstVersion + 1);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0].step_name).toBe("assemble_script");
    expect(body.warnings[0].missing_input).toBe("script/03_hook.md");
  });

  it("clean clone + no-op label PATCH returns warnings: []", async () => {
    const { POST: CLONE } = await import(
      "@/app/api/workflows/[id]/clone/route"
    );
    const cloneRes = await CLONE(
      new Request("http://localhost/api/workflows/comfyui/clone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ new_id: "comfyui-clean" }),
      }),
      { params: { id: "comfyui" } }
    );
    const clonedVersion = (await cloneRes.json()).workflow.version;

    const { PATCH } = await import("@/app/api/workflows/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/workflows/comfyui-clean", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_version: clonedVersion,
          label: "Renamed copy",
        }),
      }),
      { params: { id: "comfyui-clean" } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflow.version).toBe(clonedVersion + 1);
    expect(body.warnings).toEqual([]);
  });

  it("writes chunker_step when present in the body", async () => {
    const { PATCH } = await import("@/app/api/workflows/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/workflows/comfyui", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_version: 1,
          chunker_step: "chunk_images_only",
        }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(200);
    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT chunker_step FROM workflows WHERE id = ?")
      .get("comfyui") as { chunker_step: string };
    expect(row.chunker_step).toBe("chunk_images_only");
  });

  it("preserves chunker_step when body omits it (partial PATCH)", async () => {
    const { getDb } = await import("@/lib/db");
    // Seed a non-default chunker_step so the test catches an unwanted reset.
    getDb()
      .prepare("UPDATE workflows SET chunker_step = ? WHERE id = ?")
      .run("chunk_images_only", "comfyui");

    const { PATCH } = await import("@/app/api/workflows/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/workflows/comfyui", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_version: 1, label: "Renamed" }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(200);

    const row = getDb()
      .prepare("SELECT chunker_step FROM workflows WHERE id = ?")
      .get("comfyui") as { chunker_step: string };
    expect(row.chunker_step).toBe("chunk_images_only");
  });

  it("does not include warnings on 409 version_conflict (validator only runs on success)", async () => {
    const { PATCH } = await import("@/app/api/workflows/[id]/route");
    await PATCH(
      new Request("http://localhost/api/workflows/comfyui", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_version: 1, label: "first" }),
      }),
      { params: { id: "comfyui" } }
    );
    const stale = await PATCH(
      new Request("http://localhost/api/workflows/comfyui", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_version: 1, label: "second" }),
      }),
      { params: { id: "comfyui" } }
    );
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body).not.toHaveProperty("warnings");
  });
});

describe("DELETE /api/workflows/:id", () => {
  it("returns 400 cannot_delete_builtin for built-in rows", async () => {
    const { DELETE } = await import("@/app/api/workflows/[id]/route");
    const res = await DELETE(
      new Request("http://localhost/api/workflows/comfyui", {
        method: "DELETE",
      }),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("cannot_delete_builtin");

    const { getDb } = await import("@/lib/db");
    const stillThere = getDb()
      .prepare("SELECT id FROM workflows WHERE id = ?")
      .get("comfyui");
    expect(stillThere).toEqual({ id: "comfyui" });
  });

  it("returns 409 workflow_in_use with videos_count when used by videos", async () => {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO workflows
         (id, label, short_label, description, script_llm_provider,
          tts_provider, image_provider, video_provider,
          is_builtin, enabled, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 1, ?, ?)`
    ).run(
      "in-use",
      "In Use",
      "Use",
      null,
      "openrouter",
      "ai33",
      "comfyui",
      "comfyui",
      now,
      now
    );
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("v1", "T", "topic", "in-use", "new", now);

    const { DELETE } = await import("@/app/api/workflows/[id]/route");
    const res = await DELETE(
      new Request("http://localhost/api/workflows/in-use", {
        method: "DELETE",
      }),
      { params: { id: "in-use" } }
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: "workflow_in_use", videos_count: 1 });

    const stillThere = db
      .prepare("SELECT id FROM workflows WHERE id = ?")
      .get("in-use");
    expect(stillThere).toEqual({ id: "in-use" });
  });

  it("deletes a custom unused workflow + cascades workflow_steps", async () => {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO workflows
         (id, label, short_label, description, script_llm_provider,
          tts_provider, image_provider, video_provider,
          is_builtin, enabled, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 1, ?, ?)`
    ).run(
      "unused",
      "Unused",
      "U",
      null,
      "openrouter",
      "ai33",
      "comfyui",
      "comfyui",
      now,
      now
    );
    db.prepare(
      "INSERT INTO workflow_steps (workflow_id, position, step_name) VALUES (?, ?, ?)"
    ).run("unused", 0, "research_outline");

    const { DELETE } = await import("@/app/api/workflows/[id]/route");
    const res = await DELETE(
      new Request("http://localhost/api/workflows/unused", {
        method: "DELETE",
      }),
      { params: { id: "unused" } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ deleted: true });

    const row = db
      .prepare("SELECT id FROM workflows WHERE id = ?")
      .get("unused");
    expect(row).toBeUndefined();
    const steps = db
      .prepare("SELECT 1 FROM workflow_steps WHERE workflow_id = ?")
      .all("unused");
    expect(steps).toEqual([]);
  });

  it("returns 404 for unknown id", async () => {
    const { DELETE } = await import("@/app/api/workflows/[id]/route");
    const res = await DELETE(
      new Request("http://localhost/api/workflows/missing", {
        method: "DELETE",
      }),
      { params: { id: "missing" } }
    );
    expect(res.status).toBe(404);
  });
});
