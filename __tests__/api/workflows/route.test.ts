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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-api-workflows-"));
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

describe("GET /api/workflows", () => {
  it("returns the seeded built-in workflows as camelCase with stepCount", async () => {
    const { GET } = await import("@/app/api/workflows/route");
    const res = await GET(new Request("http://localhost/api/workflows"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.workflows)).toBe(true);
    expect(body.workflows).toHaveLength(6);

    const comfyui = body.workflows.find(
      (w: { id: string }) => w.id === "comfyui"
    );
    expect(comfyui).toMatchObject({
      id: "comfyui",
      label: "ComfyUI (local images, local hook video)",
      shortLabel: "ComfyUI",
      isBuiltin: 1,
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
    expect(comfyui).not.toHaveProperty("short_label");
    expect(comfyui).not.toHaveProperty("is_builtin");
  });

  it("excludes disabled rows when ?enabled=1 is passed", async () => {
    const { getDb } = await import("@/lib/db");
    getDb().prepare("UPDATE workflows SET enabled = 0 WHERE id = ?").run(
      "google-flow"
    );

    const { GET } = await import("@/app/api/workflows/route");
    const res = await GET(
      new Request("http://localhost/api/workflows?enabled=1")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflows.map((w: { id: string }) => w.id).sort()).toEqual([
      "comfyui",
      "google-flow-clips-only",
      "google-flow-images-only",
      "music-video-magnific-suno",
      "narrative-magnific-nano-banana",
    ]);
  });

  it("returns disabled rows when no ?enabled filter is set", async () => {
    const { getDb } = await import("@/lib/db");
    getDb().prepare("UPDATE workflows SET enabled = 0 WHERE id = ?").run(
      "google-flow"
    );

    const { GET } = await import("@/app/api/workflows/route");
    const res = await GET(new Request("http://localhost/api/workflows"));
    const body = await res.json();
    expect(body.workflows.map((w: { id: string }) => w.id).sort()).toEqual([
      "comfyui",
      "google-flow",
      "google-flow-clips-only",
      "google-flow-images-only",
      "music-video-magnific-suno",
      "narrative-magnific-nano-banana",
    ]);
  });
});

describe("GET /api/workflows/[id]", () => {
  it("returns the workflow with its steps array and camelCase fields", async () => {
    const { GET } = await import("@/app/api/workflows/[id]/route");
    const res = await GET(
      new Request("http://localhost/api/workflows/comfyui"),
      { params: { id: "comfyui" } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflow).toMatchObject({
      id: "comfyui",
      label: "ComfyUI (local images, local hook video)",
      shortLabel: "ComfyUI",
      isBuiltin: 1,
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

  it("returns 404 for an unknown id", async () => {
    const { GET } = await import("@/app/api/workflows/[id]/route");
    const res = await GET(
      new Request("http://localhost/api/workflows/ghost"),
      { params: { id: "ghost" } }
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/workflows", () => {
  it("creates a new workflow + steps and returns 201 with camelCase detail", async () => {
    const { POST } = await import("@/app/api/workflows/route");
    const res = await POST(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "custom-flow",
          label: "Custom Flow",
          short_label: "Custom",
          description: "A custom workflow",
          script_llm_provider: "openrouter",
          tts_provider: "ai33",
          image_provider: "comfyui",
          video_provider: "comfyui",
          steps: [
            { step_name: "research_outline" },
            { step_name: "write_hook" },
          ],
        }),
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.workflow).toMatchObject({
      id: "custom-flow",
      label: "Custom Flow",
      shortLabel: "Custom",
      description: "A custom workflow",
      isBuiltin: 0,
      enabled: 1,
      version: 1,
      providers: {
        script: "openrouter",
        tts: "ai33",
        image: "comfyui",
        video: "comfyui",
      },
      stepCount: 2,
    });
    expect(body.workflow.steps).toEqual([
      { step_name: "research_outline" },
      { step_name: "write_hook" },
    ]);
  });

  it("returns 409 workflow_id_exists when the slug collides", async () => {
    const { POST } = await import("@/app/api/workflows/route");
    const res = await POST(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "comfyui",
          label: "Dup",
          short_label: "D",
          script_llm_provider: "openrouter",
          tts_provider: null,
          image_provider: null,
          video_provider: null,
          steps: [],
        }),
      })
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("workflow_id_exists");
  });

  it("returns 400 invalid_input on Zod failure (non-script step_name)", async () => {
    const { POST } = await import("@/app/api/workflows/route");
    const res = await POST(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "tts-step",
          label: "TTS Step",
          short_label: "TTS",
          script_llm_provider: "openrouter",
          tts_provider: "ai33",
          image_provider: "comfyui",
          video_provider: "comfyui",
          steps: [{ step_name: "voiceover" }],
        }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_input");
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it("returns warnings: [] on a clean POST (additive contract)", async () => {
    const { POST } = await import("@/app/api/workflows/route");
    const res = await POST(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "clean-flow",
          label: "Clean",
          short_label: "C",
          script_llm_provider: "openrouter",
          tts_provider: "ai33",
          image_provider: "comfyui",
          video_provider: "comfyui",
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

  it("returns warnings array but still 201 when steps are missing producers", async () => {
    const { POST } = await import("@/app/api/workflows/route");
    const res = await POST(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "broken-flow",
          label: "Broken",
          short_label: "B",
          script_llm_provider: "openrouter",
          tts_provider: "ai33",
          image_provider: "comfyui",
          video_provider: "comfyui",
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
    expect(body.warnings[0].missing_input).toBe("script/03_hook.md");
  });

  it("propagates chunker_step from body to the created row", async () => {
    const { POST } = await import("@/app/api/workflows/route");
    const res = await POST(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "images-only-flow",
          label: "Images Only",
          short_label: "Img",
          script_llm_provider: "openrouter",
          tts_provider: "ai33",
          image_provider: "google_flow",
          video_provider: null,
          chunker_step: "chunk_images_only",
          steps: [{ step_name: "research_outline" }],
        }),
      })
    );
    expect(res.status).toBe(201);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT chunker_step FROM workflows WHERE id = ?")
      .get("images-only-flow") as { chunker_step: string };
    expect(row.chunker_step).toBe("chunk_images_only");
  });

  it("defaults chunker_step to chunk_clips_then_images when body omits it", async () => {
    const { POST } = await import("@/app/api/workflows/route");
    const res = await POST(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "default-chunker-flow",
          label: "Default Chunker",
          short_label: "Def",
          script_llm_provider: "openrouter",
          tts_provider: "ai33",
          image_provider: "comfyui",
          video_provider: "comfyui",
          steps: [{ step_name: "research_outline" }],
        }),
      })
    );
    expect(res.status).toBe(201);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT chunker_step FROM workflows WHERE id = ?")
      .get("default-chunker-flow") as { chunker_step: string };
    expect(row.chunker_step).toBe("chunk_clips_then_images");
  });

  it("surfaces chunker_step consistency warnings alongside input-availability ones", async () => {
    // images-only requires image_provider set + video_provider null.
    // Setting video_provider violates the rule; the POST surface should
    // emit the warning the same way PATCH / validate do.
    const { POST } = await import("@/app/api/workflows/route");
    const res = await POST(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "inconsistent-images-only",
          label: "Bad images-only",
          short_label: "Bad",
          script_llm_provider: "openrouter",
          tts_provider: "ai33",
          image_provider: "google_flow",
          video_provider: "google_flow",
          chunker_step: "chunk_images_only",
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
    const chunkerWarnings = body.warnings.filter(
      (w: { step_name: string }) => w.step_name === "chunk_images_only"
    );
    expect(chunkerWarnings).toHaveLength(1);
    expect(chunkerWarnings[0].missing_input).toBe("video_provider");
  });

  it("returns 400 invalid_input on bad slug regex", async () => {
    const { POST } = await import("@/app/api/workflows/route");
    const res = await POST(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "Bad_Slug",
          label: "x",
          short_label: "x",
          script_llm_provider: "openrouter",
          tts_provider: null,
          image_provider: null,
          video_provider: null,
          steps: [],
        }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("rejects kind='music_video' with 400 (editor POST is narrative-only)", async () => {
    // Music-video workflows ship pre-seeded; the editor doesn't author
    // them. Round-trip JSON imports of music_video drafts go through
    // POST /api/workflows/import, which honors `data.kind` directly.
    const { POST } = await import("@/app/api/workflows/route");
    const res = await POST(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "music-video-via-editor",
          label: "MV via editor",
          short_label: "MV",
          kind: "music_video",
          script_llm_provider: null,
          tts_provider: null,
          image_provider: "magnific",
          video_provider: "magnific",
          music_provider: "suno",
          upscaler_provider: null,
          chunker_step: null,
          steps: [],
        }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("music_video_unsupported");
  });
});
