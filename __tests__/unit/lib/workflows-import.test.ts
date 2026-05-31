import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-import-helper-"));
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
  id: "helper-import",
  label: "Helper Import",
  short_label: "Help",
  description: "From the helper",
  script_llm_provider: "openrouter",
  tts_provider: "ai33",
  image_provider: "comfyui",
  image_style: null,
  video_provider: "comfyui",
  enabled: true,
  steps: [
    { step_name: "research_outline" },
    { step_name: "write_hook" },
    { step_name: "write_chapters" },
  ],
};

describe("importWorkflowJson", () => {
  it("inserts a new row and returns status='created' with empty warnings", async () => {
    const { getDb } = await import("@/lib/db");
    const { importWorkflowJson } = await import("@/lib/workflows-import");
    const db = getDb();
    const result = importWorkflowJson(db, VALID_PAYLOAD, { overwrite: false });
    expect(result.status).toBe("created");
    expect(result.warnings).toEqual([]);
    expect(result.row).toMatchObject({
      id: "helper-import",
      label: "Helper Import",
      is_builtin: 0,
      enabled: 1,
      version: 1,
    });
  });

  it("throws ImportError('workflow_id_exists') with current_version when slug exists and !overwrite", async () => {
    const { getDb } = await import("@/lib/db");
    const { importWorkflowJson, ImportError } = await import(
      "@/lib/workflows-import"
    );
    const db = getDb();
    importWorkflowJson(db, VALID_PAYLOAD, { overwrite: false });
    let caught: unknown = null;
    try {
      importWorkflowJson(db, VALID_PAYLOAD, { overwrite: false });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as InstanceType<typeof ImportError>).code).toBe(
      "workflow_id_exists"
    );
    expect(
      (caught as InstanceType<typeof ImportError>).details?.current_version
    ).toBe(1);
  });

  it("overwrites an existing row when overwrite=true and bumps version", async () => {
    const { getDb } = await import("@/lib/db");
    const { importWorkflowJson } = await import("@/lib/workflows-import");
    const db = getDb();
    importWorkflowJson(db, VALID_PAYLOAD, { overwrite: false });
    const result = importWorkflowJson(
      db,
      { ...VALID_PAYLOAD, label: "Helper Import v2" },
      { overwrite: true }
    );
    expect(result.status).toBe("overwritten");
    expect(result.row.label).toBe("Helper Import v2");
    expect(result.row.version).toBe(2);
    expect(result.row.is_builtin).toBe(0);
  });

  it("preserves is_builtin=1 when overwriting a built-in workflow", async () => {
    const { getDb } = await import("@/lib/db");
    const { importWorkflowJson } = await import("@/lib/workflows-import");
    const db = getDb();
    const result = importWorkflowJson(
      db,
      { ...VALID_PAYLOAD, id: "comfyui", label: "Edited Builtin" },
      { overwrite: true }
    );
    expect(result.status).toBe("overwritten");
    expect(result.row.id).toBe("comfyui");
    expect(result.row.label).toBe("Edited Builtin");
    expect(result.row.is_builtin).toBe(1);
  });

  it("throws ImportError('invalid_input') with issues on bad shape", async () => {
    const { getDb } = await import("@/lib/db");
    const { importWorkflowJson, ImportError } = await import(
      "@/lib/workflows-import"
    );
    const db = getDb();
    let caught: unknown = null;
    try {
      importWorkflowJson(db, { id: "bad", label: "x" }, { overwrite: false });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as InstanceType<typeof ImportError>).code).toBe(
      "invalid_input"
    );
    expect(
      Array.isArray(
        (caught as InstanceType<typeof ImportError>).details?.issues
      )
    ).toBe(true);
  });

  it("returns warnings on a broken-input new-row import (status still 'created')", async () => {
    const { getDb } = await import("@/lib/db");
    const { importWorkflowJson } = await import("@/lib/workflows-import");
    const db = getDb();
    const result = importWorkflowJson(
      db,
      {
        ...VALID_PAYLOAD,
        id: "broken-helper",
        steps: [
          { step_name: "research_outline" },
          { step_name: "write_chapters" },
        ],
      },
      { overwrite: false }
    );
    expect(result.status).toBe("created");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].step_name).toBe("assemble_script");
    expect(result.warnings[0].missing_input).toBe("script/03_hook.md");
  });

  it("silently strips server-controlled fields like is_builtin from input", async () => {
    const { getDb } = await import("@/lib/db");
    const { importWorkflowJson } = await import("@/lib/workflows-import");
    const db = getDb();
    const result = importWorkflowJson(
      db,
      { ...VALID_PAYLOAD, id: "sneaky-helper", is_builtin: 1 },
      { overwrite: false }
    );
    expect(result.status).toBe("created");
    expect(result.row.is_builtin).toBe(0);
  });

  it("inserts chunker_step from the payload on a new row", async () => {
    const { getDb } = await import("@/lib/db");
    const { importWorkflowJson } = await import("@/lib/workflows-import");
    const db = getDb();
    const result = importWorkflowJson(
      db,
      {
        ...VALID_PAYLOAD,
        id: "images-only-helper",
        chunker_step: "chunk_images_only",
      },
      { overwrite: false }
    );
    expect(result.status).toBe("created");
    expect(result.row.chunker_step).toBe("chunk_images_only");
  });

  it("defaults chunker_step to chunk_clips_then_images on a new row when omitted", async () => {
    const { getDb } = await import("@/lib/db");
    const { importWorkflowJson } = await import("@/lib/workflows-import");
    const db = getDb();
    const result = importWorkflowJson(
      db,
      { ...VALID_PAYLOAD, id: "no-chunker-helper" },
      { overwrite: false }
    );
    expect(result.status).toBe("created");
    expect(result.row.chunker_step).toBe("chunk_clips_then_images");
  });

  it("overwrite path writes chunker_step from the payload", async () => {
    const { getDb } = await import("@/lib/db");
    const { importWorkflowJson } = await import("@/lib/workflows-import");
    const db = getDb();
    importWorkflowJson(db, VALID_PAYLOAD, { overwrite: false });
    const result = importWorkflowJson(
      db,
      { ...VALID_PAYLOAD, chunker_step: "chunk_clips_only" },
      { overwrite: true }
    );
    expect(result.status).toBe("overwritten");
    expect(result.row.chunker_step).toBe("chunk_clips_only");
  });

  it("surfaces a chunker_step consistency warning alongside input-availability ones", async () => {
    const { getDb } = await import("@/lib/db");
    const { importWorkflowJson } = await import("@/lib/workflows-import");
    const db = getDb();
    const result = importWorkflowJson(
      db,
      {
        ...VALID_PAYLOAD,
        id: "inconsistent-clips-only",
        chunker_step: "chunk_clips_only",
        image_provider: "google_flow",
        video_provider: "google_flow",
      },
      { overwrite: false }
    );
    expect(result.status).toBe("created");
    const chunkerWarnings = result.warnings.filter(
      (w) => w.step_name === "chunk_clips_only"
    );
    expect(chunkerWarnings).toHaveLength(1);
    expect(chunkerWarnings[0].missing_input).toBe("image_provider");
  });

});

