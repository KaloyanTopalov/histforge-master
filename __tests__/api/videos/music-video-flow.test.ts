import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let projectsDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-music-video-flow-"));
  projectsDir = join(tempDir, "projects");
  process.env.DATABASE_URL = join(tempDir, "test.db");
  process.env.PROJECTS_DIR = projectsDir;
});

afterAll(async () => {
  const { getDb } = await import("@/lib/db");
  try {
    getDb().close();
  } catch {
    // already closed
  }
  delete process.env.PROJECTS_DIR;
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
  rmSync(projectsDir, { recursive: true, force: true });
});

/**
 * Plan 1 Phase 1.4 Task 9 — integration test for the music-video API
 * surface. Mirrors the narrative-side `ready-script-flow.test.ts`
 * shape: POST /api/videos → row visible via getVideosPageState → POST
 * /api/videos/:id/start → row transitions new → queued.
 *
 * The "worker walks the six stubs → status='done'" portion of the plan
 * milestone is intentionally NOT exercised here. `resolveDeps` in
 * `src/worker/pipeline.ts:270` eagerly calls `getLlmProvider(null)` and
 * `getImageProvider("magnific")` / `getVideoProvider("magnific")`, none
 * of which resolve for a music_video snapshot today (the in-source
 * comment at `pipeline.ts:257-268` documents this as a known gap
 * deferred to Plan 2). Phase 1.3's in-tree gate (bootValidate + stub
 * registration) already covers the worker side; this test covers the
 * Phase 1.4 dashboard API surface.
 */
describe("music-video flow: POST /api/videos → page state → /:id/start", () => {
  it("creates a music_video row, surfaces it via getVideosPageState, and queues it via /start", async () => {
    const { POST: createVideo } = await import("@/app/api/videos/route");
    const createRes = await createVideo(
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
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    const videoId = created.video.id as string;
    expect(typeof videoId).toBe("string");
    expect(videoId.length).toBeGreaterThan(0);
    expect(created.video).toMatchObject({
      kind: "music_video",
      title: "Synthwave Drive",
      workflow_id: "music-video-magnific-suno",
      magnific_image_prompt: "neon city skyline at dusk",
      magnific_motion_prompt: "aggressive push-in, swirling debris",
      suno_style_prompt: "instrumental synthwave",
      song_count: 3,
      repeat_factor: 2,
      status: "new",
      topic_info: "",
      provided_script: null,
      visual_style_id: null,
    });

    // No project dir at create time — artifacts (if any) land at queue time.
    expect(existsSync(join(projectsDir, videoId))).toBe(false);

    // 2. getVideosPageState surfaces the row with kind='music_video' and
    // all four music-video fields preserved — this is what the Music
    // videos tab on /videos reads through.
    const { getVideosPageState } = await import("@/lib/videos-page-state");
    const { getDb } = await import("@/lib/db");
    const pageState = getVideosPageState(getDb());
    expect(pageState.videos).toHaveLength(1);
    expect(pageState.videos[0]).toMatchObject({
      id: videoId,
      kind: "music_video",
      title: "Synthwave Drive",
      magnific_image_prompt: "neon city skyline at dusk",
      magnific_motion_prompt: "aggressive push-in, swirling debris",
      suno_style_prompt: "instrumental synthwave",
      song_count: 3,
      repeat_factor: 2,
      status: "new",
    });

    // 3. POST /api/videos/[id]/start — transitions new → queued.
    const { POST: startVideo } = await import(
      "@/app/api/videos/[id]/start/route"
    );
    const startRes = await startVideo(
      new Request(`http://localhost/api/videos/${videoId}/start`, {
        method: "POST",
      }),
      { params: { id: videoId } }
    );
    expect(startRes.status).toBe(200);

    const queuedRow = getDb()
      .prepare("SELECT status, current_step, started_at FROM videos WHERE id = ?")
      .get(videoId) as {
      status: string;
      current_step: string | null;
      started_at: number | null;
    };
    expect(queuedRow).toEqual({
      status: "queued",
      current_step: null,
      started_at: null,
    });

    // applyReadyScriptArtifacts is a no-op when provided_script is NULL —
    // which it always is for a music_video row (the repo enforces this).
    // The script/full_script.md file should NOT exist.
    expect(
      existsSync(join(projectsDir, videoId, "script", "full_script.md"))
    ).toBe(false);
    // No video_steps rows pre-marked either.
    const stepRows = getDb()
      .prepare("SELECT COUNT(*) AS n FROM video_steps WHERE video_id = ?")
      .get(videoId) as { n: number };
    expect(stepRows.n).toBe(0);

    // 4. Drift check: the generate_loop_clip worker step must read
    // magnific_motion_prompt and enqueue a magnific_queue row whose
    // `prompt` matches the operator's text verbatim — no MOTION_SUFFIX,
    // no derived text. This is the failure mode the API↔worker contract
    // would silently drift on without this assertion. Pre-abort the
    // wait so the call returns after enqueue; we only care about the
    // queued row's `prompt`.
    const { runGenerateLoopClip } = await import(
      "@/worker/steps/generate-loop-clip"
    );
    const controller = new AbortController();
    controller.abort();
    await runGenerateLoopClip(videoId, {
      db: getDb(),
      projectsDir,
      signal: controller.signal,
    });
    const queueRow = getDb()
      .prepare(
        "SELECT prompt FROM magnific_queue WHERE video_id = ? AND mode = 'image-to-video'"
      )
      .get(videoId) as { prompt: string };
    expect(queueRow.prompt).toBe("aggressive push-in, swirling debris");
  });
});
