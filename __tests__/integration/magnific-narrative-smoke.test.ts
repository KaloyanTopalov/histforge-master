/**
 * Server-side smoke for the magnific-narrative image-batch path. Proves
 * S1 (schema/workflow) + S2 (MagnificImageProvider.generateBatch) + S3
 * (next-task projection + submit-result project-id persistence) connect
 * end-to-end with the magnific-ext extension MOCKED — no browser, no
 * Playwright. A `drainAsExtension` helper plays the part of the extension:
 * it polls the real `next-task` route and POSTs the real `submit-result`
 * route, exactly as the Chrome extension will once S4's executor lands.
 *
 * Hermetic: its own temp SQLite + PROJECTS_DIR, same harness as the S3
 * route tests. `fetch` is stubbed so the submit-result download path
 * writes deterministic PNG bytes without touching the network.
 *
 * Gated behind RUN_MAGNIFIC_NARRATIVE=1 (server-side tier — safe, no
 * browser). The live-browser tier is a SEPARATE gate
 * (RUN_MAGNIFIC_NARRATIVE_LIVE=1); do not conflate them.
 *
 * Run with:
 *   RUN_MAGNIFIC_NARRATIVE=1 npm test -- magnific-narrative-smoke
 *   # PowerShell:
 *   $env:RUN_MAGNIFIC_NARRATIVE="1"; npm test -- magnific-narrative-smoke
 */
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
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUN = process.env.RUN_MAGNIFIC_NARRATIVE === "1";

const TOKEN = "T-narrative-smoke";

interface Projection {
  id: string;
  mode: string;
  prompt: string;
  model: string;
  output_path: string;
  video_title?: string;
  magnific_project_id?: string | null;
  [k: string]: unknown;
}

async function seedVideo(
  id: string,
  opts?: { title?: string; magnificProjectId?: string | null }
): Promise<void> {
  const { getDb } = await import("@/lib/db");
  getDb()
    .prepare(
      `INSERT INTO videos (id, title, topic_info, workflow_id, status, kind, magnific_project_id, created_at)
       VALUES (?, ?, ?, ?, 'queued', 'narrative', ?, ?)`
    )
    .run(
      id,
      opts?.title ?? "T",
      "info",
      "narrative-magnific-nano-banana",
      opts?.magnificProjectId ?? null,
      Date.now()
    );
}

