import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-drafts-import-"));
  process.env.HISTFORGE_PROMPTS_DIR = tempDir;
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
  delete process.env.HISTFORGE_PROMPTS_DIR;
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

  rmSync(draftsDir(), { recursive: true, force: true });
  rmSync(importedDir(), { recursive: true, force: true });
  mkdirSync(draftsDir(), { recursive: true });
  mkdirSync(importedDir(), { recursive: true });
});

function draftsDir(): string {
  return join(tempDir, "workflows", "drafts");
}

function importedDir(): string {
  return join(tempDir, "workflows", "imported");
}

const VALID_PAYLOAD = {
  id: "example",
  label: "Example",
  short_label: "Ex",
  description: "From a draft",
  script_llm_provider: "openrouter",
  tts_provider: "ai33",
  image_provider: "comfyui",
  video_provider: "comfyui",
  enabled: true,
  steps: [{ step_name: "research_outline" }, { step_name: "write_hook" }],
};

function writeDraftFile(name: string, body: unknown): string {
  const path = join(draftsDir(), name);
  writeFileSync(
    path,
    typeof body === "string" ? body : JSON.stringify(body),
    "utf-8"
  );
  return path;
}

async function callImport(filename: string, query = "") {
  const { POST } = await import(
    "@/app/api/workflows/drafts/[filename]/import/route"
  );
  return POST(
    new Request(
      `http://localhost/api/workflows/drafts/${filename}/import${query}`,
      { method: "POST" }
    ),
    { params: { filename } }
  );
}

describe("POST /api/workflows/drafts/[filename]/import", () => {
  it("commits a clean draft and atomically moves the file to imported/", async () => {
    const sourcePath = writeDraftFile("example.json", VALID_PAYLOAD);

    const res = await callImport("example.json");
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.workflow).toMatchObject({
      id: "example",
      label: "Example",
      isBuiltin: 0,
      version: 1,
    });
    expect(body.warnings).toBeInstanceOf(Array);
    // archiveError is omitted on the happy path so the UI's followup
    // toast.error fires only on the disk-full / EPERM branch.
    expect(body.archiveError).toBeUndefined();

    expect(existsSync(sourcePath)).toBe(false);
    const archived = readdirSync(importedDir());
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatch(/^example-\d+\.json$/);
    const moved = JSON.parse(
      readFileSync(join(importedDir(), archived[0]), "utf-8")
    );
    expect(moved).toMatchObject({ id: "example", label: "Example" });
  });

  it("returns 409 on collision and leaves the draft file in place", async () => {
    // 'comfyui' workflow is seeded by beforeEach via seedDefaultWorkflows
    const sourcePath = writeDraftFile("comfyui.json", {
      ...VALID_PAYLOAD,
      id: "comfyui",
      label: "Should not overwrite",
    });

    const res = await callImport("comfyui.json");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      error: "workflow_id_exists",
      current_version: 1,
    });

    expect(existsSync(sourcePath)).toBe(true);
    expect(readdirSync(importedDir())).toEqual([]);

    const { getDb } = await import("@/lib/db");
    const { findById } = await import("@/lib/repos/workflows");
    const row = findById(getDb(), "comfyui");
    expect(row?.version).toBe(1);
    expect(row?.label).not.toBe("Should not overwrite");
  });

  it("with ?overwrite=1 commits an overwrite, bumps version, preserves is_builtin, moves file", async () => {
    const sourcePath = writeDraftFile("comfyui.json", {
      ...VALID_PAYLOAD,
      id: "comfyui",
      label: "Edited",
    });

    const res = await callImport("comfyui.json", "?overwrite=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflow).toMatchObject({
      id: "comfyui",
      label: "Edited",
      isBuiltin: 1,
      version: 2,
    });

    expect(existsSync(sourcePath)).toBe(false);
    const archived = readdirSync(importedDir());
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatch(/^comfyui-\d+\.json$/);
  });

  it("uses the row id (not the source filename) for the archived name", async () => {
    // Filename mismatched against the slug — the archive should normalize
    // to the slug as the canonical identifier.
    writeDraftFile("draft-a.json", { ...VALID_PAYLOAD, id: "alpha" });

    const res = await callImport("draft-a.json");
    expect(res.status).toBe(201);

    const archived = readdirSync(importedDir());
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatch(/^alpha-\d+\.json$/);
    expect(existsSync(join(draftsDir(), "draft-a.json"))).toBe(false);
  });

  it("returns 400 invalid_filename for path-traversal attempts", async () => {
    const res = await callImport("../secret.json");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_filename");
  });

  it("returns 400 invalid_filename for wrong extension", async () => {
    const res = await callImport("valid-slug.txt");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_filename");
  });

  it("returns 404 draft_not_found when file does not exist", async () => {
    const res = await callImport("no-such-file.json");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("draft_not_found");
  });

  it("returns 400 invalid_json on a syntactically broken file", async () => {
    writeDraftFile("broken.json", "{ not valid json");

    const res = await callImport("broken.json");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_json");

    // Source remains; failure to parse must not move/delete.
    expect(existsSync(join(draftsDir(), "broken.json"))).toBe(true);
    expect(readdirSync(importedDir())).toEqual([]);
  });

  it("returns 400 invalid_input when payload fails schema validation", async () => {
    writeDraftFile("bad-shape.json", { id: "bad-shape", label: "x" });

    const res = await callImport("bad-shape.json");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_input");

    // Source remains; failed import must not move.
    expect(existsSync(join(draftsDir(), "bad-shape.json"))).toBe(true);
    expect(readdirSync(importedDir())).toEqual([]);
  });

  it("forwards validator warnings on a structurally-valid but broken-input draft", async () => {
    writeDraftFile("broken-input.json", {
      ...VALID_PAYLOAD,
      id: "broken-input",
      // missing research_outline → write_hook / write_chapters lack inputs
      steps: [
        { step_name: "write_hook" },
        { step_name: "write_chapters" },
      ],
    });

    const res = await callImport("broken-input.json");
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warnings.length).toBeGreaterThan(0);

    // Successful commit → file moved.
    expect(existsSync(join(draftsDir(), "broken-input.json"))).toBe(false);
    expect(readdirSync(importedDir())).toHaveLength(1);
  });
});
