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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-flow-artifact-"));
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
  db.exec(
    "DELETE FROM google_flow_queue; DELETE FROM google_flow_accounts; DELETE FROM videos; DELETE FROM settings;"
  );
  seedDefaultSettings(db);
  rmSync(projectsDir, { recursive: true, force: true });
  mkdirSync(projectsDir, { recursive: true });
});

async function seedAccount(token: string, id = "acc_01"): Promise<void> {
  const { getDb } = await import("@/lib/db");
  getDb()
    .prepare(
      `INSERT INTO google_flow_accounts (id, name, token, enabled, paused_until, created_at)
       VALUES (?, ?, ?, 1, NULL, ?)`
    )
    .run(id, id, token, Math.floor(Date.now() / 1000));
}

async function seedVideo(id: string): Promise<void> {
  const { getDb } = await import("@/lib/db");
  getDb()
    .prepare(
      `INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?)`
    )
    .run(id, "T", "info", "comfyui", Date.now());
}

interface SeedTaskInput {
  videoId: string;
  externalTaskId: string;
  accountId?: string;
  status?: string;
  reference_image?: string | null;
}

async function seedDispatchedTask(input: SeedTaskInput): Promise<void> {
  const { getDb } = await import("@/lib/db");
  getDb()
    .prepare(
      `INSERT INTO google_flow_queue (
         video_id, chunk_id, kind, mode, prompt,
         reference_image, output_path, status,
         assigned_account_id, external_task_id, priority, created_at, dispatched_at
       ) VALUES (?, ?, 'image', 'createImage', 'p',
                ?, ?, ?,
                ?, ?, 0, ?, ?)`
    )
    .run(
      input.videoId,
      "chunk_01",
      input.reference_image ?? null,
      "images/chunk_01.png",
      input.status ?? "dispatched",
      input.accountId ?? "acc_01",
      input.externalTaskId,
      Math.floor(Date.now() / 1000),
      Math.floor(Date.now() / 1000)
    );
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
  taskId: string
): Promise<Response> {
  const { GET } = await import(
    "@/app/api/flow/artifact/[token]/[taskId]/route"
  );
  return GET(
    new Request(`http://localhost/api/flow/artifact/${token}/${taskId}`),
    { params: { token, taskId } }
  );
}

describe("GET /api/flow/artifact/:token/:taskId", () => {
  it("404s on unknown token (no Flow account has that token)", async () => {
    await seedAccount("real-token");
    const res = await callArtifact("not-the-token", "1_0");
    expect(res.status).toBe(404);
  });

  it("404s when the external_task_id is unknown", async () => {
    await seedAccount("T");
    const res = await callArtifact("T", "999_0");
    expect(res.status).toBe(404);
  });

  it("403s when the task is assigned to a different account (no cross-account artifact reads)", async () => {
    // Two accounts; the task is assigned to acc_02, but the request
    // uses acc_01's token. The artifact route must refuse — this is
    // the P1 fix from Codex's review.
    await seedAccount("T-alice", "acc_01");
    await seedAccount("T-bob", "acc_02");
    await seedVideo("v1");
    await seedDispatchedTask({
      videoId: "v1",
      externalTaskId: "1_1000",
      accountId: "acc_02",
      reference_image: "character_reference.png",
    });
    writeArtifact("v1", "character_reference.png", Buffer.from([0x89, 0x50]));

    const res = await callArtifact("T-alice", "1_1000");
    expect(res.status).toBe(403);
  });

  it("404s when the task is not currently in `dispatched` status", async () => {
    // The reference URL is only valid while the task is in-flight. A
    // task that's been requeued, finished, or failed is no longer
    // legitimately fetching its reference; refuse stale URL reuse.
    await seedAccount("T", "acc_01");
    await seedVideo("v1");
    await seedDispatchedTask({
      videoId: "v1",
      externalTaskId: "1_1000",
      accountId: "acc_01",
      status: "done",
      reference_image: "character_reference.png",
    });
    writeArtifact("v1", "character_reference.png", Buffer.from([0x89]));

    const res = await callArtifact("T", "1_1000");
    expect(res.status).toBe(404);
  });

  it("404s when the dispatched task has no reference_image", async () => {
    await seedAccount("T", "acc_01");
    await seedVideo("v1");
    await seedDispatchedTask({
      videoId: "v1",
      externalTaskId: "1_1000",
      accountId: "acc_01",
      reference_image: null,
    });

    const res = await callArtifact("T", "1_1000");
    expect(res.status).toBe(404);
  });

  it("404s when the reference file is missing on disk (operator deleted, or unwritten)", async () => {
    await seedAccount("T", "acc_01");
    await seedVideo("v1");
    await seedDispatchedTask({
      videoId: "v1",
      externalTaskId: "1_1000",
      accountId: "acc_01",
      reference_image: "character_reference.png",
    });
    // Note: no writeArtifact() — file isn't there.

    const res = await callArtifact("T", "1_1000");
    expect(res.status).toBe(404);
  });

  it("streams the reference PNG with image/png content type on the happy path", async () => {
    await seedAccount("T", "acc_01");
    await seedVideo("v1");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    await seedDispatchedTask({
      videoId: "v1",
      externalTaskId: "1_1000",
      accountId: "acc_01",
      reference_image: "character_reference.png",
    });
    writeArtifact("v1", "character_reference.png", bytes);

    const res = await callArtifact("T", "1_1000");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const returned = Buffer.from(await res.arrayBuffer());
    expect(returned.equals(bytes)).toBe(true);
  });
});
