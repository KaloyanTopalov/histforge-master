// @vitest-environment node
// Routes that call `fetch()` with multipart FormData hang in jsdom —
// the polyfilled fetch doesn't drive the body-stream correctly. Force
// Node environment so undici's fetch services the upload.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-whisper-"));
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
  // Default to no-key state — individual tests opt in.
  delete process.env.WHISPER_API_KEY;
  delete process.env.WHISPER_BASE_URL;
  delete process.env.WHISPER_MODEL;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const entry of ["v_test_wt", "v_test_wt2"]) {
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

function seedAudio(videoId: string, bytes: Buffer): string {
  const audioDir = join(projectsDir, videoId, "audio");
  mkdirSync(audioDir, { recursive: true });
  const path = join(audioDir, "narration.mp3");
  writeFileSync(path, bytes);
  return path;
}

async function callPost(videoId: string) {
  const { POST } = await import(
    "@/app/api/videos/[id]/alignment/auto-transcribe/route"
  );
  const req = new Request(
    `http://localhost/api/videos/${videoId}/alignment/auto-transcribe`,
    { method: "POST" },
  );
  return POST(req, { params: { id: videoId } });
}

const SAMPLE_SRT_RESPONSE = `1
00:00:00,000 --> 00:00:02,500
First transcribed sentence.

2
00:00:02,500 --> 00:00:05,000
Second transcribed sentence.
`;

/**
 * A minimal-but-valid MP3 frame so ffmpeg's input check accepts the
 * file. We don't need real speech — ffmpeg will happily downsample
 * silence/garbage as long as the container is parseable. For the
 * transcribe call itself we mock global.fetch so the audio bytes
 * never leave the process.
 */
function makeTinyMp3(): Buffer {
  // ID3v2 header (10 bytes) + a single dummy MP3 frame header followed
  // by silence. Real ffmpeg builds may reject pure garbage, so we
  // synthesise a 0.1s silent MP3 via ffmpeg itself if available; otherwise
  // fall back to a static header that lets ffmpeg's strict mode bail
  // cleanly.
  if (FFMPEG_AVAILABLE) {
    const tmp = mkdtempSync(join(tmpdir(), "histforge-mp3-"));
    const out = join(tmp, "silence.mp3");
    spawnSync("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "anullsrc=r=22050:cl=mono",
      "-t", "0.1",
      "-b:a", "64k",
      out,
    ], { stdio: "ignore" });
    if (existsSync(out)) {
      const b = readFileSync(out);
      rmSync(tmp, { recursive: true, force: true });
      return b;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
  // Fallback ID3 header — not playable, but the size check still
  // exercises the no_audio guard. Tests that need real MP3 will be
  // skipped via FFMPEG_AVAILABLE.
  return Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00");
}

describe("POST /api/videos/:id/alignment/auto-transcribe", () => {
  it("returns 404 when the video does not exist", async () => {
    process.env.WHISPER_API_KEY = "sk-test";
    const r = await callPost("not-a-video");
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("not_found");
  });

  it("returns 503 when WHISPER_API_KEY is not configured", async () => {
    await seedVideo("v_test_wt");
    seedAudio("v_test_wt", makeTinyMp3());
    const r = await callPost("v_test_wt");
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe("whisper_not_configured");
  });

  it("returns 400 when audio/narration.mp3 is missing", async () => {
    process.env.WHISPER_API_KEY = "sk-test";
    await seedVideo("v_test_wt");
    const r = await callPost("v_test_wt");
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("no_audio");
  });

  it("returns 400 when audio/narration.mp3 is empty", async () => {
    process.env.WHISPER_API_KEY = "sk-test";
    await seedVideo("v_test_wt");
    seedAudio("v_test_wt", Buffer.alloc(0));
    const r = await callPost("v_test_wt");
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("no_audio");
  });

  it.skipIf(!FFMPEG_AVAILABLE)(
    "downsamples audio, calls the configured Whisper endpoint with response_format=srt, and writes the parsed alignment",
    async () => {
      process.env.WHISPER_API_KEY = "sk-test-key";
      process.env.WHISPER_BASE_URL = "https://whisper.example.invalid/v1";
      process.env.WHISPER_MODEL = "whisper-large-v3";
      await seedVideo("v_test_wt");
      seedAudio("v_test_wt", makeTinyMp3());

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (url, init) => {
          // Verify the route hit the configured endpoint with the right
          // headers and a multipart body containing model+response_format.
          expect(String(url)).toBe(
            "https://whisper.example.invalid/v1/audio/transcriptions",
          );
          const opts = init as RequestInit | undefined;
          expect(opts?.method).toBe("POST");
          const headers = opts?.headers as Record<string, string> | undefined;
          expect(headers?.authorization).toBe("Bearer sk-test-key");
          // The body should be a FormData with file, model, response_format.
          const body = opts?.body as FormData;
          expect(body).toBeInstanceOf(FormData);
          expect(body.get("model")).toBe("whisper-large-v3");
          expect(body.get("response_format")).toBe("srt");
          expect(body.get("file")).toBeInstanceOf(File);
          return new Response(SAMPLE_SRT_RESPONSE, {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        });

      const r = await callPost("v_test_wt");
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.ok).toBe(true);
      expect(body.entries).toBe(2);
      expect(body.model).toBe("whisper-large-v3");

      const written = JSON.parse(
        readFileSync(
          join(projectsDir, "v_test_wt", "alignment", "alignment.json"),
          "utf-8",
        ),
      );
      expect(written).toHaveLength(2);
      expect(written[0].text).toBe("First transcribed sentence.");
      expect(written[0].begin).toBe(0);
      expect(written[0].end).toBe(2.5);

      // Downsampled scratch file should be cleaned up.
      expect(
        existsSync(
          join(projectsDir, "v_test_wt", "audio", "narration_whisper.mp3"),
        ),
      ).toBe(false);
    },
  );

  it.skipIf(!FFMPEG_AVAILABLE)(
    "surfaces an error response from the Whisper endpoint as a 502",
    async () => {
      process.env.WHISPER_API_KEY = "sk-test";
      await seedVideo("v_test_wt2");
      seedAudio("v_test_wt2", makeTinyMp3());

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { message: "Invalid API key", type: "invalid_request_error" },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
      );

      const r = await callPost("v_test_wt2");
      expect(r.status).toBe(502);
      const body = await r.json();
      expect(body.error).toBe("whisper_error");
      expect(body.status).toBe(401);
      expect(body.message).toContain("Invalid API key");
    },
  );

  it.skipIf(!FFMPEG_AVAILABLE)(
    "surfaces a fetch-level connection failure as 502 whisper_unreachable",
    async () => {
      process.env.WHISPER_API_KEY = "sk-test";
      process.env.WHISPER_BASE_URL = "http://nope.invalid/v1";
      await seedVideo("v_test_wt2");
      seedAudio("v_test_wt2", makeTinyMp3());

      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("ENOTFOUND nope.invalid"),
      );

      const r = await callPost("v_test_wt2");
      expect(r.status).toBe(502);
      const body = await r.json();
      expect(body.error).toBe("whisper_unreachable");
      expect(body.message).toContain("nope.invalid");
    },
  );

  it.skipIf(!FFMPEG_AVAILABLE)(
    "returns 500 parse_failed when Whisper returns something that isn't SRT",
    async () => {
      process.env.WHISPER_API_KEY = "sk-test";
      await seedVideo("v_test_wt2");
      seedAudio("v_test_wt2", makeTinyMp3());

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("not-srt-content", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );

      const r = await callPost("v_test_wt2");
      expect(r.status).toBe(500);
      expect((await r.json()).error).toBe("parse_failed");
    },
  );
});
