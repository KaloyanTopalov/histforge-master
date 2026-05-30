import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Wrap @/lib/cleanup with a passthrough mock so tests can assert
// whether the route's lifecycle path invoked the wipe. Tests that
// expect FS proof (#2, #7-call-1) still see real wipe behavior because
// the mock delegates to the actual implementation.
vi.mock("@/lib/cleanup", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cleanup")>(
    "@/lib/cleanup"
  );
  return {
    cleanupProjectArtifacts: vi.fn(actual.cleanupProjectArtifacts),
  };
});

let tempDir: string;
let projectsDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-video-cleanup-"));
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
    // already closed
  }
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.PROJECTS_DIR;
  delete process.env.DATABASE_URL;
});

beforeEach(async () => {
  const { getDb, seedDefaultSettings } = await import("@/lib/db");
  const db = getDb();
  db.exec("DELETE FROM video_steps; DELETE FROM videos;");
  // Seeds auto_cleanup_after_render="false" — the route deliberately
  // bypasses this setting (it's the explicit operator trigger), so this
  // seed proves the route's wipe is independent of the step's gating.
  seedDefaultSettings(db);
  rmSync(projectsDir, { recursive: true, force: true });
  mkdirSync(projectsDir, { recursive: true });
  const cleanupModule = await import("@/lib/cleanup");
  vi.mocked(cleanupModule.cleanupProjectArtifacts).mockClear();
});

interface SeedOpts {
  status: "done" | "queued" | "in_progress" | "failed";
  withIntermediates?: boolean;
  withKeepSet?: boolean;
}

async function seedVideo(videoId: string, opts: SeedOpts): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO videos
       (id, title, topic_info, workflow_id, kind, status,
        current_step, finished_at, output_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    videoId,
    "Test",
    "topic info",
    "comfyui",
    "narrative",
    opts.status,
    opts.status === "in_progress" ? "render" : null,
    opts.status === "done" ? 2000 : null,
    opts.status === "done" ? `projects/${videoId}/final.mp4` : null,
    now
  );

  const projDir = join(projectsDir, videoId);
  mkdirSync(projDir, { recursive: true });

  if (opts.withKeepSet) {
    writeFileSync(join(projDir, "final.mp4"), "final");
    writeFileSync(join(projDir, "pipeline.log"), "log");
    mkdirSync(join(projDir, "script"), { recursive: true });
    writeFileSync(join(projDir, "script", "full_script.md"), "script");
  }

  if (opts.withIntermediates) {
    mkdirSync(join(projDir, "images"), { recursive: true });
    writeFileSync(join(projDir, "images", "image_001.png"), "img");
    mkdirSync(join(projDir, "audio"), { recursive: true });
    writeFileSync(join(projDir, "audio", "narration.mp3"), "audio");
    mkdirSync(join(projDir, "alignment"), { recursive: true });
    writeFileSync(join(projDir, "alignment", "alignment.json"), "[]");
    mkdirSync(join(projDir, "chunks"), { recursive: true });
    writeFileSync(join(projDir, "chunks", "chunks.json"), "[]");
  }
}

async function postCleanup(videoId: string): Promise<Response> {
  const { POST } = await import("@/app/api/videos/[id]/cleanup/route");
  return POST(
    new Request(`http://localhost/api/videos/${videoId}/cleanup`, {
      method: "POST",
    }),
    { params: { id: videoId } }
  );
}

