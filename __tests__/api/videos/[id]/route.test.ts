import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
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

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-video-id-"));
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
    "DELETE FROM video_steps; DELETE FROM videos; DELETE FROM workflow_steps; DELETE FROM workflows; DELETE FROM visual_styles; DELETE FROM settings;"
  );
  seedDefaultSettings(db);
  seedDefaultWorkflows(db);
});

async function seedVideo(
  videoId: string,
  overrides: Partial<{
    title: string;
    topic_info: string;
    workflow_id: string;
    status: string;
    current_step: string | null;
    failed_step: string | null;
    failed_reason: string | null;
    started_at: number | null;
    finished_at: number | null;
    delete_requested: 0 | 1;
  }> = {}
): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO videos (id, title, topic_info, workflow_id, status, current_step, failed_step, failed_reason, started_at, finished_at, delete_requested, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    videoId,
    overrides.title ?? "T",
    overrides.topic_info ?? "info",
    overrides.workflow_id ?? "comfyui",
    overrides.status ?? "new",
    overrides.current_step ?? null,
    overrides.failed_step ?? null,
    overrides.failed_reason ?? null,
    overrides.started_at ?? null,
    overrides.finished_at ?? null,
    overrides.delete_requested ?? 0,
    now
  );
}

async function seedStepRows(
  videoId: string,
  slugs: readonly string[]
): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const stmt = db.prepare(
    "INSERT INTO video_steps (video_id, step_name, status) VALUES (?, ?, 'pending')"
  );
  for (const slug of slugs) {
    stmt.run(videoId, slug);
  }
}

