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
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let projectsDir: string;

const FFMPEG_AVAILABLE = (() => {
  try {
    const r = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
})();

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-voiceover-"));
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
  // Per-video project dirs created during tests — wipe between runs so
  // a leftover narration.mp3 doesn't fool the next test's bypass logic.
  for (const entry of ["v_test_vu_mp3", "v_test_vu_replace", "v_test_vu_wav"]) {
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

function makeFile(name: string, mime: string, bytes: Buffer | string): File {
  const blob = new Blob([bytes], { type: mime });
  return new File([blob], name, { type: mime });
}

async function callPost(videoId: string, file: File | null) {
  const { POST } = await import("@/app/api/videos/[id]/voiceover/route");
  const form = new FormData();
  if (file) form.append("file", file);
  const req = new Request(`http://localhost/api/videos/${videoId}/voiceover`, {
    method: "POST",
    body: form,
  });
  return POST(req, { params: { id: videoId } });
}

describe("POST /api/videos/:id/voiceover", () => {
  it("returns 404 when the video does not exist", async () => {
    const file = makeFile("narration.mp3", "audio/mpeg", Buffer.from("ID3\x00\x00\x00\x00\x00x"));
    const r = await callPost("not-a-video", file);
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body.error).toBe("not_found");
  });

  it("returns 400 when no file field is present", async () => {
    await seedVideo("v_test_vu_mp3");
    const r = await callPost("v_test_vu_mp3", null);
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe("missing_file");
  });

  it("returns 400 when the uploaded file is empty", async () => {
    await seedVideo("v_test_vu_mp3");
    const r = await callPost("v_test_vu_mp3", makeFile("empty.mp3", "audio/mpeg", ""));
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe("empty_file");
  });

  it("returns 415 for unsupported mime types (e.g. video/mp4)", async () => {
    await seedVideo("v_test_vu_mp3");
    const r = await callPost(
      "v_test_vu_mp3",
      makeFile("clip.mp4", "video/mp4", Buffer.from("not audio")),
    );
    expect(r.status).toBe(415);
    const body = await r.json();
    expect(body.error).toBe("unsupported_format");
  });

  it("accepts an mp3 upload and writes it verbatim to audio/narration.mp3", async () => {
    await seedVideo("v_test_vu_mp3");
    const payload = Buffer.from("ID3\x03\x00\x00\x00\x00\x00fake mp3 bytes for test");
    const r = await callPost(
      "v_test_vu_mp3",
      makeFile("narration.mp3", "audio/mpeg", payload),
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.transcoded).toBe(false);
    expect(body.path).toBe("audio/narration.mp3");
    expect(body.bytes).toBe(payload.byteLength);

    const onDisk = readFileSync(
      join(projectsDir, "v_test_vu_mp3", "audio", "narration.mp3"),
    );
    expect(Buffer.compare(onDisk, payload)).toBe(0);
  });

  it("creates the audio/ directory when it does not already exist", async () => {
    await seedVideo("v_test_vu_mp3");
    expect(existsSync(join(projectsDir, "v_test_vu_mp3", "audio"))).toBe(false);
    const r = await callPost(
      "v_test_vu_mp3",
      makeFile("n.mp3", "audio/mpeg", Buffer.from("x".repeat(64))),
    );
    expect(r.status).toBe(200);
    expect(existsSync(join(projectsDir, "v_test_vu_mp3", "audio", "narration.mp3"))).toBe(true);
  });

  it("overwrites a pre-existing narration.mp3 on a second upload", async () => {
    await seedVideo("v_test_vu_replace");
    const audioDir = join(projectsDir, "v_test_vu_replace", "audio");
    mkdirSync(audioDir, { recursive: true });
    writeFileSync(join(audioDir, "narration.mp3"), Buffer.from("OLD"));

    const newPayload = Buffer.from("NEW-payload-content");
    const r = await callPost(
      "v_test_vu_replace",
      makeFile("n.mp3", "audio/mp3", newPayload),
    );
    expect(r.status).toBe(200);
    const onDisk = readFileSync(join(audioDir, "narration.mp3"));
    expect(Buffer.compare(onDisk, newPayload)).toBe(0);
  });

  it.skipIf(!FFMPEG_AVAILABLE)(
    "transcodes a WAV upload to MP3 via ffmpeg",
    async () => {
      // Build a real 0.5s silent WAV — ffmpeg will refuse a bogus header.
      // Minimal 44-byte WAV header followed by 8000 zero samples.
      const sampleRate = 16000;
      const samples = 8000;
      const wavHeader = Buffer.alloc(44);
      wavHeader.write("RIFF", 0);
      wavHeader.writeUInt32LE(36 + samples * 2, 4);
      wavHeader.write("WAVE", 8);
      wavHeader.write("fmt ", 12);
      wavHeader.writeUInt32LE(16, 16);
      wavHeader.writeUInt16LE(1, 20); // PCM
      wavHeader.writeUInt16LE(1, 22); // mono
      wavHeader.writeUInt32LE(sampleRate, 24);
      wavHeader.writeUInt32LE(sampleRate * 2, 28);
      wavHeader.writeUInt16LE(2, 32);
      wavHeader.writeUInt16LE(16, 34);
      wavHeader.write("data", 36);
      wavHeader.writeUInt32LE(samples * 2, 40);
      const wavBytes = Buffer.concat([wavHeader, Buffer.alloc(samples * 2)]);

      await seedVideo("v_test_vu_wav");
      const r = await callPost(
        "v_test_vu_wav",
        makeFile("n.wav", "audio/wav", wavBytes),
      );
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.ok).toBe(true);
      expect(body.transcoded).toBe(true);
      expect(body.sourceMime).toBe("audio/wav");

      const finalPath = join(projectsDir, "v_test_vu_wav", "audio", "narration.mp3");
      expect(existsSync(finalPath)).toBe(true);
      const head = readFileSync(finalPath).slice(0, 4).toString("ascii");
      // MP3 streams typically begin with the ID3v2 tag header ("ID3")
      // OR an MPEG frame sync (0xFF 0xFB or 0xFF 0xFA). Accept either.
      expect(head.startsWith("ID3") || /^\xff[\xfa\xfb]/.test(head)).toBe(true);

      // Source upload file should be cleaned up.
      const sourcePath = join(projectsDir, "v_test_vu_wav", "audio", "narration_upload.wav");
      expect(existsSync(sourcePath)).toBe(false);
    },
  );
});
