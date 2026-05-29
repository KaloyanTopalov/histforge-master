import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let projectsDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-magnific-submit-"));
  projectsDir = join(tempDir, "projects");
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
  const { getDb, seedDefaultSettings } = await import("@/lib/db");
  const db = getDb();
  db.exec(
    "DELETE FROM magnific_queue; DELETE FROM videos; DELETE FROM settings;"
  );
  seedDefaultSettings(db);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seedVideo(
  id: string,
  opts?: { title?: string; magnificProjectId?: string | null }
): Promise<void> {
  const { getDb } = await import("@/lib/db");
  getDb()
    .prepare(
      `INSERT INTO videos (id, title, topic_info, workflow_id, status, kind, magnific_project_id, created_at)
       VALUES (?, ?, ?, ?, 'queued', 'music_video', ?, ?)`
    )
    .run(
      id,
      opts?.title ?? "T",
      "info",
      "music-video-magnific-suno",
      opts?.magnificProjectId ?? null,
      Date.now()
    );
}

async function readVideoProjectId(id: string): Promise<string | null> {
  const { getDb } = await import("@/lib/db");
  const row = getDb()
    .prepare("SELECT magnific_project_id FROM videos WHERE id = ?")
    .get(id) as { magnific_project_id: string | null } | undefined;
  return row?.magnific_project_id ?? null;
}

async function seedDispatched(args: {
  videoId: string;
  mode: "image-hitl" | "image-to-video" | "image-batch";
  externalTaskId: string;
  outputPath: string;
  referenceImage?: string | null;
  noTimeout?: 0 | 1;
}): Promise<number> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const magnificRepo = await import("@/lib/repos/magnific");
  const now = Math.floor(Date.now() / 1000);
  const id = magnificRepo.enqueueTask(db, {
    video_id: args.videoId,
    mode: args.mode,
    prompt: "p",
    output_path: args.outputPath,
    reference_image: args.referenceImage ?? null,
    no_timeout: args.noTimeout ?? 0,
    created_at: now,
  });
  db.prepare(
    `UPDATE magnific_queue
        SET status = 'dispatched',
            dispatched_at = ?,
            external_task_id = ?
      WHERE id = ?`
  ).run(now, args.externalTaskId, id);
  return id;
}