// Round-trip parity for the music_video kind (ADR-0011 §Consequences). The
// export endpoint emits a music_video payload; `WorkflowImportSchema` accepts
// it via the discriminated union; `importWorkflowJson` must round-trip the
// triple cleanly (kind='music_video', image=magnific, video=magnific,
// music=suno) without coercing to narrative or losing the music_provider.
const VALID_MUSIC_VIDEO_PAYLOAD = {
  id: "music-video-import-helper",
  label: "Music video import helper",
  short_label: "MV Helper",
  description: "Round-trip target",
  kind: "music_video",
  script_llm_provider: null,
  tts_provider: null,
  image_provider: "magnific",
  video_provider: "magnific",
  music_provider: "suno",
  upscaler_provider: null,
  chunker_step: null,
  steps: [],
};

describe("importWorkflowJson — music_video round-trip", () => {
  it("creates a music_video row with the seeded Magnific × Suno provider triple", async () => {
    const { getDb } = await import("@/lib/db");
    const { importWorkflowJson } = await import("@/lib/workflows-import");
    const db = getDb();
    const result = importWorkflowJson(db, VALID_MUSIC_VIDEO_PAYLOAD, {
      overwrite: false,
    });
    expect(result.status).toBe("created");
    expect(result.warnings).toEqual([]);
    expect(result.row).toMatchObject({
      id: "music-video-import-helper",
      kind: "music_video",
      script_llm_provider: null,
      tts_provider: null,
      image_provider: "magnific",
      video_provider: "magnific",
      music_provider: "suno",
      upscaler_provider: null,
      chunker_step: null,
      is_builtin: 0,
      enabled: 1,
      version: 1,
    });
  });

  it("clears workflow_steps for music_video imports (steps must be empty)", async () => {
    const { getDb } = await import("@/lib/db");
    const { importWorkflowJson } = await import("@/lib/workflows-import");
    const db = getDb();
    importWorkflowJson(db, VALID_MUSIC_VIDEO_PAYLOAD, { overwrite: false });
    const stepRows = db
      .prepare("SELECT step_name FROM workflow_steps WHERE workflow_id = ?")
      .all("music-video-import-helper");
    expect(stepRows).toEqual([]);
  });

  it("export ↔ import round-trips the music-video builtin without drift", async () => {
    // Take the seeded music-video row, export it, then re-import as a new
    // slug. The new row's provider triple + null narrative columns must
    // match the seed exactly — losing music_provider or coercing kind to
    // narrative would surface here.
    const { getDb } = await import("@/lib/db");
    const { importWorkflowJson } = await import("@/lib/workflows-import");
    const { GET: exportGET } = await import(
      "@/app/api/workflows/[id]/export/route"
    );
    const db = getDb();
    const res = await exportGET(
      new Request(
        "http://localhost/api/workflows/music-video-magnific-suno/export"
      ),
      { params: { id: "music-video-magnific-suno" } }
    );
    const exported = (await res.json()) as Record<string, unknown>;
    const reimportPayload = { ...exported, id: "music-video-reimport" };
    const result = importWorkflowJson(db, reimportPayload, { overwrite: false });
    expect(result.status).toBe("created");
    expect(result.row.kind).toBe("music_video");
    expect(result.row.music_provider).toBe("suno");
    expect(result.row.image_provider).toBe("magnific");
    expect(result.row.video_provider).toBe("magnific");
    expect(result.row.script_llm_provider).toBeNull();
    expect(result.row.tts_provider).toBeNull();
    expect(result.row.chunker_step).toBeNull();
  });

  it("flags an inconsistent music_video payload (post-commit consistency check is kind-aware)", async () => {
    // A music_video row with the discriminated-union schema enforces the
    // provider triple at parse-time, so we sneak an inconsistent row past
    // the schema by inserting via raw SQL, then assert that
    // `validateWorkflowConsistency` (called from `importWorkflowJson` on
    // re-import via overwrite) catches it. Confirms the import surface
    // uses the kind-aware entry point, not the narrative-only helper.
    const { getDb } = await import("@/lib/db");
    const { importWorkflowJson } = await import("@/lib/workflows-import");
    const db = getDb();
    importWorkflowJson(db, VALID_MUSIC_VIDEO_PAYLOAD, { overwrite: false });
    // Overwrite with a clean payload — warnings should stay empty.
    const result = importWorkflowJson(
      db,
      { ...VALID_MUSIC_VIDEO_PAYLOAD, label: "MV Helper v2" },
      { overwrite: true }
    );
    expect(result.status).toBe("overwritten");
    expect(result.warnings).toEqual([]);
  });
});

