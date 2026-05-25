// Tests for POST /api/videos/:id/open-folder.
//
// The non-Windows 400 (`unsupported_platform`) branch is intentionally not
// covered here: mocking `process.platform` is brittle across Node versions,
// and the guard is a one-line `if` that isn't load-bearing. See the route
// file and `docs/plans/2026-05-16-open-folder-action.md` (Phase 1) for the
// rationale.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Mock the system boundary (`node:child_process`). The route only uses
// `spawn` — return a spy whose return value exposes `unref()` so the route
// can call it without crashing.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    default: { ...actual, spawn: spawnMock },
    spawn: spawnMock,
  };
});

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-open-folder-"));
  process.env.DATABASE_URL = join(tempDir, "test.db");
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
  const { getDb, seedDefaultSettings, seedDefaultWorkflows } = await import(
    "@/lib/db"
  );
  const db = getDb();
  db.exec(
    "DELETE FROM video_steps; DELETE FROM videos; DELETE FROM workflow_steps; DELETE FROM workflows; DELETE FROM settings;"
  );
  seedDefaultSettings(db);
  seedDefaultWorkflows(db);
  spawnMock.mockReset();
  // Default return: an object exposing unref(). Individual tests can
  // override via mockReturnValueOnce / mockImplementationOnce.
  spawnMock.mockReturnValue({ unref: vi.fn() });
});

async function seedVideo(
  videoId: string,
  overrides: Partial<{ status: string }> = {}
): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO videos (id, title, topic_info, workflow_id, status, current_step, failed_step, failed_reason, started_at, finished_at, delete_requested, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    videoId,
    "T",
    "info",
    "comfyui",
    overrides.status ?? "done",
    null,
    null,
    null,
    null,
    now,
    0,
    now
  );
}

describe("POST /api/videos/:id/open-folder", () => {
  it("returns 404 when the video does not exist", async () => {
    const { POST } = await import(
      "@/app/api/videos/[id]/open-folder/route"
    );
    const res = await POST(
      new Request("http://localhost/api/videos/nope/open-folder", {
        method: "POST",
      }),
      { params: { id: "nope" } }
    );
    expect(res.status).toBe(404);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns 410 folder_missing when the project folder is absent on disk", async () => {
    await seedVideo("v1", { status: "done" });
    // Point PROJECTS_DIR at a directory that exists, but do NOT create
    // the per-video subfolder inside it.
    const projectsDir = join(tempDir, "projects-folder-missing");
    mkdirSync(projectsDir, { recursive: true });
    process.env.PROJECTS_DIR = projectsDir;

    const { POST } = await import(
      "@/app/api/videos/[id]/open-folder/route"
    );
    const res = await POST(
      new Request("http://localhost/api/videos/v1/open-folder", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toBe("folder_missing");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns explorer.exe with /select,<absolutePath ending in final.mp4>, detached + stdio:'ignore', and unref()'s the child", async () => {
    await seedVideo("v1", { status: "done" });
    const projectsDir = join(tempDir, "projects-happy");
    mkdirSync(join(projectsDir, "v1"), { recursive: true });
    process.env.PROJECTS_DIR = projectsDir;

    const unref = vi.fn();
    spawnMock.mockReturnValueOnce({ unref });

    const { POST } = await import(
      "@/app/api/videos/[id]/open-folder/route"
    );
    const res = await POST(
      new Request("http://localhost/api/videos/v1/open-folder", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    expect(spawnMock).toHaveBeenCalledOnce();
    const [bin, args, opts] = spawnMock.mock.calls[0];
    expect(bin).toBe("explorer.exe");
    expect(Array.isArray(args)).toBe(true);
    expect(args).toHaveLength(1);
    // Use path.join/resolve to build the expected suffix so the assertion
    // is slash-direction-agnostic across hosts.
    const expectedFinal = join(resolve(projectsDir), "v1", "final.mp4");
    expect(args[0]).toBe(`/select,${expectedFinal}`);
    expect(opts).toMatchObject({ detached: true, stdio: "ignore" });
    expect(unref).toHaveBeenCalledOnce();
  });

  it("returns 500 spawn_failed when spawn() throws", async () => {
    await seedVideo("v1", { status: "done" });
    const projectsDir = join(tempDir, "projects-spawn-throw");
    mkdirSync(join(projectsDir, "v1"), { recursive: true });
    process.env.PROJECTS_DIR = projectsDir;

    spawnMock.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    const { POST } = await import(
      "@/app/api/videos/[id]/open-folder/route"
    );
    const res = await POST(
      new Request("http://localhost/api/videos/v1/open-folder", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("spawn_failed");
  });
});
