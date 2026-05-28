import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-magnific-next-task-"));
  process.env.DATABASE_URL = join(tempDir, "test.db");
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

async function enqueue(row: {
  video_id: string;
  mode: "image-hitl" | "image-to-video" | "image-batch";
  prompt: string;
  output_path: string;
  reference_image?: string | null;
  no_timeout?: 0 | 1;
}): Promise<number> {
  const magnificRepo = await import("@/lib/repos/magnific");
  const { getDb } = await import("@/lib/db");
  return magnificRepo.enqueueTask(getDb(), {
    video_id: row.video_id,
    mode: row.mode,
    prompt: row.prompt,
    output_path: row.output_path,
    reference_image: row.reference_image ?? null,
    no_timeout: row.no_timeout ?? 0,
    created_at: Math.floor(Date.now() / 1000),
  });
}

function callNextTask(
  token: string,
  body: unknown = {},
  origin = "http://localhost"
): Promise<Response> {
  return import("@/app/api/magnific/next-task/[token]/route").then(
    ({ POST }) =>
      POST(
        new Request(`${origin}/api/magnific/next-task/${token}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: { token } }
      )
  );
}

describe("POST /api/magnific/next-task/:token", () => {
  it("404s when the URL token differs from the magnific_token setting", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "the-real-token");

    const res = await callNextTask("not-the-token", {});
    expect(res.status).toBe(404);
  });

  it("404s when the magnific_token setting is the empty default (no auth-bypass via empty string)", async () => {
    // magnific_token defaults to "" before the operator first opens
    // Settings > Magnific. An extension that hits the route with an
    // empty URL segment must NOT authenticate as if the empty default
    // were the credential.
    const { getSetting } = await import("@/lib/settings");
    expect(getSetting("magnific_token")).toBe("");

    const res = await callNextTask("", {});
    expect(res.status).toBe(404);
  });

  it("dispatches an image-hitl row with model from magnific_image_model, flips status to dispatched, omits reference_image_url", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "T-hitl");
    setSetting("magnific_image_model", "flux-pro");
    await seedVideo("vid_hitl");
    const taskRowId = await enqueue({
      video_id: "vid_hitl",
      mode: "image-hitl",
      prompt: "a Roman aqueduct at sunset",
      output_path: "loop_image.png",
      no_timeout: 1,
    });

    const res = await callNextTask("T-hitl", {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      mode: "image-hitl",
      prompt: "a Roman aqueduct at sunset",
      model: "flux-pro",
      output_path: "loop_image.png",
    });
    expect(body.id).toBeDefined();
    expect(body.reference_image_url).toBeUndefined();
    // Regression guard: image-batch-only fields never leak into other modes.
    expect(body.video_title).toBeUndefined();
    expect(body.magnific_project_id).toBeUndefined();

    // Row flipped to dispatched + external_task_id minted; id in body
    // matches the minted external_task_id (the extension's task handle).
    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT status, external_task_id FROM magnific_queue WHERE id = ?"
      )
      .get(taskRowId) as {
      status: string;
      external_task_id: string | null;
    };
    expect(row.status).toBe("dispatched");
    expect(row.external_task_id).toMatch(/^\d+_\d+$/);
    expect(body.id).toBe(row.external_task_id);
  });

  it("returns empty body when no pending row exists", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "T-empty");

    const res = await callNextTask("T-empty", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("dispatches an image-to-video row with model from magnific_video_model + reference_image_url against the request origin", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "T-i2v");
    setSetting("magnific_video_model", "seedance-v2");
    await seedVideo("vid_i2v");
    await enqueue({
      video_id: "vid_i2v",
      mode: "image-to-video",
      prompt: "slow cinematic loop",
      output_path: "loop_clip.mp4",
      reference_image: "loop_image.png",
      no_timeout: 0,
    });

    const res = await callNextTask("T-i2v", {}, "https://example.com:8080");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      mode: "image-to-video",
      prompt: "slow cinematic loop",
      model: "seedance-v2",
      output_path: "loop_clip.mp4",
    });
    // reference_image_url points back at the artifact route, carrying
    // the same per-instance token, with videoId + path query params.
    expect(typeof body.reference_image_url).toBe("string");
    const url = new URL(body.reference_image_url);
    expect(url.origin).toBe("https://example.com:8080");
    expect(url.pathname).toBe("/api/magnific/artifact/T-i2v");
    expect(url.searchParams.get("videoId")).toBe("vid_i2v");
    expect(url.searchParams.get("path")).toBe("loop_image.png");
    // Regression guard: image-batch-only fields never leak into other modes.
    expect(body.video_title).toBeUndefined();
    expect(body.magnific_project_id).toBeUndefined();
  });

  it("dispatches an image-batch row with video_title + magnific_project_id joined from the video and model from magnific_image_model", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "T-ib");
    setSetting("magnific_image_model", "nano-banana-2");
    // The video model must NOT bleed into image-batch.
    setSetting("magnific_video_model", "seedance-v2");
    await seedVideo("vid_ib", {
      title: "The Fall of Rome",
      magnificProjectId: "proj-uuid-123",
    });
    await enqueue({
      video_id: "vid_ib",
      mode: "image-batch",
      prompt: "a Roman senator addressing the forum",
      output_path: "images/0001.png",
      no_timeout: 0,
    });

    const res = await callNextTask("T-ib", {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      mode: "image-batch",
      prompt: "a Roman senator addressing the forum",
      model: "nano-banana-2",
      output_path: "images/0001.png",
      video_title: "The Fall of Rome",
      magnific_project_id: "proj-uuid-123",
    });
    // model resolves to the IMAGE model structurally, never the video model.
    expect(body.model).not.toBe("seedance-v2");
    // image-batch rides the normal reaper path — no reference frame upload.
    expect(body.reference_image_url).toBeUndefined();
  });

  it("surfaces magnific_project_id: null for an image-batch row whose video has no cached Project yet (first row)", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "T-ib0");
    setSetting("magnific_image_model", "nano-banana-2");
    // No magnificProjectId → defaults to null (the first row creates the Project).
    await seedVideo("vid_ib0", { title: "Byzantium" });
    await enqueue({
      video_id: "vid_ib0",
      mode: "image-batch",
      prompt: "the walls of Constantinople",
      output_path: "images/0001.png",
    });

    const res = await callNextTask("T-ib0", {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.video_title).toBe("Byzantium");
    expect(body.magnific_project_id).toBeNull();
  });

  it("returns empty body when queue_state='paused', even with a dispatchable row", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("magnific_token", "T-paused");
    setSetting("queue_state", "paused");
    await seedVideo("vid_qp");
    const taskId = await enqueue({
      video_id: "vid_qp",
      mode: "image-hitl",
      prompt: "a Roman scene",
      output_path: "loop_image.png",
      no_timeout: 1,
    });

    const res = await callNextTask("T-paused", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});

    // The row was NOT claimed — it stays pending.
    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT status FROM magnific_queue WHERE id = ?")
      .get(taskId) as { status: string };
    expect(row.status).toBe("pending");
  });
});