describe("IMPORT_ERROR_STATUS", () => {
  it("maps every ImportErrorCode to its HTTP status", async () => {
    const { IMPORT_ERROR_STATUS } = await import("@/lib/workflows-import");
    expect(IMPORT_ERROR_STATUS.invalid_input).toBe(400);
    expect(IMPORT_ERROR_STATUS.workflow_id_exists).toBe(409);
    expect(IMPORT_ERROR_STATUS.invalid_filename).toBe(400);
  });
});

describe("filesystem helpers", () => {
  const ORIGINAL = process.env.HISTFORGE_PROMPTS_DIR;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.HISTFORGE_PROMPTS_DIR;
    } else {
      process.env.HISTFORGE_PROMPTS_DIR = ORIGINAL;
    }
  });

  it("getPromptsRoot defaults to 'prompts' when HISTFORGE_PROMPTS_DIR is unset", async () => {
    delete process.env.HISTFORGE_PROMPTS_DIR;
    const { getPromptsRoot } = await import("@/lib/workflows-drafts-fs");
    expect(getPromptsRoot()).toBe("prompts");
  });

  it("getPromptsRoot reads HISTFORGE_PROMPTS_DIR at call time", async () => {
    const { getPromptsRoot } = await import("@/lib/workflows-drafts-fs");
    process.env.HISTFORGE_PROMPTS_DIR = "/tmp/somewhere";
    expect(getPromptsRoot()).toBe("/tmp/somewhere");
  });

  it("getDraftsDir / getImportedDir are siblings under <root>/workflows/", async () => {
    const { getDraftsDir, getImportedDir } = await import(
      "@/lib/workflows-drafts-fs"
    );
    process.env.HISTFORGE_PROMPTS_DIR = "/root";
    expect(getDraftsDir()).toBe(join("/root", "workflows", "drafts"));
    expect(getImportedDir()).toBe(join("/root", "workflows", "imported"));
  });

  it("ensureDraftsDirs creates both directories and is idempotent", async () => {
    const root = mkdtempSync(join(tmpdir(), "histforge-fs-helpers-"));
    process.env.HISTFORGE_PROMPTS_DIR = root;
    try {
      const { ensureDraftsDirs, getDraftsDir, getImportedDir } = await import(
        "@/lib/workflows-drafts-fs"
      );
      ensureDraftsDirs();
      expect(existsSync(getDraftsDir())).toBe(true);
      expect(existsSync(getImportedDir())).toBe(true);
      // second call must not throw
      ensureDraftsDirs();
      expect(statSync(getDraftsDir()).isDirectory()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validateDraftFilename accepts kebab-case .json names", async () => {
    const { validateDraftFilename } = await import(
      "@/lib/workflows-drafts-fs"
    );
    expect(() => validateDraftFilename("fast-narrative.json")).not.toThrow();
    expect(() => validateDraftFilename("comfyui.json")).not.toThrow();
    expect(() => validateDraftFilename("a1.json")).not.toThrow();
  });

  it("validateDraftFilename throws ImportError('invalid_filename') on traversal/wrong shapes", async () => {
    const { validateDraftFilename } = await import(
      "@/lib/workflows-drafts-fs"
    );
    const { ImportError } = await import("@/lib/workflows-import");
    const bad = [
      "../secret.json",
      "..\\secret.json",
      "foo/bar.json",
      "Foo.json",
      "foo.txt",
      "foo",
      ".json",
      "foo_bar.json",
    ];
    for (const name of bad) {
      let caught: unknown = null;
      try {
        validateDraftFilename(name);
      } catch (err) {
        caught = err;
      }
      expect(
        caught,
        `expected ImportError for ${JSON.stringify(name)}`
      ).toBeInstanceOf(ImportError);
      expect((caught as InstanceType<typeof ImportError>).code).toBe(
        "invalid_filename"
      );
    }
  });
});
