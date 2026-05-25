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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-videos-"));
  process.env.DATABASE_URL = join(tempDir, "test.db");
  process.env.PROJECTS_DIR = join(tempDir, "projects");
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
    "DELETE FROM video_steps; DELETE FROM videos; DELETE FROM workflow_steps; DELETE FROM workflows; DELETE FROM visual_styles; DELETE FROM settings;"
  );
  seedDefaultSettings(db);
  seedDefaultWorkflows(db);
});

async function seedVideo(
  videoId: string,
  title: string,
  createdAt: number,
  overrides: Partial<{
    status: string;
    topic_info: string;
    workflow_id: string;
    current_step: string | null;
    started_at: number | null;
    finished_at: number | null;
    output_path: string | null;
  }> = {}
): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  db.prepare(
    `INSERT INTO videos (id, title, topic_info, workflow_id, status, current_step, started_at, finished_at, output_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    videoId,
    title,
    overrides.topic_info ?? "info",
    overrides.workflow_id ?? "comfyui",
    overrides.status ?? "queued",
    overrides.current_step ?? null,
    overrides.started_at ?? null,
    overrides.finished_at ?? null,
    overrides.output_path ?? null,
    createdAt
  );
}

describe("GET /api/videos", () => {
  it("returns an empty videos envelope", async () => {
    const { GET } = await import("@/app/api/videos/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.videos).toEqual([]);
    expect(body).not.toHaveProperty("projectsDir");
  });

  it("returns queueState from the queue_state setting", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("queue_state", "paused");

    const { GET } = await import("@/app/api/videos/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queueState).toBe("paused");
  });

  it("returns queueState='running' by default", async () => {
    const { GET } = await import("@/app/api/videos/route");
    const res = await GET();
    const body = await res.json();
    expect(body.queueState).toBe("running");
  });

  it("returns bannerFlags with default empty/false values", async () => {
    const { GET } = await import("@/app/api/videos/route");
    const res = await GET();
    const body = await res.json();
    expect(body.bannerFlags).toEqual({
      flowCreateProjectFailed: "",
      googleFlowReloginNeeded: false,
      flowRecoveryAccounts: [],
      flowServiceOverloadUntil: "",
    });
  });

  it("surfaces flow_service_overload_until verbatim under bannerFlags", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("flow_service_overload_until", "1714151000");

    const { GET } = await import("@/app/api/videos/route");
    const res = await GET();
    const body = await res.json();
    expect(body.bannerFlags.flowServiceOverloadUntil).toBe("1714151000");
  });

  it("surfaces flow_create_project_failed verbatim under bannerFlags", async () => {
    const { setSetting } = await import("@/lib/settings");
    const payload = JSON.stringify({
      errorCode: "createProject_envelope_drift",
      httpStatus: 200,
      taskId: "task_1",
      when: 1714150000,
      accountId: "acc_01",
    });
    setSetting("flow_create_project_failed", payload);

    const { GET } = await import("@/app/api/videos/route");
    const res = await GET();
    const body = await res.json();
    expect(body.bannerFlags.flowCreateProjectFailed).toBe(payload);
  });

  it("surfaces google_flow_relogin_needed as a coerced boolean under bannerFlags", async () => {
    const { setSetting } = await import("@/lib/settings");
    setSetting("google_flow_relogin_needed", true);

    const { GET } = await import("@/app/api/videos/route");
    const res = await GET();
    const body = await res.json();
    expect(body.bannerFlags.googleFlowReloginNeeded).toBe(true);
  });

  it("returns all videos ordered newest-first with dashboard columns present", async () => {
    await seedVideo("v1", "Older", 1000, {
      status: "done",
      output_path: "projects/v1/final.mp4",
    });
    await seedVideo("v2", "In progress", 2000, {
      status: "in_progress",
      current_step: "voiceover",
      started_at: 2100,
    });
    await seedVideo("v3", "Newest", 3000);

    const { GET } = await import("@/app/api/videos/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.videos).toHaveLength(3);
    expect(body.videos.map((v: { id: string }) => v.id)).toEqual([
      "v3",
      "v2",
      "v1",
    ]);

    for (const v of body.videos) {
      expect(v).toHaveProperty("title");
      expect(v).toHaveProperty("status");
      expect(v).toHaveProperty("current_step");
      expect(v).toHaveProperty("started_at");
      expect(v).toHaveProperty("finished_at");
      expect(v).toHaveProperty("output_path");
      expect(v).toHaveProperty("workflow_id");
    }

    const inProgress = body.videos.find(
      (v: { id: string }) => v.id === "v2"
    );
    expect(inProgress).toMatchObject({
      status: "in_progress",
      current_step: "voiceover",
      started_at: 2100,
      finished_at: null,
    });
  });

  it("includes runtime_ms + running_step_started_at on every video", async () => {
    await seedVideo("v_done", "Done", 1000, {
      status: "done",
      started_at: 1000,
      finished_at: 5000,
    });
    await seedVideo("v_running", "Running", 2000, {
      status: "in_progress",
      current_step: "voiceover",
      started_at: 2000,
    });
    await seedVideo("v_new", "Topic", 3000, { status: "new" });

    const { getDb } = await import("@/lib/db");
    const db = getDb();
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?)"
    ).run("v_done", "research_outline", "done", 1000, 4000);
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?)"
    ).run("v_running", "research_outline", "done", 2000, 3500);
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?)"
    ).run("v_running", "voiceover", "running", 4000, null);

    const { GET } = await import("@/app/api/videos/route");
    const res = await GET();
    const body = await res.json();
    const byId = new Map<string, { runtime_ms: number; running_step_started_at: number | null }>(
      body.videos.map((v: { id: string; runtime_ms: number; running_step_started_at: number | null }) => [
        v.id,
        { runtime_ms: v.runtime_ms, running_step_started_at: v.running_step_started_at },
      ])
    );

    expect(byId.get("v_done")).toEqual({
      runtime_ms: 3000,
      running_step_started_at: null,
    });
    expect(byId.get("v_running")).toEqual({
      runtime_ms: 1500,
      running_step_started_at: 4000,
    });
    // No step rows yet — defaults to 0 / null so the client renders "—"
    expect(byId.get("v_new")).toEqual({
      runtime_ms: 0,
      running_step_started_at: null,
    });
  });
});

describe("POST /api/videos", () => {
  it("creates a new video with status=new", async () => {
    const { POST } = await import("@/app/api/videos/route");
    const res = await POST(
      new Request("http://localhost/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Rise of Rome",
          topic_info: "history",
          workflow_id: "comfyui",
        }),
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.video).toMatchObject({
      title: "Rise of Rome",
      topic_info: "history",
      workflow_id: "comfyui",
      status: "new",
    });
    expect(typeof body.video.id).toBe("string");
    expect(body.video.id.length).toBeGreaterThan(0);

    const { getDb } = await import("@/lib/db");
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM videos WHERE id = ?")
      .get(body.video.id) as { status: string; title: string };
    expect(row.status).toBe("new");
    expect(row.title).toBe("Rise of Rome");
  });

  it("returns 400 when required fields are missing", async () => {
    const { POST } = await import("@/app/api/videos/route");
    const res = await POST(
      new Request("http://localhost/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "only title" }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 workflow_not_found when workflow_id is unknown", async () => {
    const { POST } = await import("@/app/api/videos/route");
    const res = await POST(
      new Request("http://localhost/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "x",
          topic_info: "y",
          workflow_id: "does-not-exist",
        }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("workflow_not_found");
  });

  it("persists provided_script when supplied (ready-script flow)", async () => {
    const { POST } = await import("@/app/api/videos/route");
    const res = await POST(
      new Request("http://localhost/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Ready Script Video",
          topic_info: "[ready script — generation skipped]",
          workflow_id: "comfyui",
          provided_script: "Hello, world.",
        }),
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.video.provided_script).toBe("Hello, world.");

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT provided_script FROM videos WHERE id = ?")
      .get(body.video.id) as { provided_script: string | null };
    expect(row.provided_script).toBe("Hello, world.");
  });

  it("rejects an empty provided_script string (min(1))", async () => {
    const { POST } = await import("@/app/api/videos/route");
    const res = await POST(
      new Request("http://localhost/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Bad",
          topic_info: "info",
          workflow_id: "comfyui",
          provided_script: "",
        }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 workflow_disabled when the workflow exists but enabled=0", async () => {
    const { getDb } = await import("@/lib/db");
    getDb()
      .prepare("UPDATE workflows SET enabled = 0 WHERE id = ?")
      .run("comfyui");

    const { POST } = await import("@/app/api/videos/route");
    const res = await POST(
      new Request("http://localhost/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "x",
          topic_info: "y",
          workflow_id: "comfyui",
        }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("workflow_disabled");
  });

  it("pins the visual_style_snapshot when visual_style_id is supplied", async () => {
    const { getDb } = await import("@/lib/db");
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO visual_styles (id, title, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run("vs1", "Cinematic noir", "noir prompt", now, now);

    const { POST } = await import("@/app/api/videos/route");
    const res = await POST(
      new Request("http://localhost/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Styled",
          topic_info: "info",
          workflow_id: "comfyui",
          visual_style_id: "vs1",
        }),
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.video.visual_style_id).toBe("vs1");
    expect(body.video.visual_style_snapshot).not.toBeNull();
    const parsed = JSON.parse(body.video.visual_style_snapshot);
    expect(parsed).toEqual({
      id: "vs1",
      title: "Cinematic noir",
      prompt: "noir prompt",
    });
  });

  it("returns 400 visual_style_not_found when visual_style_id is unknown", async () => {
    const { POST } = await import("@/app/api/videos/route");
    const res = await POST(
      new Request("http://localhost/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "x",
          topic_info: "y",
          workflow_id: "comfyui",
          visual_style_id: "ghost-style",
        }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("visual_style_not_found");
  });

  it("accepts explicit visual_style_id: null and writes NULL columns", async () => {
    const { POST } = await import("@/app/api/videos/route");
    const res = await POST(
      new Request("http://localhost/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Null Style",
          topic_info: "info",
          workflow_id: "comfyui",
          visual_style_id: null,
        }),
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.video.visual_style_id).toBeNull();
    expect(body.video.visual_style_snapshot).toBeNull();
  });
});

describe("POST /api/videos — music_video kind", () => {
  it("creates a music_video row with the five kind-specific fields", async () => {
    const { POST } = await import("@/app/api/videos/route");
    const res = await POST(
      new Request("http://localhost/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "music_video",
          title: "Synthwave Drive",
          workflow_id: "music-video-magnific-suno",
          magnific_image_prompt: "neon city skyline at dusk",
          magnific_motion_prompt: "aggressive push-in, swirling debris",
          suno_style_prompt: "instrumental synthwave",
          song_count: 3,
          repeat_factor: 2,
        }),
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.video).toMatchObject({
      title: "Synthwave Drive",
      workflow_id: "music-video-magnific-suno",
      kind: "music_video",
      magnific_image_prompt: "neon city skyline at dusk",
      magnific_motion_prompt: "aggressive push-in, swirling debris",
      suno_style_prompt: "instrumental synthwave",
      song_count: 3,
      repeat_factor: 2,
      status: "new",
    });
    // topic_info column is NOT NULL — music_video rows write empty string.
    expect(body.video.topic_info).toBe("");
  });

  it("returns 400 when a required music-video field is missing", async () => {
    const { POST } = await import("@/app/api/videos/route");
    const res = await POST(
      new Request("http://localhost/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "music_video",
          title: "Missing fields",
          workflow_id: "music-video-magnific-suno",
          magnific_image_prompt: "x",
          magnific_motion_prompt: "z",
          suno_style_prompt: "y",
          // song_count + repeat_factor omitted
        }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when magnific_motion_prompt is omitted from a music_video payload", async () => {
    const { POST } = await import("@/app/api/videos/route");
    const res = await POST(
      new Request("http://localhost/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "music_video",
          title: "No motion prompt",
          workflow_id: "music-video-magnific-suno",
          magnific_image_prompt: "x",
          suno_style_prompt: "y",
          song_count: 3,
          repeat_factor: 2,
        }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_input");
  });

  it("returns 400 when topic_info is present on a music_video payload", async () => {
    const { POST } = await import("@/app/api/videos/route");
    const res = await POST(
      new Request("http://localhost/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "music_video",
          title: "Forbidden topic_info",
          topic_info: "should be rejected",
          workflow_id: "music-video-magnific-suno",
          magnific_image_prompt: "x",
          suno_style_prompt: "y",
          song_count: 3,
          repeat_factor: 2,
        }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 workflow_kind_mismatch when kind='music_video' but workflow is narrative", async () => {
    const { POST } = await import("@/app/api/videos/route");
    const res = await POST(
      new Request("http://localhost/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "music_video",
          title: "Cross-kind",
          workflow_id: "comfyui",
          magnific_image_prompt: "x",
          magnific_motion_prompt: "z",
          suno_style_prompt: "y",
          song_count: 3,
          repeat_factor: 2,
        }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("workflow_kind_mismatch");
  });

  it("returns 400 workflow_kind_mismatch when kind='narrative' but workflow is music_video", async () => {
    const { POST } = await import("@/app/api/videos/route");
    const res = await POST(
      new Request("http://localhost/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // No `kind` field — backward-compat defaults to narrative.
          title: "Cross-kind",
          topic_info: "info",
          workflow_id: "music-video-magnific-suno",
        }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("workflow_kind_mismatch");
  });

  it("returns 400 when song_count is out of range", async () => {
    const { POST } = await import("@/app/api/videos/route");
    const res = await POST(
      new Request("http://localhost/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "music_video",
          title: "Out of range",
          workflow_id: "music-video-magnific-suno",
          magnific_image_prompt: "x",
          suno_style_prompt: "y",
          song_count: 100,
          repeat_factor: 2,
        }),
      })
    );
    expect(res.status).toBe(400);
  });
});
