import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let projectsDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-magnific-artifact-"));
  process.env.DATABASE_URL = join(tempDir, "test.db");
  projectsDir = join(tempDir, "projects");
  mkdirSync(projectsDir, { recursive: true });
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
  const { getDb, seedDefaultSettings } = await import("@/lib/db");
  const db = getDb();
  db.exec("DELETE FROM videos; DELETE FROM settings;");
  seedDefaultSettings(db);
  // Clean projects between tests so missing-file cases aren't masked by
  // an artifact left over from an earlier case.
  rmSync(projectsDir, { recursive: true, force: true });
  mkdirSync(projectsDir, { recursive: true });
});

async function seedVideo(id: string): Promise<void> {
  const { getDb } = await import("@/lib/db");
  getDb()
    .prepare(
      `INSERT INTO videos (id, title, topic_info, workflow_id, status, kind, created_at)
       VALUES (?, ?, ?, ?, 'queued', 'music_video', ?)`
    )
    .run(id, "T", "info", "music-video-magnific-suno", Date.now());
}

async function setToken(token: string): Promise<void> {
  const { setSetting } = await import("@/lib/settings");
  setSetting("magnific_token", token);
}

function writeArtifact(
  videoId: string,
  relPath: string,
  contents: Buffer
): void {
  const videoDir = join(projectsDir, videoId);
  mkdirSync(videoDir, { recursive: true });
  writeFileSync(join(videoDir, relPath), contents);
}

async function callArtifact(
  token: string,
  query: Record<string, string> = {}
): Promise<Response> {
  const { GET } = await import("@/app/api/magnific/artifact/[token]/route");
  const url = new URL(`http://localhost/api/magnific/artifact/${token}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return GET(new Request(url.toString()), { params: { token } });
}

describe("GET /api/magnific/artifact/:token", () => {
  it("404s on bad token", async () => {
    await setToken("real-token");
    const res = await callArtifact("not-the-token", {
      videoId: "v1",
      path: "loop_image.png",
    });
    expect(res.status).toBe(404);
  });

  it("400s when videoId query param is missing", async () => {
    await setToken("T");
    const res = await callArtifact("T", { path: "loop_image.png" });
    expect(res.status).toBe(400);
  });

  it("400s when path query param is missing", async () => {
    await setToken("T");
    const res = await callArtifact("T", { videoId: "v1" });
    expect(res.status).toBe(400);
  });

  it("400s on explicit parent-directory traversal in path", async () => {
    await setToken("T");
    await seedVideo("v1");
    const res = await callArtifact("T", {
      videoId: "v1",
      path: "../other/secret.txt",
    });
    expect(res.status).toBe(400);
  });

  it("400s on absolute path in the path query param", async () => {
    // Defense in depth: even if the resolve-startsWith check below
    // catches escape attempts, an absolute path is rejected up front so
    // we don't even touch the FS with hostile input.
    await setToken("T");
    await seedVideo("v1");
    const res = await callArtifact("T", {
      videoId: "v1",
      path: "/etc/passwd",
    });
    expect(res.status).toBe(400);
  });

  it("404s when the requested videoId is unknown", async () => {
    await setToken("T");
    // Skip the video seed — the FK row never existed.
    const res = await callArtifact("T", {
      videoId: "unknown",
      path: "loop_image.png",
    });
    expect(res.status).toBe(404);
  });

  it("404s when the file does not exist on disk", async () => {
    await setToken("T");
    await seedVideo("v1");
    // No artifact written.
    const res = await callArtifact("T", {
      videoId: "v1",
      path: "loop_image.png",
    });
    expect(res.status).toBe(404);
  });

  it("streams the file with the inferred content-type and content-length headers", async () => {
    await setToken("T");
    await seedVideo("v1");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeArtifact("v1", "loop_image.png", png);

    const res = await callArtifact("T", {
      videoId: "v1",
      path: "loop_image.png",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe(String(png.byteLength));
    const body = Buffer.from(await res.arrayBuffer());
    expect(Buffer.compare(body, png)).toBe(0);
  });
});
