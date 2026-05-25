import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let projectsDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-files-"));
  process.env.DATABASE_URL = join(tempDir, "test.db");
  projectsDir = join(tempDir, "projects");
  process.env.PROJECTS_DIR = projectsDir;
});

afterAll(async () => {
  const { getDb } = await import("@/lib/db");
  try {
    getDb().close();
  } catch {
    // already closed
  }
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { getDb, seedDefaultSettings } = await import("@/lib/db");
  const db = getDb();
  db.exec("DELETE FROM video_steps; DELETE FROM videos;");
  seedDefaultSettings(db);
  rmSync(projectsDir, { recursive: true, force: true });
  mkdirSync(projectsDir, { recursive: true });
});

async function seedVideo(videoId: string): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, 'done', 1000)"
  ).run(videoId, "T", "info", "comfyui");
}

function writeProjectFile(
  videoId: string,
  rel: string,
  contents: string
): void {
  const full = join(projectsDir, videoId, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

describe("GET /api/videos/[id]/files/[...path]", () => {
  it("serves final.mp4 with video/mp4 content-type", async () => {
    await seedVideo("v1");
    writeProjectFile("v1", "final.mp4", "mp4 bytes");

    const { GET } = await import(
      "@/app/api/videos/[id]/files/[...path]/route"
    );
    const res = await GET(
      new Request("http://localhost/api/videos/v1/files/final.mp4"),
      { params: { id: "v1", path: ["final.mp4"] } }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/video\/mp4/);
    const body = Buffer.from(await res.arrayBuffer()).toString();
    expect(body).toBe("mp4 bytes");
  });

  it("serves pipeline.log as text/plain", async () => {
    await seedVideo("v1");
    writeProjectFile("v1", "pipeline.log", "[step] hello\n");

    const { GET } = await import(
      "@/app/api/videos/[id]/files/[...path]/route"
    );
    const res = await GET(
      new Request("http://localhost/api/videos/v1/files/pipeline.log"),
      { params: { id: "v1", path: ["pipeline.log"] } }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    const body = Buffer.from(await res.arrayBuffer()).toString();
    expect(body).toBe("[step] hello\n");
  });

  it("serves nested paths like script/full_script.md", async () => {
    await seedVideo("v1");
    writeProjectFile("v1", "script/full_script.md", "# Title");

    const { GET } = await import(
      "@/app/api/videos/[id]/files/[...path]/route"
    );
    const res = await GET(
      new Request(
        "http://localhost/api/videos/v1/files/script/full_script.md"
      ),
      { params: { id: "v1", path: ["script", "full_script.md"] } }
    );
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer()).toString();
    expect(body).toBe("# Title");
  });

  it("returns 404 when the file does not exist", async () => {
    await seedVideo("v1");

    const { GET } = await import(
      "@/app/api/videos/[id]/files/[...path]/route"
    );
    const res = await GET(
      new Request("http://localhost/api/videos/v1/files/missing.mp4"),
      { params: { id: "v1", path: ["missing.mp4"] } }
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the video id is not in the DB", async () => {
    // Even if someone crafted a path, an unknown video id must not
    // serve anything — the DB is the source of truth for which ids
    // are ours.
    const { GET } = await import(
      "@/app/api/videos/[id]/files/[...path]/route"
    );
    const res = await GET(
      new Request("http://localhost/api/videos/nope/files/final.mp4"),
      { params: { id: "nope", path: ["final.mp4"] } }
    );
    expect(res.status).toBe(404);
  });

  it("rejects path traversal attempts with 400", async () => {
    await seedVideo("v1");
    // Try to escape the project dir with ../. Even if a higher-level
    // file exists, this must be refused.
    writeFileSync(join(projectsDir, "secret.txt"), "do not leak");

    const { GET } = await import(
      "@/app/api/videos/[id]/files/[...path]/route"
    );
    const res = await GET(
      new Request("http://localhost/api/videos/v1/files/..%2Fsecret.txt"),
      { params: { id: "v1", path: ["..", "secret.txt"] } }
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty path", async () => {
    await seedVideo("v1");
    const { GET } = await import(
      "@/app/api/videos/[id]/files/[...path]/route"
    );
    const res = await GET(
      new Request("http://localhost/api/videos/v1/files/"),
      { params: { id: "v1", path: [] } }
    );
    expect(res.status).toBe(400);
  });
});