async function seedMusicVideo(
  videoId: string,
  overrides: Partial<{
    title: string;
    status: string;
    magnific_image_prompt: string;
    suno_style_prompt: string;
    song_count: number;
    repeat_factor: number;
  }> = {}
): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO videos (id, title, topic_info, workflow_id, kind, status,
       magnific_image_prompt, suno_style_prompt, song_count, repeat_factor,
       created_at)
     VALUES (?, ?, ?, ?, 'music_video', ?, ?, ?, ?, ?, ?)`
  ).run(
    videoId,
    overrides.title ?? "MV",
    "",
    "music-video-magnific-suno",
    overrides.status ?? "new",
    overrides.magnific_image_prompt ?? "img prompt",
    overrides.suno_style_prompt ?? "style prompt",
    overrides.song_count ?? 3,
    overrides.repeat_factor ?? 2,
    now
  );
}

describe("GET /api/videos/:id", () => {
  it("returns video + steps + workflow labels", async () => {
    await seedVideo("v1", { status: "in_progress" });
    await seedStepRows("v1", ["research_outline", "write_hook"]);

    const { GET } = await import("@/app/api/videos/[id]/route");
    const res = await GET(new Request("http://localhost/api/videos/v1"), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.video).toMatchObject({ id: "v1", status: "in_progress" });
    expect(Array.isArray(body.steps)).toBe(true);
    expect(typeof body.workflow_label).toBe("string");
    expect(body.workflow_label.length).toBeGreaterThan(0);
  });

  it("returns 404 when the video does not exist", async () => {
    const { GET } = await import("@/app/api/videos/[id]/route");
    const res = await GET(new Request("http://localhost/api/videos/nope"), {
      params: { id: "nope" },
    });
    expect(res.status).toBe(404);
  });

  it("returns queueState from the queue_state setting", async () => {
    await seedVideo("v1", { status: "in_progress" });
    const { setSetting } = await import("@/lib/settings");
    setSetting("queue_state", "paused");

    const { GET } = await import("@/app/api/videos/[id]/route");
    const res = await GET(new Request("http://localhost/api/videos/v1"), {
      params: { id: "v1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queueState).toBe("paused");
  });

  it("returns queueState='running' by default", async () => {
    await seedVideo("v1", { status: "queued" });
    const { GET } = await import("@/app/api/videos/[id]/route");
    const res = await GET(new Request("http://localhost/api/videos/v1"), {
      params: { id: "v1" },
    });
    const body = await res.json();
    expect(body.queueState).toBe("running");
  });

  it("returns artifacts from the project directory", async () => {
    await seedVideo("v2", { status: "queued" });

    const projectDir = join(tempDir, "projects", "v2", "script");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "01_outline.md"), "outline");
    writeFileSync(join(tempDir, "projects", "v2", "pipeline.log"), "log");

    process.env.PROJECTS_DIR = join(tempDir, "projects");

    const { GET } = await import("@/app/api/videos/[id]/route");
    const res = await GET(new Request("http://localhost/api/videos/v2"), {
      params: { id: "v2" },
    });
    const body = await res.json();

    expect(body.artifacts).toContain("script/01_outline.md");
    expect(body.artifacts).toContain("pipeline.log");
  });
});

describe("PATCH /api/videos/:id", () => {
  it("updates a draft video when status=new", async () => {
    await seedVideo("v1", { status: "new", title: "Old" });
    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/v1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "New",
          topic_info: "info2",
          workflow_id: "google-flow",
        }),
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);
    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT * FROM videos WHERE id = ?")
      .get("v1") as {
      title: string;
      topic_info: string;
      workflow_id: string;
    };
    expect(row.title).toBe("New");
    expect(row.topic_info).toBe("info2");
    expect(row.workflow_id).toBe("google-flow");
  });

  it("updates a queued video (not yet started generating)", async () => {
    await seedVideo("v1", { status: "queued", title: "Old" });
    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/v1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New" }),
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);
  });

  it("returns 409 when status is in_progress", async () => {
    await seedVideo("v1", { status: "in_progress" });
    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/v1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(409);
  });

  it("returns 400 workflow_not_found when workflow_id is unknown", async () => {
    await seedVideo("v1", { status: "new" });
    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/v1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow_id: "missing" }),
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("workflow_not_found");
  });

  it("returns 400 workflow_disabled when target workflow_id has enabled=0", async () => {
    await seedVideo("v1", { status: "new" });
    const { getDb } = await import("@/lib/db");
    getDb()
      .prepare("UPDATE workflows SET enabled = 0 WHERE id = ?")
      .run("google-flow");

    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/v1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow_id: "google-flow" }),
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("workflow_disabled");
  });

  it("returns 404 for unknown id", async () => {
    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/nope", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      }),
      { params: { id: "nope" } }
    );
    expect(res.status).toBe(404);
  });

  it("accepts and persists provided_script on a new video", async () => {
    await seedVideo("v1", { status: "new" });
    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/v1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provided_script: "# Custom script\n\nHello." }),
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);
    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT provided_script FROM videos WHERE id = ?")
      .get("v1") as { provided_script: string | null };
    expect(row.provided_script).toBe("# Custom script\n\nHello.");
  });

  it("does NOT write script artifacts when patching provided_script on a new video", async () => {
    await seedVideo("v1", { status: "new" });
    const projectsDir = join(tempDir, "projects-patch-new");
    process.env.PROJECTS_DIR = projectsDir;

    const { PATCH } = await import("@/app/api/videos/[id]/route");
    await PATCH(
      new Request("http://localhost/api/videos/v1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provided_script: "Hello." }),
      }),
      { params: { id: "v1" } }
    );

    expect(existsSync(join(projectsDir, "v1", "script", "full_script.md"))).toBe(
      false
    );
  });

  it("writes script/full_script.md when patching provided_script on a queued video", async () => {
    await seedVideo("v1", { status: "queued" });
    // Queued rows must have a workflow_snapshot for applyReadyScriptArtifacts.
    const { getDb } = await import("@/lib/db");
    const { computeSnapshot } = await import("@/lib/workflows");
    const db = getDb();
    db.prepare("UPDATE videos SET workflow_snapshot = ? WHERE id = ?").run(
      computeSnapshot(db, "comfyui"),
      "v1"
    );

    const projectsDir = join(tempDir, "projects-patch-queued");
    process.env.PROJECTS_DIR = projectsDir;

    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/v1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provided_script: "Hello em—dash." }),
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);

    const scriptPath = join(projectsDir, "v1", "script", "full_script.md");
    expect(existsSync(scriptPath)).toBe(true);
    const written = (await import("node:fs")).readFileSync(scriptPath, "utf8");
    // sanitizeScript replaces em-dashes.
    expect(written).not.toContain("—");
    expect(written).toContain("Hello em");
  });

  it("does NOT call applyReadyScriptArtifacts when patch omits provided_script (queued)", async () => {
    await seedVideo("v1", { status: "queued" });
    const projectsDir = join(tempDir, "projects-patch-queued-no-script");
    process.env.PROJECTS_DIR = projectsDir;

    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/v1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Renamed" }),
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);
    expect(existsSync(join(projectsDir, "v1", "script", "full_script.md"))).toBe(
      false
    );
  });

  it("updates visual_style_id and re-pins the snapshot on a draft video", async () => {
    await seedVideo("v1", { status: "new" });
    const { getDb } = await import("@/lib/db");
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO visual_styles (id, title, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run("vs1", "Cinematic noir", "noir prompt", now, now);

    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/v1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visual_style_id: "vs1" }),
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);

    const row = getDb()
      .prepare(
        "SELECT visual_style_id, visual_style_snapshot FROM videos WHERE id = ?"
      )
      .get("v1") as {
      visual_style_id: string | null;
      visual_style_snapshot: string | null;
    };
    expect(row.visual_style_id).toBe("vs1");
    const parsed = JSON.parse(row.visual_style_snapshot!);
    expect(parsed.title).toBe("Cinematic noir");
  });

  it("returns 400 visual_style_not_found when visual_style_id is unknown", async () => {
    await seedVideo("v1", { status: "new" });
    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/v1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visual_style_id: "ghost-style" }),
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("visual_style_not_found");
  });

  it("accepts visual_style_id: null and clears the FK + snapshot", async () => {
    await seedVideo("v1", { status: "new" });
    const { getDb } = await import("@/lib/db");
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO visual_styles (id, title, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run("vs1", "S", "p", now, now);
    getDb()
      .prepare(
        "UPDATE videos SET visual_style_id = ?, visual_style_snapshot = ? WHERE id = ?"
      )
      .run("vs1", JSON.stringify({ id: "vs1", title: "S", prompt: "p" }), "v1");

    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/v1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visual_style_id: null }),
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);

    const row = getDb()
      .prepare(
        "SELECT visual_style_id, visual_style_snapshot FROM videos WHERE id = ?"
      )
      .get("v1") as {
      visual_style_id: string | null;
      visual_style_snapshot: string | null;
    };
    expect(row.visual_style_id).toBeNull();
    expect(row.visual_style_snapshot).toBeNull();
  });

  it("treats visual_style_id alone as a valid (non-empty) patch", async () => {
    // The "at least one field" refine on PatchVideoSchema must include
    // visual_style_id — otherwise this body would 400 with
    // "invalid_input" / "at least one field required".
    await seedVideo("v1", { status: "new" });
    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/v1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visual_style_id: null }),
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/videos/:id — music_video kind", () => {
  it("updates the music-video tuple on a music_video draft", async () => {
    await seedMusicVideo("mv1", { status: "new" });
    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/mv1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Edited",
          magnific_image_prompt: "new image prompt",
          suno_style_prompt: "new style",
          song_count: 5,
          repeat_factor: 4,
        }),
      }),
      { params: { id: "mv1" } }
    );
    expect(res.status).toBe(200);
    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT title, magnific_image_prompt, suno_style_prompt, song_count, repeat_factor FROM videos WHERE id = ?"
      )
      .get("mv1") as {
      title: string;
      magnific_image_prompt: string;
      suno_style_prompt: string;
      song_count: number;
      repeat_factor: number;
    };
    expect(row).toEqual({
      title: "Edited",
      magnific_image_prompt: "new image prompt",
      suno_style_prompt: "new style",
      song_count: 5,
      repeat_factor: 4,
    });
  });

  it("rejects narrative-only fields (topic_info) on a music_video row", async () => {
    await seedMusicVideo("mv1", { status: "new" });
    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/mv1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic_info: "should be rejected" }),
      }),
      { params: { id: "mv1" } }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("kind_field_mismatch");
  });

  it("rejects narrative-only fields (provided_script) on a music_video row", async () => {
    await seedMusicVideo("mv1", { status: "new" });
    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/mv1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provided_script: "nope" }),
      }),
      { params: { id: "mv1" } }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("kind_field_mismatch");
  });

  it("rejects music-video fields on a narrative row", async () => {
    await seedVideo("v1", { status: "new" });
    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/v1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ magnific_image_prompt: "should be rejected" }),
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("kind_field_mismatch");
  });

  it("rejects a kind field that differs from the row's stored kind", async () => {
    await seedMusicVideo("mv1", { status: "new" });
    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/mv1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "narrative", title: "x" }),
      }),
      { params: { id: "mv1" } }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("kind_immutable");
  });

  it("allows a kind field that matches the row's stored kind (no-op)", async () => {
    await seedMusicVideo("mv1", { status: "new" });
    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/mv1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "music_video", title: "Same kind" }),
      }),
      { params: { id: "mv1" } }
    );
    expect(res.status).toBe(200);
    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT kind, title FROM videos WHERE id = ?")
      .get("mv1") as { kind: string; title: string };
    expect(row.kind).toBe("music_video");
    expect(row.title).toBe("Same kind");
  });

  it("rejects workflow_id targeting a workflow of a different kind", async () => {
    await seedMusicVideo("mv1", { status: "new" });
    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/mv1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow_id: "comfyui" }),
      }),
      { params: { id: "mv1" } }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("workflow_kind_mismatch");
  });

  it("rejects out-of-range song_count", async () => {
    await seedMusicVideo("mv1", { status: "new" });
    const { PATCH } = await import("@/app/api/videos/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/videos/mv1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ song_count: 100 }),
      }),
      { params: { id: "mv1" } }
    );
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/videos/:id", () => {
  it("deletes a new video row only (no files expected)", async () => {
    await seedVideo("v1", { status: "new" });
    const projectsDir = join(tempDir, "projects-del-new");
    process.env.PROJECTS_DIR = projectsDir;

    const { DELETE } = await import("@/app/api/videos/[id]/route");
    const res = await DELETE(
      new Request("http://localhost/api/videos/v1", { method: "DELETE" }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT id FROM videos WHERE id = ?")
      .get("v1");
    expect(row).toBeUndefined();
  });

  it("deletes files + rows for status=queued", async () => {
    await seedVideo("v1", { status: "queued" });
    await seedStepRows("v1", ["research_outline"]);

    const projectsDir = join(tempDir, "projects-del-queued");
    mkdirSync(join(projectsDir, "v1"), { recursive: true });
    writeFileSync(join(projectsDir, "v1", "artifact.txt"), "x");
    process.env.PROJECTS_DIR = projectsDir;

    const { DELETE } = await import("@/app/api/videos/[id]/route");
    const res = await DELETE(
      new Request("http://localhost/api/videos/v1", { method: "DELETE" }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT id FROM videos WHERE id = ?")
      .get("v1");
    expect(row).toBeUndefined();
    const stepRow = getDb()
      .prepare("SELECT 1 FROM video_steps WHERE video_id = ?")
      .get("v1");
    expect(stepRow).toBeUndefined();
    expect(existsSync(join(projectsDir, "v1"))).toBe(false);
  });

  it("deletes files + rows for status=failed", async () => {
    await seedVideo("v1", { status: "failed", failed_step: "voiceover" });
    const projectsDir = join(tempDir, "projects-del-failed");
    mkdirSync(join(projectsDir, "v1"), { recursive: true });
    writeFileSync(join(projectsDir, "v1", "artifact.txt"), "x");
    process.env.PROJECTS_DIR = projectsDir;

    const { DELETE } = await import("@/app/api/videos/[id]/route");
    const res = await DELETE(
      new Request("http://localhost/api/videos/v1", { method: "DELETE" }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT id FROM videos WHERE id = ?")
      .get("v1");
    expect(row).toBeUndefined();
    expect(existsSync(join(projectsDir, "v1"))).toBe(false);
  });

  it("returns 202 and sets delete_requested=1 for in_progress", async () => {
    await seedVideo("v1", { status: "in_progress" });
    const { DELETE } = await import("@/app/api/videos/[id]/route");
    const res = await DELETE(
      new Request("http://localhost/api/videos/v1", { method: "DELETE" }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(202);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT status, delete_requested FROM videos WHERE id = ?"
      )
      .get("v1") as { status: string; delete_requested: number };
    expect(row.status).toBe("in_progress");
    expect(row.delete_requested).toBe(1);
  });

  it("deletes files + rows for status=done", async () => {
    await seedVideo("v1", {
      status: "done",
      finished_at: Date.now(),
    });
    await seedStepRows("v1", ["research_outline"]);

    const projectsDir = join(tempDir, "projects-del-done");
    mkdirSync(join(projectsDir, "v1"), { recursive: true });
    writeFileSync(join(projectsDir, "v1", "final.mp4"), "x");
    process.env.PROJECTS_DIR = projectsDir;

    const { DELETE } = await import("@/app/api/videos/[id]/route");
    const res = await DELETE(
      new Request("http://localhost/api/videos/v1", { method: "DELETE" }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT id FROM videos WHERE id = ?")
      .get("v1");
    expect(row).toBeUndefined();
    const stepRow = getDb()
      .prepare("SELECT 1 FROM video_steps WHERE video_id = ?")
      .get("v1");
    expect(stepRow).toBeUndefined();
    expect(existsSync(join(projectsDir, "v1"))).toBe(false);
  });

  it("returns 404 for unknown id", async () => {
    const { DELETE } = await import("@/app/api/videos/[id]/route");
    const res = await DELETE(
      new Request("http://localhost/api/videos/nope", { method: "DELETE" }),
      { params: { id: "nope" } }
    );
    expect(res.status).toBe(404);
  });
});
