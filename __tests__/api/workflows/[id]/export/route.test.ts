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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-export-"));
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

describe("GET /api/workflows/:id/export", () => {
  it("returns canonical snake_case JSON shape (lifecycle fields excluded)", async () => {
    const { GET } = await import("@/app/api/workflows/[id]/export/route");
    const res = await GET(
      new Request("http://localhost/api/workflows/comfyui/export"),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      id: "comfyui",
      label: "ComfyUI (local images, local hook video)",
      short_label: "ComfyUI",
      description:
        "Local image generation and hook video via a self-hosted ComfyUI server.",
      kind: "narrative",
      script_llm_provider: "openrouter",
      tts_provider: "ai33",
      image_provider: "comfyui",
      video_provider: "comfyui",
      music_provider: null,
      upscaler_provider: null,
      enabled: true,
      chunker_step: "chunk_clips_then_images",
      steps: [
        { step_name: "research_outline" },
        { step_name: "write_hook" },
        { step_name: "write_chapters" },
      ],
    });
    expect(body).not.toHaveProperty("version");
    expect(body).not.toHaveProperty("created_at");
    expect(body).not.toHaveProperty("updated_at");
    expect(body).not.toHaveProperty("is_builtin");
  });

  it("emits the row's chunker_step verbatim (round-trip parity)", async () => {
    const { getDb } = await import("@/lib/db");
    getDb()
      .prepare("UPDATE workflows SET chunker_step = ? WHERE id = ?")
      .run("chunk_images_only", "comfyui");

    const { GET } = await import("@/app/api/workflows/[id]/export/route");
    const res = await GET(
      new Request("http://localhost/api/workflows/comfyui/export"),
      { params: { id: "comfyui" } }
    );
    const body = await res.json();
    expect(body.chunker_step).toBe("chunk_images_only");
  });

  it("emits literal null for unset nullable fields (description, providers)", async () => {
    const { getDb } = await import("@/lib/db");
    getDb()
      .prepare(
        "UPDATE workflows SET description = NULL, tts_provider = NULL, image_provider = NULL, video_provider = NULL WHERE id = ?"
      )
      .run("comfyui");

    const { GET } = await import("@/app/api/workflows/[id]/export/route");
    const res = await GET(
      new Request("http://localhost/api/workflows/comfyui/export"),
      { params: { id: "comfyui" } }
    );
    const body = await res.json();
    expect(body.description).toBeNull();
    expect(body.tts_provider).toBeNull();
    expect(body.image_provider).toBeNull();
    expect(body.video_provider).toBeNull();
    expect(Object.keys(body)).toContain("description");
    expect(Object.keys(body)).toContain("tts_provider");
  });

  it("sets Content-Disposition: attachment with filename=<id>.json", async () => {
    const { GET } = await import("@/app/api/workflows/[id]/export/route");
    const res = await GET(
      new Request("http://localhost/api/workflows/comfyui/export"),
      { params: { id: "comfyui" } }
    );
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="comfyui.json"'
    );
  });

  it("returns 404 when the workflow does not exist", async () => {
    const { GET } = await import("@/app/api/workflows/[id]/export/route");
    const res = await GET(
      new Request("http://localhost/api/workflows/missing/export"),
      { params: { id: "missing" } }
    );
    expect(res.status).toBe(404);
  });

  it("emits kind + music-video columns and the music-video builtin payload round-trips through WorkflowImportSchema", async () => {
    const { GET } = await import("@/app/api/workflows/[id]/export/route");
    const { WorkflowImportSchema } = await import(
      "@/lib/workflows-schema"
    );
    const res = await GET(
      new Request(
        "http://localhost/api/workflows/music-video-magnific-suno/export"
      ),
      { params: { id: "music-video-magnific-suno" } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: "music-video-magnific-suno",
      kind: "music_video",
      script_llm_provider: null,
      tts_provider: null,
      image_provider: "magnific",
      video_provider: "magnific",
      music_provider: "suno",
      upscaler_provider: null,
      chunker_step: null,
      steps: [],
    });
    const parsed = WorkflowImportSchema.safeParse(body);
    expect(parsed.success).toBe(true);
  });

  it("emits kind='narrative' on narrative rows and the export payload round-trips through WorkflowImportSchema", async () => {
    const { GET } = await import("@/app/api/workflows/[id]/export/route");
    const { WorkflowImportSchema } = await import(
      "@/lib/workflows-schema"
    );
    const res = await GET(
      new Request("http://localhost/api/workflows/comfyui/export"),
      { params: { id: "comfyui" } }
    );
    const body = await res.json();
    expect(body.kind).toBe("narrative");
    expect(body.music_provider).toBeNull();
    expect(body.upscaler_provider).toBeNull();
    const parsed = WorkflowImportSchema.safeParse(body);
    expect(parsed.success).toBe(true);
  });
});
