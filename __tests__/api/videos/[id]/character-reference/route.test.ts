// @vitest-environment node
// Routes that call `req.formData()` hang in jsdom — jsdom's Request
// polyfill doesn't drive the multipart-body parser the way undici does.
// Force this test file to the Node environment so the real undici
// Request implementation services the body read.
import {
  afterAll,
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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-char-ref-route-"));
  projectsDir = join(tempDir, "projects");
  mkdirSync(projectsDir, { recursive: true });
  process.env.DATABASE_URL = join(tempDir, "test.db");
  process.env.PROJECTS_DIR = projectsDir;
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
  const { getDb, seedDefaultSettings, seedDefaultWorkflows } = await import("@/lib/db");
  const db = getDb();
  db.exec(
    "DELETE FROM video_steps; DELETE FROM videos; DELETE FROM workflow_steps; DELETE FROM workflows; DELETE FROM visual_styles; DELETE FROM settings;"
  );
  seedDefaultSettings(db);
  seedDefaultWorkflows(db);
  rmSync(projectsDir, { recursive: true, force: true });
  mkdirSync(projectsDir, { recursive: true });
});

async function seedVideo(videoId: string): Promise<void> {
  const { getDb } = await import("@/lib/db");
  getDb()
    .prepare(
      `INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(videoId, "T", "info", "comfyui", "new", Date.now());
}

function makeFile(name: string, mime: string, bytes: Buffer): File {
  // Cast Buffer → Uint8Array — recent @types/node narrowed Buffer's
  // backing-store type and TS no longer considers it directly
  // assignable to BlobPart. The runtime accepts both interchangeably.
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  return new File([blob], name, { type: mime });
}

async function callPost(videoId: string, file: File | null) {
  const { POST } = await import("@/app/api/videos/[id]/character-reference/route");
  const form = new FormData();
  if (file) form.append("file", file);
  const req = new Request(
    `http://localhost/api/videos/${videoId}/character-reference`,
    {
      method: "POST",
      body: form,
    }
  );
  return POST(req, { params: { id: videoId } });
}

// Generate a minimal valid PNG buffer ffmpeg won't choke on for the
// transcode tests. (1×1 transparent pixel, generated offline.)
const MINIMAL_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da636400000000050001a6e2c2f30000000049454e44ae426082",
  "hex"
);

describe("POST /api/videos/:id/character-reference", () => {
  it("returns 404 when the video does not exist", async () => {
    const r = await callPost(
      "not-a-video",
      makeFile("ref.png", "image/png", MINIMAL_PNG)
    );
    expect(r.status).toBe(404);
  });

  it("returns 400 when no file is provided", async () => {
    await seedVideo("v_no_file");
    const r = await callPost("v_no_file", null);
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe("missing_file");
  });

  it("returns 400 on empty file", async () => {
    await seedVideo("v_empty");
    const r = await callPost(
      "v_empty",
      makeFile("ref.png", "image/png", Buffer.from([]))
    );
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe("empty_file");
  });

  it("returns 415 on unsupported mime", async () => {
    await seedVideo("v_unsupported");
    const r = await callPost(
      "v_unsupported",
      makeFile("ref.gif", "image/gif", Buffer.from([0x47, 0x49, 0x46]))
    );
    expect(r.status).toBe(415);
    const body = await r.json();
    expect(body.error).toBe("unsupported_format");
  });

  it("writes a PNG verbatim to projects/<id>/character_reference.png", async () => {
    await seedVideo("v_png");
    const r = await callPost(
      "v_png",
      makeFile("ref.png", "image/png", MINIMAL_PNG)
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({
      ok: true,
      path: "character_reference.png",
      bytes: MINIMAL_PNG.byteLength,
      transcoded: false,
    });
    const written = readFileSync(
      join(projectsDir, "v_png", "character_reference.png")
    );
    expect(written.equals(MINIMAL_PNG)).toBe(true);
  });

  it("overwrites a prior PNG when a new PNG is uploaded (idempotent)", async () => {
    // Stable-basename design: there's exactly one slot. The Codex
    // round-2 review for step 3 caught that the original probe-many-
    // basenames design could dangle pending Flow rows after re-upload;
    // the fix is one canonical filename that always wins.
    await seedVideo("v_replace");
    const r1 = await callPost(
      "v_replace",
      makeFile("ref.png", "image/png", MINIMAL_PNG)
    );
    expect(r1.status).toBe(200);

    const second = Buffer.concat([MINIMAL_PNG, Buffer.from([0x00])]);
    const r2 = await callPost(
      "v_replace",
      makeFile("ref2.png", "image/png", second)
    );
    expect(r2.status).toBe(200);

    const written = readFileSync(
      join(projectsDir, "v_replace", "character_reference.png")
    );
    expect(written.equals(second)).toBe(true);
    // No stale temp/sidecar files leaked.
    expect(
      existsSync(join(projectsDir, "v_replace", "character_reference.jpg"))
    ).toBe(false);
    expect(
      existsSync(join(projectsDir, "v_replace", "character_reference.webp"))
    ).toBe(false);
  });

  it.skipIf(!FFMPEG_AVAILABLE)(
    "transcodes a JPEG upload to PNG and writes to the canonical basename",
    async () => {
      await seedVideo("v_jpg");
      // Tiny valid JPEG (a 1×1 white pixel). ffmpeg-mandatory test —
      // skipped in environments where ffmpeg isn't on PATH so the suite
      // stays green in minimal CIs that don't bundle it.
      const TINY_JPEG = Buffer.from(
        "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffdb0043010909090c0b0c180d0d1832211c213232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232ffc00011080001000103012200021101031101ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffc4001f0100030101010101010101010000000000000102030405060708090a0bffc400b51100020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9faffda000c03010002110311003f00fbfa28a2803fffd9",
        "hex"
      );
      const r = await callPost(
        "v_jpg",
        makeFile("ref.jpg", "image/jpeg", TINY_JPEG)
      );
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.path).toBe("character_reference.png");
      expect(body.transcoded).toBe(true);
      expect(body.sourceMime).toBe("image/jpeg");

      // PNG file written; no JPG sidecar remains on disk.
      expect(
        existsSync(join(projectsDir, "v_jpg", "character_reference.png"))
      ).toBe(true);
      expect(
        existsSync(join(projectsDir, "v_jpg", "character_reference_upload.jpg"))
      ).toBe(false);

      // Verify the bytes are an actual PNG (magic number).
      const written = readFileSync(
        join(projectsDir, "v_jpg", "character_reference.png")
      );
      expect(written.subarray(0, 4)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47])
      );
    }
  );
});