function callSubmit(token: string, body: unknown): Promise<Response> {
  return import("@/app/api/magnific/submit-result/[token]/route").then(
    ({ POST }) =>
      POST(
        new Request(`http://localhost/api/magnific/submit-result/${token}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: { token } }
      )
  );
}

describe("POST /api/magnific/submit-result/:token", () => {
  it("404s when the URL token differs from the magnific_token setting", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "T-real");

    const res = await callSubmit("T-wrong", {
      external_task_id: "1_1",
      status: "done",
      resultUrl: "https://cdn.cdnpk.net/output/x.png",
    });
    expect(res.status).toBe(404);
  });

  it("returns {success:true, duplicate:true} when external_task_id is unknown (stale submission)", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "T-stale");

    const res = await callSubmit("T-stale", {
      external_task_id: "9999_9999",
      status: "done",
      resultUrl: "https://cdn.cdnpk.net/output/x.png",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, duplicate: true });
  });

  it("on success body: downloads to projects/<videoId>/<output_path> and flips row to done", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "T-ok");
    await seedVideo("vid_ok");
    const rowId = await seedDispatched({
      videoId: "vid_ok",
      mode: "image-hitl",
      externalTaskId: "42_1700000000",
      outputPath: "loop_image.png",
    });

    const bodyBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetchSpy = vi.fn(
      async (_input: unknown) =>
        new Response(bodyBytes, {
          status: 200,
          headers: { "content-type": "image/png" },
        })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const res = await callSubmit("T-ok", {
      external_task_id: "42_1700000000",
      status: "done",
      resultUrl: "https://cdn.cdnpk.net/output/42.png",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    // fetch was called with the magnific URL
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "https://cdn.cdnpk.net/output/42.png",
      expect.any(Object)
    );

    // File landed at projects/<videoId>/<output_path>
    const expectedPath = join(projectsDir, "vid_ok", "loop_image.png");
    expect(existsSync(expectedPath)).toBe(true);
    expect(Array.from(readFileSync(expectedPath))).toEqual(Array.from(bodyBytes));

    // Row flipped to done with result_url + completed_at set
    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT status, result_url, completed_at FROM magnific_queue WHERE id = ?"
      )
      .get(rowId) as {
      status: string;
      result_url: string | null;
      completed_at: number | null;
    };
    expect(row.status).toBe("done");
    expect(row.result_url).toBe("https://cdn.cdnpk.net/output/42.png");
    expect(row.completed_at).not.toBeNull();
  });

  it("on failure body: flips row to failed with error reason, does not auto-requeue", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "T-fail");
    await seedVideo("vid_f");
    const rowId = await seedDispatched({
      videoId: "vid_f",
      mode: "image-to-video",
      externalTaskId: "55_1700000000",
      outputPath: "loop_clip.mp4",
      referenceImage: "loop_image.png",
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await callSubmit("T-fail", {
      external_task_id: "55_1700000000",
      status: "failed",
      error: "Magnific UI timed out waiting for video",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    expect(fetchSpy).not.toHaveBeenCalled();

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT status, error_reason FROM magnific_queue WHERE id = ?"
      )
      .get(rowId) as { status: string; error_reason: string | null };
    expect(row.status).toBe("failed");
    expect(row.error_reason).toBe("Magnific UI timed out waiting for video");
  });

  it("on SSRF-disallowed resultUrl: flips row to failed, never calls fetch, still returns {success:true}", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "T-ssrf");
    await seedVideo("vid_s");
    const rowId = await seedDispatched({
      videoId: "vid_s",
      mode: "image-hitl",
      externalTaskId: "66_1700000000",
      outputPath: "loop_image.png",
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await callSubmit("T-ssrf", {
      external_task_id: "66_1700000000",
      status: "done",
      resultUrl: "http://127.0.0.1/leak.png",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    expect(fetchSpy).not.toHaveBeenCalled();

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT status, error_reason FROM magnific_queue WHERE id = ?"
      )
      .get(rowId) as { status: string; error_reason: string | null };
    expect(row.status).toBe("failed");
    expect(row.error_reason).toMatch(/invalid result host/i);
    expect(existsSync(join(projectsDir, "vid_s"))).toBe(false);
  });

  it("returns {success:true, duplicate:true} when the row is already done (idempotent re-submit)", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "T-already");
    await seedVideo("vid_a");
    const rowId = await seedDispatched({
      videoId: "vid_a",
      mode: "image-hitl",
      externalTaskId: "11_1700000000",
      outputPath: "loop_image.png",
    });
    const { getDb } = await import("@/lib/db");
    getDb()
      .prepare("UPDATE magnific_queue SET status = 'done' WHERE id = ?")
      .run(rowId);

    const res = await callSubmit("T-already", {
      external_task_id: "11_1700000000",
      status: "done",
      resultUrl: "https://cdn.cdnpk.net/output/x.png",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, duplicate: true });
  });

  it("persists magnific_project_id from an image-batch done body to the videos row", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "T-ibp");
    await seedVideo("vid_ibp"); // magnific_project_id starts null
    await seedDispatched({
      videoId: "vid_ibp",
      mode: "image-batch",
      externalTaskId: "70_1700000000",
      outputPath: "images/0001.png",
    });

    const bodyBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetchSpy = vi.fn(
      async () =>
        new Response(bodyBytes, {
          status: 200,
          headers: { "content-type": "image/png" },
        })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const res = await callSubmit("T-ibp", {
      external_task_id: "70_1700000000",
      status: "done",
      resultUrl: "https://cdn.cdnpk.net/output/70.png",
      magnific_project_id: "new-proj-uuid",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    expect(await readVideoProjectId("vid_ibp")).toBe("new-proj-uuid");
  });

  it("clears a stale cached magnific_project_id when an image-batch row reports project_missing", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "T-ibc");
    await seedVideo("vid_ibc", { magnificProjectId: "stale-uuid" });
    const rowId = await seedDispatched({
      videoId: "vid_ibc",
      mode: "image-batch",
      externalTaskId: "71_1700000000",
      outputPath: "images/0001.png",
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await callSubmit("T-ibc", {
      external_task_id: "71_1700000000",
      status: "failed",
      error: "project_missing",
      magnific_project_id: null,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await readVideoProjectId("vid_ibc")).toBeNull();

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT status, error_reason FROM magnific_queue WHERE id = ?")
      .get(rowId) as { status: string; error_reason: string | null };
    expect(row.status).toBe("failed");
    expect(row.error_reason).toBe("project_missing");
  });

  it("leaves the cached magnific_project_id untouched when the field is absent from the body", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "T-iba");
    await seedVideo("vid_iba", { magnificProjectId: "keep-uuid" });
    await seedDispatched({
      videoId: "vid_iba",
      mode: "image-batch",
      externalTaskId: "72_1700000000",
      outputPath: "images/0001.png",
    });
    const bodyBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetchSpy = vi.fn(
      async () =>
        new Response(bodyBytes, {
          status: 200,
          headers: { "content-type": "image/png" },
        })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const res = await callSubmit("T-iba", {
      external_task_id: "72_1700000000",
      status: "done",
      resultUrl: "https://cdn.cdnpk.net/output/72.png",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    expect(await readVideoProjectId("vid_iba")).toBe("keep-uuid");
  });

  it("is idempotent when two image-batch rows report the same magnific_project_id", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "T-ibi");
    await seedVideo("vid_ibi"); // starts null
    await seedDispatched({
      videoId: "vid_ibi",
      mode: "image-batch",
      externalTaskId: "73_1700000000",
      outputPath: "images/0001.png",
    });
    await seedDispatched({
      videoId: "vid_ibi",
      mode: "image-batch",
      externalTaskId: "74_1700000000",
      outputPath: "images/0002.png",
    });
    const bodyBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetchSpy = vi.fn(
      async () =>
        new Response(bodyBytes, {
          status: 200,
          headers: { "content-type": "image/png" },
        })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const r1 = await callSubmit("T-ibi", {
      external_task_id: "73_1700000000",
      status: "done",
      resultUrl: "https://cdn.cdnpk.net/output/73.png",
      magnific_project_id: "X",
    });
    expect(await r1.json()).toEqual({ success: true });
    expect(await readVideoProjectId("vid_ibi")).toBe("X");

    const r2 = await callSubmit("T-ibi", {
      external_task_id: "74_1700000000",
      status: "done",
      resultUrl: "https://cdn.cdnpk.net/output/74.png",
      magnific_project_id: "X",
    });
    expect(await r2.json()).toEqual({ success: true });
    expect(await readVideoProjectId("vid_ibi")).toBe("X");
  });
});