function callNextTask(token = TOKEN): Promise<Response> {
  return import("@/app/api/magnific/next-task/[token]/route").then(({ POST }) =>
    POST(
      new Request(`http://localhost/api/magnific/next-task/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      { params: { token } }
    )
  );
}

function callSubmit(body: unknown, token = TOKEN): Promise<Response> {
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

function stubCdnpkFetch(): ReturnType<typeof vi.fn> {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const spy = vi.fn(
    async () =>
      new Response(bytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      })
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

/**
 * Stand-in for the magnific-ext extension: claim each dispatched row via
 * next-task and complete it via submit-result. Reports the freshly-created
 * Project UUID on the FIRST row only (mirroring the real executor, which
 * harvests the UUID from the Project it created and echoes it back so
 * HistForge caches it for subsequent rows). Returns the number of rows
 * drained and the ordered list of projections observed.
 */
async function drainAsExtension(opts: {
  projectId: string;
}): Promise<{ drained: number; projections: Projection[] }> {
  const projections: Projection[] = [];
  let i = 0;
  while (i < 50) {
    const res = await callNextTask();
    const body = (await res.json()) as Projection;
    if (!body || !body.id) break; // empty {} → queue drained
    projections.push(body);
    const submitBody: Record<string, unknown> = {
      external_task_id: body.id,
      status: "done",
      resultUrl: `https://pikaso.cdnpk.net/media/${body.output_path}/${i}/render.png`,
    };
    if (i === 0) submitBody.magnific_project_id = opts.projectId;
    await callSubmit(submitBody);
    i++;
  }
  return { drained: i, projections };
}

describe.skipIf(!RUN)(
  "magnific-narrative server-side smoke (extension mocked) — requires RUN_MAGNIFIC_NARRATIVE=1",
  () => {
    let tempDir: string;
    let projectsDir: string;

    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), "histforge-magnific-narrative-smoke-"));
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

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    beforeEach(async () => {
      const { getDb, seedDefaultSettings } = await import("@/lib/db");
      const db = getDb();
      db.exec(
        "DELETE FROM magnific_queue; DELETE FROM videos; DELETE FROM settings;"
      );
      seedDefaultSettings(db);
      const { setSetting } = await import("@/lib/settings");
      setSetting("magnific_token", TOKEN);
      setSetting("queue_state", "running");
      setSetting("magnific_image_model", "nano-banana-2");
    });

    it("full drain: generateBatch → next-task projection (title+model+project) → submit-result downloads, persists project id, second row reuses it", async () => {
      await seedVideo("v1", { title: "The Fall of Rome" }); // project id starts null
      stubCdnpkFetch();
      const { magnificImageProvider } = await import("@/lib/image/magnific");
      const { getDb } = await import("@/lib/db");
      const db = getDb();
      const targetDir = join(projectsDir, "v1", "images");
      const items = [
        { id: "0001", prompt: "a senator addressing the forum" },
        { id: "0002", prompt: "the city in flames" },
        { id: "0003", prompt: "barbarians at the gate" },
      ];

      // generateBatch enqueues synchronously, then blocks on the queue drain.
      const gen = magnificImageProvider.generateBatch(items, targetDir, {
        db,
        videoId: "v1",
        projectsDir,
        pollIntervalMs: 20,
      });
      const { drained, projections } = await drainAsExtension({
        projectId: "proj-x",
      });
      await gen; // resolves once pending+dispatched === 0

      expect(drained).toBe(3);

      // First row: no cached Project yet → null; carries title + IMAGE model.
      expect(projections[0]).toMatchObject({
        mode: "image-batch",
        video_title: "The Fall of Rome",
        magnific_project_id: null,
        model: "nano-banana-2",
      });
      // Rows 2+ reuse the Project UUID row 1 persisted via submit-result.
      expect(projections[1].magnific_project_id).toBe("proj-x");
      expect(projections[2].magnific_project_id).toBe("proj-x");

      // Each image landed on disk at the resume-check path.
      for (const item of items) {
        expect(existsSync(join(targetDir, `${item.id}.png`))).toBe(true);
      }

      // All rows done; Project UUID cached on the video.
      const rows = db
        .prepare(
          "SELECT status, COUNT(*) AS n FROM magnific_queue WHERE video_id = ? GROUP BY status"
        )
        .all("v1") as Array<{ status: string; n: number }>;
      expect(rows).toEqual([{ status: "done", n: 3 }]);
      const video = db
        .prepare("SELECT magnific_project_id FROM videos WHERE id = ?")
        .get("v1") as { magnific_project_id: string | null };
      expect(video.magnific_project_id).toBe("proj-x");
    });

    it("project_missing failure clears the cached Project id and fails the row", async () => {
      await seedVideo("v3", { title: "Pompeii", magnificProjectId: "stale-x" });
      const { getDb } = await import("@/lib/db");
      const { enqueueTask } = await import("@/lib/repos/magnific");
      const db = getDb();
      enqueueTask(db, {
        video_id: "v3",
        mode: "image-batch",
        prompt: "ash over the streets",
        output_path: "images/0001.png",
        no_timeout: 0,
        created_at: Math.floor(Date.now() / 1000),
      });

      // Projection carries the (soon-to-be-stale) cached id.
      const res = await callNextTask();
      const proj = (await res.json()) as Projection;
      expect(proj.magnific_project_id).toBe("stale-x");
      expect(proj.video_title).toBe("Pompeii");

      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const sres = await callSubmit({
        external_task_id: proj.id,
        status: "failed",
        error: "project_missing",
        magnific_project_id: null,
      });
      expect(await sres.json()).toEqual({ success: true });
      expect(fetchSpy).not.toHaveBeenCalled();

      const video = db
        .prepare("SELECT magnific_project_id FROM videos WHERE id = ?")
        .get("v3") as { magnific_project_id: string | null };
      expect(video.magnific_project_id).toBeNull();
      const row = db
        .prepare(
          "SELECT status, error_reason FROM magnific_queue WHERE video_id = ?"
        )
        .get("v3") as { status: string; error_reason: string | null };
      expect(row.status).toBe("failed");
      expect(row.error_reason).toBe("project_missing");
    });

    it("resume: re-running generateBatch after a drain enqueues no new rows", async () => {
      await seedVideo("v2", { title: "Carthage" });
      stubCdnpkFetch();
      const { magnificImageProvider } = await import("@/lib/image/magnific");
      const { getDb } = await import("@/lib/db");
      const db = getDb();
      const targetDir = join(projectsDir, "v2", "images");
      const items = [
        { id: "0001", prompt: "the harbor at dawn" },
        { id: "0002", prompt: "war elephants" },
      ];

      const gen1 = magnificImageProvider.generateBatch(items, targetDir, {
        db,
        videoId: "v2",
        projectsDir,
        pollIntervalMs: 20,
      });
      await drainAsExtension({ projectId: "proj-y" });
      await gen1;

      const before = db
        .prepare("SELECT COUNT(*) AS n FROM magnific_queue WHERE video_id = ?")
        .get("v2") as { n: number };
      expect(before.n).toBe(2);

      // Re-entry: files on disk + non-failed rows → skip every chunk, enqueue
      // nothing, and the queue is already drained so the wait returns at once.
      await magnificImageProvider.generateBatch(items, targetDir, {
        db,
        videoId: "v2",
        projectsDir,
        pollIntervalMs: 20,
      });

      const after = db
        .prepare("SELECT COUNT(*) AS n FROM magnific_queue WHERE video_id = ?")
        .get("v2") as { n: number };
      expect(after.n).toBe(2); // no new pending rows
    });
  }
);