describe("POST /api/videos/:id/cleanup", () => {
  it("404 when the video does not exist", async () => {
    const res = await postCleanup("nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("not_found");
  });

  it("200 + already_clean=false + FS proof when done video has intermediates", async () => {
    await seedVideo("v1", {
      status: "done",
      withKeepSet: true,
      withIntermediates: true,
    });

    const res = await postCleanup("v1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; already_clean: boolean };
    expect(body.ok).toBe(true);
    expect(body.already_clean).toBe(false);

    const projDir = join(projectsDir, "v1");
    // Intermediates wiped
    expect(existsSync(join(projDir, "images"))).toBe(false);
    expect(existsSync(join(projDir, "audio"))).toBe(false);
    expect(existsSync(join(projDir, "alignment"))).toBe(false);
    expect(existsSync(join(projDir, "chunks"))).toBe(false);
    // KEEP set preserved
    expect(existsSync(join(projDir, "final.mp4"))).toBe(true);
    expect(existsSync(join(projDir, "pipeline.log"))).toBe(true);
    expect(existsSync(join(projDir, "script", "full_script.md"))).toBe(true);
  });

  it("200 + already_clean=true + no wipe call when intermediates absent (idempotency single-shot)", async () => {
    await seedVideo("v2", {
      status: "done",
      withKeepSet: true,
      withIntermediates: false,
    });

    const res = await postCleanup("v2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; already_clean: boolean };
    expect(body.ok).toBe(true);
    expect(body.already_clean).toBe(true);

    // The structural contract: detect already-clean and skip the wipe.
    // No FS work, no cleanupProjectArtifacts call.
    const cleanupModule = await import("@/lib/cleanup");
    expect(
      vi.mocked(cleanupModule.cleanupProjectArtifacts)
    ).not.toHaveBeenCalled();

    // KEEP set untouched
    const projDir = join(projectsDir, "v2");
    expect(existsSync(join(projDir, "final.mp4"))).toBe(true);
    expect(existsSync(join(projDir, "pipeline.log"))).toBe(true);
    expect(existsSync(join(projDir, "script", "full_script.md"))).toBe(true);
  });

  it("409 + reason=not_done when video status is queued", async () => {
    await seedVideo("v3", {
      status: "queued",
      withKeepSet: false,
      withIntermediates: true,
    });
    const res = await postCleanup("v3");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("not_done");

    // Intermediates untouched — non-done status must not trigger a wipe.
    expect(existsSync(join(projectsDir, "v3", "images"))).toBe(true);
  });

  it("409 + reason=not_done when video status is in_progress", async () => {
    await seedVideo("v4", {
      status: "in_progress",
      withKeepSet: false,
      withIntermediates: true,
    });
    const res = await postCleanup("v4");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("not_done");

    expect(existsSync(join(projectsDir, "v4", "images"))).toBe(true);
  });

  it("409 + reason=not_done when video status is failed (spec: button is done-only, route rejects all non-done)", async () => {
    await seedVideo("v5", {
      status: "failed",
      withKeepSet: false,
      withIntermediates: true,
    });
    const res = await postCleanup("v5");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("not_done");

    expect(existsSync(join(projectsDir, "v5", "images"))).toBe(true);
  });

  it("idempotent on repeat: first call already_clean=false, second already_clean=true (wipe invoked exactly once)", async () => {
    await seedVideo("v6", {
      status: "done",
      withKeepSet: true,
      withIntermediates: true,
    });

    const res1 = await postCleanup("v6");
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as {
      ok: boolean;
      already_clean: boolean;
    };
    expect(body1.ok).toBe(true);
    expect(body1.already_clean).toBe(false);

    const res2 = await postCleanup("v6");
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as {
      ok: boolean;
      already_clean: boolean;
    };
    expect(body2.ok).toBe(true);
    expect(body2.already_clean).toBe(true);

    // Total wipe invocations across both POSTs: exactly 1.
    const cleanupModule = await import("@/lib/cleanup");
    expect(
      vi.mocked(cleanupModule.cleanupProjectArtifacts)
    ).toHaveBeenCalledTimes(1);

    // KEEP set still present after both calls.
    const projDir = join(projectsDir, "v6");
    expect(existsSync(join(projDir, "final.mp4"))).toBe(true);
    expect(existsSync(join(projDir, "pipeline.log"))).toBe(true);
    expect(existsSync(join(projDir, "script", "full_script.md"))).toBe(true);
  });
});
