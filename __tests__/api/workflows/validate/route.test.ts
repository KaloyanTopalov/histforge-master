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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-validate-"));
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

const CLEAN_BODY = {
  script_llm_provider: "openrouter",
  tts_provider: "ai33",
  image_provider: "comfyui",
  video_provider: "comfyui",
  steps: [
    { step_name: "research_outline" },
    { step_name: "write_hook" },
    { step_name: "write_chapters" },
  ],
};

describe("POST /api/workflows/validate", () => {
  it("returns warnings: [] for a clean snapshot", async () => {
    const { POST } = await import("@/app/api/workflows/validate/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(CLEAN_BODY),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings).toEqual([]);
  });

  it("returns warnings for a broken snapshot (missing producer)", async () => {
    const { POST } = await import("@/app/api/workflows/validate/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...CLEAN_BODY,
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
    expect(body.warnings[0].missing_input).toBe("script/03_hook.md");
  });

  it("returns warnings on empty steps array (auto-glue still warns)", async () => {
    const { POST } = await import("@/app/api/workflows/validate/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...CLEAN_BODY, steps: [] }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings).toHaveLength(2);
    expect(
      body.warnings.every(
        (w: { step_name: string }) => w.step_name === "assemble_script"
      )
    ).toBe(true);
  });

  it("tts_provider: null skips voiceover, surfacing audio-consumer warnings", async () => {
    const { POST } = await import("@/app/api/workflows/validate/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...CLEAN_BODY, tts_provider: null }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Materializer's null-tts skip drops `voiceover` from the walk, so
    // `audio/narration.mp3` is never produced. Downstream consumers
    // (align, render) warn — proves /validate exercises the same
    // null-skip branch as the persisting routes.
    const offenders = body.warnings
      .map((w: { step_name: string }) => w.step_name)
      .sort();
    expect(offenders).toEqual(["align", "render"]);
    for (const w of body.warnings) {
      expect(w.missing_input).toBe("audio/narration.mp3");
    }
  });

  it("returns 400 invalid_input on malformed body", async () => {
    const { POST } = await import("@/app/api/workflows/validate/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ steps: "not-an-array" }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_input");
  });

  it("surfaces a chunker_step consistency warning when image_provider is missing for clips-then-images", async () => {
    // With chunker_step absent the schema's default (clips_then_images)
    // applies; image_provider=null violates that combo's required-pair rule.
    const { POST } = await import("@/app/api/workflows/validate/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...CLEAN_BODY, image_provider: null }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const chunkerWarnings = body.warnings.filter(
      (w: { step_name: string }) => w.step_name === "chunk_clips_then_images"
    );
    expect(chunkerWarnings).toHaveLength(1);
    expect(chunkerWarnings[0].missing_input).toBe("image_provider");
  });

  it("uses the body's chunker_step for the consistency check", async () => {
    // images-only requires image_provider !== null AND video_provider === null.
    // Providing video_provider violates the rule for that chunker.
    const { POST } = await import("@/app/api/workflows/validate/route");
    const res = await POST(
      new Request("http://localhost/api/workflows/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...CLEAN_BODY,
          chunker_step: "chunk_images_only",
          image_provider: "google_flow",
          video_provider: "google_flow",
        }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const chunkerWarnings = body.warnings.filter(
      (w: { step_name: string }) => w.step_name === "chunk_images_only"
    );
    expect(chunkerWarnings).toHaveLength(1);
    expect(chunkerWarnings[0].missing_input).toBe("video_provider");
  });

  it("does not write to the workflows table (no persistence)", async () => {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    const before = db
      .prepare("SELECT COUNT(*) as c FROM workflows")
      .get() as { c: number };

    const { POST } = await import("@/app/api/workflows/validate/route");
    await POST(
      new Request("http://localhost/api/workflows/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(CLEAN_BODY),
      })
    );

    const after = db
      .prepare("SELECT COUNT(*) as c FROM workflows")
      .get() as { c: number };
    expect(after.c).toBe(before.c);
  });
});
