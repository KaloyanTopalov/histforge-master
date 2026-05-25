// @vitest-environment node
// Routes that call `req.formData()` hang in jsdom — jsdom's Request
// polyfill doesn't drive the multipart-body parser the way undici does.
// Force this test file to the Node environment so the real undici
// Request implementation services the body read.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let projectsDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-alignment-"));
  projectsDir = join(tempDir, "projects");
  mkdirSync(projectsDir, { recursive: true });
  process.env.DATABASE_URL = join(tempDir, "test.db");
  process.env.PROJECTS_DIR = projectsDir;
});

afterAll(async () => {
  const { getDb } = await import("@/lib/db");
  try { getDb().close(); } catch { /* already closed */ }
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { getDb, seedDefaultSettings, seedDefaultWorkflows } = await import("@/lib/db");
  const db = getDb();
  db.exec(
    "DELETE FROM video_steps; DELETE FROM videos; DELETE FROM workflow_steps; DELETE FROM workflows; DELETE FROM visual_styles; DELETE FROM settings;",
  );
  seedDefaultSettings(db);
  seedDefaultWorkflows(db);
});

afterEach(() => {
  for (const entry of ["v_test_au_json", "v_test_au_srt", "v_test_au_replace"]) {
    rmSync(join(projectsDir, entry), { recursive: true, force: true });
  }
});

async function seedVideo(videoId: string): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  db.prepare(
    `INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(videoId, "T", "info", "comfyui", "new", Date.now());
}

function makeFile(name: string, mime: string, body: string): File {
  const blob = new Blob([body], { type: mime });
  return new File([blob], name, { type: mime });
}

async function callPost(videoId: string, file: File | null) {
  const { POST } = await import("@/app/api/videos/[id]/alignment/route");
  const form = new FormData();
  if (file) form.append("file", file);
  const req = new Request(`http://localhost/api/videos/${videoId}/alignment`, {
    method: "POST",
    body: form,
  });
  return POST(req, { params: { id: videoId } });
}

const SAMPLE_SRT = [
  "1",
  "00:00:00,000 --> 00:00:02,500",
  "First sentence.",
  "",
  "2",
  "00:00:02,500 --> 00:00:05,000",
  "Second sentence.",
].join("\n");

const SAMPLE_JSON = JSON.stringify([
  { id: "f000001", text: "First sentence.", begin: 0, end: 2.5 },
  { id: "f000002", text: "Second sentence.", begin: 2.5, end: 5.0 },
]);

describe("POST /api/videos/:id/alignment", () => {
  it("returns 404 when the video does not exist", async () => {
    const r = await callPost(
      "not-a-video",
      makeFile("a.json", "application/json", SAMPLE_JSON),
    );
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("not_found");
  });

  it("returns 400 when no file field is present", async () => {
    await seedVideo("v_test_au_json");
    const r = await callPost("v_test_au_json", null);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("missing_file");
  });

  it("returns 400 when the uploaded file is empty", async () => {
    await seedVideo("v_test_au_json");
    const r = await callPost(
      "v_test_au_json",
      makeFile("empty.json", "application/json", ""),
    );
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("empty_file");
  });

  it("accepts a valid alignment.json and writes it verbatim (re-encoded)", async () => {
    await seedVideo("v_test_au_json");
    const r = await callPost(
      "v_test_au_json",
      makeFile("alignment.json", "application/json", SAMPLE_JSON),
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.entries).toBe(2);
    expect(body.sourceFormat).toBe("json");

    const written = readFileSync(
      join(projectsDir, "v_test_au_json", "alignment", "alignment.json"),
      "utf-8",
    );
    const parsed = JSON.parse(written);
    expect(parsed).toEqual([
      { id: "f000001", text: "First sentence.", begin: 0, end: 2.5 },
      { id: "f000002", text: "Second sentence.", begin: 2.5, end: 5.0 },
    ]);
  });

  it("rejects JSON that doesn't match AlignmentEntry[] shape", async () => {
    await seedVideo("v_test_au_json");
    const bad = JSON.stringify([{ id: "x", text: "no timing" }]);
    const r = await callPost(
      "v_test_au_json",
      makeFile("bad.json", "application/json", bad),
    );
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe("invalid_shape");
  });

  it("accepts an SRT and converts it to the AlignmentEntry[] format", async () => {
    await seedVideo("v_test_au_srt");
    const r = await callPost(
      "v_test_au_srt",
      makeFile("script.srt", "text/plain", SAMPLE_SRT),
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.entries).toBe(2);
    expect(body.sourceFormat).toBe("srt");

    const written = readFileSync(
      join(projectsDir, "v_test_au_srt", "alignment", "alignment.json"),
      "utf-8",
    );
    const parsed = JSON.parse(written);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      id: "f000001",
      text: "First sentence.",
      begin: 0,
      end: 2.5,
    });
  });

  it("returns 415 for an unrecognised extension/mime combination", async () => {
    await seedVideo("v_test_au_json");
    const r = await callPost(
      "v_test_au_json",
      makeFile("transcript.xyz", "application/octet-stream", "garbage"),
    );
    expect(r.status).toBe(415);
    expect((await r.json()).error).toBe("unsupported_format");
  });

  it("returns 400 with a parse_failed error when SRT body is malformed", async () => {
    await seedVideo("v_test_au_srt");
    const r = await callPost(
      "v_test_au_srt",
      makeFile("bad.srt", "text/plain", "not a real srt file at all"),
    );
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("parse_failed");
  });

  it("overwrites a pre-existing alignment.json on a second upload", async () => {
    await seedVideo("v_test_au_replace");
    const alignmentDir = join(projectsDir, "v_test_au_replace", "alignment");
    mkdirSync(alignmentDir, { recursive: true });
    // Seed with bogus content — the upload should replace it wholesale.
    const path = join(alignmentDir, "alignment.json");
    const fs = await import("node:fs");
    fs.writeFileSync(path, JSON.stringify([{ id: "old", text: "old", begin: 0, end: 1 }]));

    const r = await callPost(
      "v_test_au_replace",
      makeFile("a.json", "application/json", SAMPLE_JSON),
    );
    expect(r.status).toBe(200);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written).toHaveLength(2);
    expect(written[0].id).toBe("f000001");
  });

  it("auto-creates the alignment/ directory", async () => {
    await seedVideo("v_test_au_json");
    expect(
      existsSync(join(projectsDir, "v_test_au_json", "alignment")),
    ).toBe(false);
    await callPost(
      "v_test_au_json",
      makeFile("a.json", "application/json", SAMPLE_JSON),
    );
    expect(
      existsSync(join(projectsDir, "v_test_au_json", "alignment", "alignment.json")),
    ).toBe(true);
  });
});
