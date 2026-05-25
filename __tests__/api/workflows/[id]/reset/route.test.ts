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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-reset-"));
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

describe("POST /api/workflows/:id/reset", () => {
  it("restores a heavily-customized built-in to its seeded definition", async () => {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    db.prepare(
      `UPDATE workflows
         SET label = ?, short_label = ?, description = ?,
             script_llm_provider = ?, tts_provider = ?,
             image_provider = ?, video_provider = ?,
             enabled = 0, version = 5
         WHERE id = ?`
    ).run(
      "Mangled Label",
      "Mangle",
      "Mangled description",
      "claude_cli",
      null,
      null,
      null,
      "comfyui"
    );
    db.prepare("DELETE FROM workflow_steps WHERE workflow_id = ?").run(
      "comfyui"
    );
    db.prepare(
      "INSERT INTO workflow_steps (workflow_id, position, step_name) VALUES (?, ?, ?)"
    ).run("comfyui", 0, "write_hook");

    const { POST } = await import("@/app/api/workflows/[id]/reset/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/comfyui/reset", {
        method: "POST",
      }),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflow).toMatchObject({
      id: "comfyui",
      label: "ComfyUI (local images, local hook video)",
      shortLabel: "ComfyUI",
      description:
        "Local image generation and hook video via a self-hosted ComfyUI server.",
      isBuiltin: 1,
      enabled: 1,
      providers: {
        script: "openrouter",
        tts: "ai33",
        image: "comfyui",
        video: "comfyui",
      },
      stepCount: 3,
    });
    expect(body.workflow.version).toBe(6);
    expect(body.workflow.steps).toEqual([
      { step_name: "research_outline" },
      { step_name: "write_hook" },
      { step_name: "write_chapters" },
    ]);
  });

  it("restores the music-video builtin's kind + provider triple after mutation", async () => {
    // Plan 1 Phase 1.1 consistency fix: the reset route must restore the
    // four columns the music-video seed cares about that the narrative
    // reset path used to ignore — kind, music_provider, upscaler_provider,
    // and chunker_step. Without this, a mutated music-video builtin's
    // reset would silently leave the row in a hybrid shape.
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    db.prepare(
      `UPDATE workflows
         SET kind = ?, image_provider = ?, video_provider = ?,
             music_provider = ?, upscaler_provider = ?,
             script_llm_provider = ?, chunker_step = ?, version = 4
         WHERE id = ?`
    ).run(
      "narrative",
      "comfyui",
      "comfyui",
      null,
      "fake_upscaler",
      "openrouter",
      "chunk_clips_then_images",
      "music-video-magnific-suno"
    );

    const { POST } = await import("@/app/api/workflows/[id]/reset/route");
    const res = await POST(
      new Request(
        "http://localhost/api/workflows/music-video-magnific-suno/reset",
        { method: "POST" }
      ),
      { params: { id: "music-video-magnific-suno" } }
    );
    expect(res.status).toBe(200);

    const row = db
      .prepare("SELECT * FROM workflows WHERE id = ?")
      .get("music-video-magnific-suno") as {
      kind: string;
      script_llm_provider: string | null;
      tts_provider: string | null;
      image_provider: string | null;
      video_provider: string | null;
      music_provider: string | null;
      upscaler_provider: string | null;
      chunker_step: string | null;
    };
    expect(row.kind).toBe("music_video");
    expect(row.script_llm_provider).toBeNull();
    expect(row.tts_provider).toBeNull();
    expect(row.image_provider).toBe("magnific");
    expect(row.video_provider).toBe("magnific");
    expect(row.music_provider).toBe("suno");
    expect(row.upscaler_provider).toBeNull();
    expect(row.chunker_step).toBeNull();
  });

  it("returns 400 not_a_builtin for custom workflows", async () => {
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
      "custom",
      "Custom",
      "C",
      null,
      "openrouter",
      "ai33",
      "comfyui",
      "comfyui",
      now,
      now
    );

    const { POST } = await import("@/app/api/workflows/[id]/reset/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/custom/reset", {
        method: "POST",
      }),
      { params: { id: "custom" } }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("not_a_builtin");
  });

  it("returns 404 for unknown id", async () => {
    const { POST } = await import("@/app/api/workflows/[id]/reset/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/missing/reset", {
        method: "POST",
      }),
      { params: { id: "missing" } }
    );
    expect(res.status).toBe(404);
  });
});
