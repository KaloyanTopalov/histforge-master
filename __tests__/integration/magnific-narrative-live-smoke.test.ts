/**
 * LIVE-BROWSER smoke for the magnific-narrative image-batch path. Drives the
 * REAL magnific-ext extension through the REAL Magnific UI via the runtime:
 * creates a fresh throwaway Project, generates 2-3 images with Nano Banana 2,
 * harvests them, and confirms they land in that Project. This is the one
 * command the operator runs manually after S4; it surfaces selector drift
 * (especially the fragile create-Project selectors) before a real video does.
 *
 * Standalone + hermetic: the smoke serves next-task/submit-result itself on an
 * in-process HTTP server against a throwaway temp DB + temp projects dir
 * (nothing touches data/histforge.db or the real projects dir), and owns the
 * runtime so it can navigate the logged-in context for the containment check.
 *
 * Two-tier gate — do NOT conflate with the server-side smoke:
 *   RUN_MAGNIFIC_NARRATIVE      → server-side smoke (no browser, safe, CI-able)
 *   RUN_MAGNIFIC_NARRATIVE_LIVE → THIS (real Chromium + real Magnific session)
 *
 * Prerequisites (the smoke checks these and SKIPS with a readable message if
 * unmet — it never cryptically fails):
 *   - The dev server is stopped (port 3000 free) so the smoke can bind it.
 *   - The runtime is enabled and the Magnific session is valid (operator ran
 *     "enable runtime + Connect Magnific" at least once — persisted in the
 *     user_data_dir the smoke reuses).
 *   - magnific_image_model is the Nano Banana 2 slug.
 *   - The extension's persisted host-permission grant covers the base origin
 *     (default http://localhost:3000; override via MAGNIFIC_SMOKE_BASE_URL).
 *
 * Run with (worker/dev-server stopped first):
 *   RUN_MAGNIFIC_NARRATIVE_LIVE=1 npm test -- magnific-narrative-live
 *   # PowerShell:
 *   $env:RUN_MAGNIFIC_NARRATIVE_LIVE="1"; npm test -- magnific-narrative-live
 */
import "dotenv/config";

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  type TestContext,
} from "vitest";
import http from "node:http";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { join } from "node:path";
import type { BrowserContext } from "playwright";

const RUN = process.env.RUN_MAGNIFIC_NARRATIVE_LIVE === "1";

const BASE_URL = process.env.MAGNIFIC_SMOKE_BASE_URL ?? "http://localhost:3000";
const NB2_MODEL_SLUG = "ai-model-item-slim-imagen-nano-banana-2-flash";
const TOKEN = `live-smoke-${Date.now()}`;
const VIDEO_ID = `live_smoke_${Date.now()}`;
const PROJECT_NAME = `PROBE_NARRATIVE_${Date.now()}`;
// Default 10min; override with MAGNIFIC_LIVE_DRAIN_MIN for a fast diagnostic run.
const DRAIN_TIMEOUT_MS = (Number(process.env.MAGNIFIC_LIVE_DRAIN_MIN) || 10) * 60 * 1000;
const MAGNIFIC_PROJECTS_URL = "https://www.magnific.com/app/projects";
const IMAGE_PROMPTS = [
  "a wide cinematic shot of a Roman senator addressing the forum, golden hour",
  "the city of Rome ablaze at night, dramatic smoke and embers",
  "barbarian cavalry massing at a stone gate at dawn, mist",
];

// ── Settings read from the operator's REAL DB before we switch to temp ──────
interface RealConfig {
  userDataDir: string;
  extensionPath: string;
  windowVisible: string;
  imageModel: string;
  runtimeEnabled: boolean;
  sessionValid: boolean;
}

function readRealConfig(): RealConfig | { error: string } {
  const realPath = process.env.DATABASE_URL ?? "data/histforge.db";
  if (!existsSync(realPath)) {
    return { error: `real DB not found at ${realPath} — run db:init / start HistForge once` };
  }
  const db = new Database(realPath, { readonly: true, fileMustExist: true });
  try {
    const get = (k: string): string => {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(k) as
        | { value: string }
        | undefined;
      return row?.value ?? "";
    };
    return {
      userDataDir: get("magnific_runtime_user_data_dir"),
      extensionPath: get("magnific_runtime_extension_path") || "extensions/magnific-ext",
      windowVisible: get("magnific_runtime_window_visible"),
      imageModel: get("magnific_image_model"),
      runtimeEnabled: get("magnific_runtime_enabled") === "true" || get("magnific_runtime_enabled") === "1",
      sessionValid: !(get("magnific_relogin_needed") === "true" || get("magnific_relogin_needed") === "1"),
    };
  } finally {
    db.close();
  }
}

function countChromeProcesses(): number {
  try {
    if (process.platform === "win32") {
      const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV /NH', {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (/^INFO:/i.test(out.trim())) return 0;
      return out.trim().split(/\r?\n/).filter((l) => l.length > 0).length;
    }
    const out = execSync("pgrep -c chrome || true", { encoding: "utf-8" });
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

// Runtime skip helper. vitest 2.1.9's TestContext type doesn't expose skip(),
// so reach it through a cast; if the runtime lacks it the caller's console.warn
// has already printed the readable reason and the test returns green.
function doSkip(ctx: TestContext): void {
  const fn = (ctx as unknown as { skip?: (note?: string) => void }).skip;
  if (typeof fn === "function") fn.call(ctx);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

interface RouteServer {
  close: () => Promise<void>;
}

// Minimal node-http → App-Router-handler adapter. Mounts next-task and
// submit-result (the only routes the image-batch extension flow hits);
// everything else returns a 200 no-op (status events are fire-and-forget).
// Failures are LOUD — a throwing handler or a bind error surfaces, never a
// silent hang from the extension's POV.
async function startRouteServer(): Promise<RouteServer> {
  const { POST: nextTaskPOST } = await import(
    "@/app/api/magnific/next-task/[token]/route"
  );
  const { POST: submitPOST } = await import(
    "@/app/api/magnific/submit-result/[token]/route"
  );
  const u = new URL(BASE_URL);

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", BASE_URL);
        const m = url.pathname.match(
          /^\/api\/magnific\/(next-task|submit-result)\/([^/]+)$/,
        );
        if (!m) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ success: true }));
          return;
        }
        const [, routeName, token] = m;
        const bodyStr = await readBody(req);
        const webReq = new Request(url.toString(), {
          method: "POST",
          headers: {
            "content-type": req.headers["content-type"] ?? "application/json",
          },
          body: bodyStr,
        });
        const handler = routeName === "next-task" ? nextTaskPOST : submitPOST;
        const nr = await handler(webReq, { params: { token } });
        const text = await nr.text();
        const headers: Record<string, string> = {};
        nr.headers.forEach((v, k) => {
          headers[k] = v;
        });
        res.writeHead(nr.status, headers);
        res.end(text);
      } catch (err) {
        // LOUD: surface the real handler error rather than hanging the poll.
        console.error("[live-smoke] route handler threw:", err);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    })();
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(Number(u.port) || 3000, u.hostname, () => resolvePromise());
  });
  return {
    close: () =>
      new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

// From a page on the extension's own origin: confirm the host-permission grant
// covers BASE_URL, and if so wire the webhook URLs + start polling. Returns
// whether the grant is present (false → the operator must grant it in the popup).
async function configureExtension(
  ctx: BrowserContext,
): Promise<{ granted: boolean }> {
  const { resolveExtensionId } = await import(
    "@/lib/magnific-runtime/extension-token"
  );
  const id = await resolveExtensionId(ctx);
  const page = await ctx.newPage();
  try {
    await page.goto(`chrome-extension://${id}/blank.html`);
    return await page.evaluate(
      async (args: { base: string; token: string; originPattern: string }) => {
        const c = (
          globalThis as unknown as {
            chrome: {
              permissions: {
                contains: (p: { origins: string[] }) => Promise<boolean>;
              };
              runtime: {
                sendMessage: (m: unknown, cb: () => void) => void;
              };
            };
          }
        ).chrome;
        const granted = await c.permissions.contains({
          origins: [args.originPattern],
        });
        if (granted) {
          await new Promise<void>((res) =>
            c.runtime.sendMessage(
              {
                action: "updateWebhooks",
                nextTaskUrl: `${args.base}/api/magnific/next-task/${args.token}`,
                submitResultUrl: `${args.base}/api/magnific/submit-result/${args.token}`,
                statusUrl: `${args.base}/api/magnific/status/${args.token}`,
                queueSummaryUrl: `${args.base}/api/magnific/queue-summary`,
                magnificToken: args.token,
              },
              () => res(),
            ),
          );
          await new Promise<void>((res) =>
            c.runtime.sendMessage({ action: "startPolling" }, () => res()),
          );
        }
        return { granted };
      },
      { base: BASE_URL, token: TOKEN, originPattern: `${new URL(BASE_URL).origin}/*` },
    );
  } finally {
    await page.close();
  }
}

let tempDir = "";
let projectsDir = "";
let server: RouteServer | null = null;
let runtimeStarted = false;
let createdProjectUuid: string | null = null;
// Captured magnific-ext content-script console (the [magnific-ext ...] step=
// lines). Surfaced in the test output so a stall is diagnosable here, not only
// in the live browser window.
const extLogs: string[] = [];

describe.skipIf(!RUN)(
  "magnific-narrative LIVE smoke (real Chromium + Magnific) — requires RUN_MAGNIFIC_NARRATIVE_LIVE=1",
  () => {
    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), "histforge-magnific-live-"));
      projectsDir = join(tempDir, "projects");
    });

    afterAll(async () => {
      // Teardown runs regardless of pass/fail. Each step is guarded + best-effort.
      if (runtimeStarted) {
        try {
          const { magnificRuntime } = await import("@/lib/magnific-runtime");
          await magnificRuntime.stop();
        } catch (e) {
          console.error("[live-smoke] runtime.stop() failed:", e);
        }
      }
      if (server) {
        try {
          await server.close();
        } catch (e) {
          console.error("[live-smoke] route server close failed:", e);
        }
      }
      try {
        const { getDb } = await import("@/lib/db");
        getDb().close();
      } catch {
        /* already closed / never opened */
      }
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      if (extLogs.length > 0) {
        console.warn(
          `[live-smoke] captured ${extLogs.length} content-script log line(s); last reached step:\n` +
            extLogs.slice(-15).join("\n"),
        );
      }
      if (createdProjectUuid) {
        console.warn(
          `[live-smoke] If cleanup did not delete it, remove the throwaway ` +
            `Magnific Project manually: ${MAGNIFIC_PROJECTS_URL}/${createdProjectUuid} (${PROJECT_NAME})`,
        );
      }
    });

    it(
      "creates a fresh Project, generates 2-3 Nano Banana 2 images, and confirms they land inside it",
      async (ctx: TestContext) => {
        // ── Phase 0: prerequisites (read the REAL DB, then skip clearly) ──────
        const real = readRealConfig();
        if ("error" in real) {
          console.warn(`[live-smoke] SKIP: ${real.error}`);
          return doSkip(ctx);
        }
        if (!real.runtimeEnabled || !real.sessionValid) {
          console.warn(
            "[live-smoke] SKIP: runtime not enabled or Magnific session invalid — " +
              "enable the runtime + Connect Magnific in Settings first.",
          );
          return doSkip(ctx);
        }
        if (real.imageModel !== NB2_MODEL_SLUG) {
          console.warn(
            `[live-smoke] SKIP: magnific_image_model is "${real.imageModel}", expected the Nano Banana 2 slug "${NB2_MODEL_SLUG}".`,
          );
          return doSkip(ctx);
        }
        if (!real.userDataDir) {
          console.warn("[live-smoke] SKIP: magnific_runtime_user_data_dir is unset.");
          return doSkip(ctx);
        }

        // ── Phase 1: hermetic temp DB + in-process route server ───────────────
        process.env.DATABASE_URL = join(tempDir, "test.db");
        process.env.PROJECTS_DIR = projectsDir;
        const { getDb, seedDefaultSettings } = await import("@/lib/db");
        const db = getDb();
        seedDefaultSettings(db);
        // Seed via raw string upserts (exactly how the settings table stores
        // values; getSetting coerces on read). Copies the operator's runtime
        // config into the temp DB so the runtime launches the real (logged-in)
        // profile + the real extension, and pins our own token/model/queue.
        const put = db.prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        );
        put.run("magnific_runtime_user_data_dir", real.userDataDir);
        put.run("magnific_runtime_extension_path", real.extensionPath);
        put.run("magnific_runtime_window_visible", real.windowVisible || "false");
        put.run("magnific_runtime_enabled", "true");
        put.run("magnific_relogin_needed", "false");
        put.run("magnific_image_model", NB2_MODEL_SLUG);
        put.run("magnific_token", TOKEN);
        put.run("queue_state", "running");
        db.prepare(
          `INSERT INTO videos (id, title, topic_info, workflow_id, status, kind, magnific_project_id, created_at)
           VALUES (?, ?, ?, ?, 'in_progress', 'narrative', NULL, ?)`,
        ).run(VIDEO_ID, PROJECT_NAME, "live smoke", "narrative-magnific-nano-banana", Date.now());

        try {
          server = await startRouteServer();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/EADDRINUSE/i.test(msg)) {
            console.warn(
              `[live-smoke] SKIP: ${new URL(BASE_URL).host} is occupied — stop the dev server so the smoke can bind it.`,
            );
            return doSkip(ctx);
          }
          throw err;
        }

        // ── Phase 2: start the runtime, verify the host grant, wire webhooks ──
        const chromeBefore = countChromeProcesses();
        const { magnificRuntime } = await import("@/lib/magnific-runtime");
        await magnificRuntime.start();
        runtimeStarted = true;
        const browserCtx = (
          magnificRuntime as unknown as { context: BrowserContext | null }
        ).context;
        if (!browserCtx) throw new Error("runtime.start() resolved but context is null");

        // Capture page AND service-worker console (Playwright 1.34+ routes both
        // through the context 'console' event), so the SW-side runner/executor
        // logs ("[image-batch] …", "✗ Executor for <id> failed: …", "Received
        // task …") AND the content-script step= lines all reach the test output.
        // Broad keyword filter; we dump the tail on failure.
        browserCtx.on("console", (m) => {
          const t = m.text();
          if (/magnific|image-batch|executor|content script|received task|poll/i.test(t)) {
            extLogs.push(t);
          }
        });

        // ALWAYS reload the unpacked extension once at smoke start. A persistent
        // profile serves the extension code from when it was last loaded, so
        // disk edits since the previous run are otherwise invisible — and a
        // content-script change (e.g. content-image-batch.js) needs an extension
        // reload, NOT just a page navigation, to take effect. One unconditional
        // reload guarantees the run exercises the current disk state (SW + every
        // content script), closing the stale-cache class for good.
        let sw =
          browserCtx.serviceWorkers()[0] ??
          (await browserCtx.waitForEvent("serviceworker", { timeout: 15000 }));
        const introspectWiring = () =>
          sw.evaluate(() => {
            const g = globalThis as unknown as Record<string, unknown>;
            return {
              executeTaskViaExtension: typeof g["executeTaskViaExtension"],
              runImageBatch: typeof g["runImageBatch"],
              runImageHitl: typeof g["runImageHitl"],
              waitForContentScriptReady: typeof g["waitForContentScriptReady"],
            };
          });
        console.error(
          "[live-smoke] reloading unpacked extension to pick up the latest disk state (SW + content scripts)",
        );
        const swAfter = browserCtx.waitForEvent("serviceworker", { timeout: 20000 });
        await sw
          .evaluate(() => {
            (
              globalThis as unknown as { chrome: { runtime: { reload: () => void } } }
            ).chrome.runtime.reload();
          })
          .catch(() => {
            /* the SW tears itself down mid-eval — expected */
          });
        sw = await swAfter;
        await new Promise((r) => setTimeout(r, 2500));
        const wiring = await introspectWiring();
        console.error("[live-smoke] SW wiring after reload:", JSON.stringify(wiring));
        if (wiring.runImageBatch !== "function") {
          throw new Error(
            `live-smoke: extension SW STALE after chrome.runtime.reload() — runImageBatch=${wiring.runImageBatch}. ` +
              "The persistent profile is serving cached extension code; reload magnific-ext manually or clear the " +
              "runtime user_data_dir's extension state, then re-run.",
          );
        }

        const { granted } = await configureExtension(browserCtx);
        if (!granted) {
          console.warn(
            `[live-smoke] SKIP: the extension has no host-permission grant for ${new URL(BASE_URL).origin}. ` +
              `Open the magnific-ext popup and grant it (point the webhooks at ${BASE_URL}), then re-run.`,
          );
          return doSkip(ctx);
        }

        // ── Phase 3: enqueue 2-3 real image-batch tasks; the extension drains ─
        const magnificRepo = await import("@/lib/repos/magnific");
        const nowSec = Math.floor(Date.now() / 1000);
        IMAGE_PROMPTS.forEach((prompt, i) => {
          magnificRepo.enqueueTask(db, {
            video_id: VIDEO_ID,
            mode: "image-batch",
            prompt,
            output_path: `images/${String(i + 1).padStart(4, "0")}.png`,
            no_timeout: 0,
            created_at: nowSec,
          });
        });

        const drainStart = Date.now();
        let counts = magnificRepo.countByStatusForVideo(db, VIDEO_ID, "image-batch");
        while (
          counts.pending + counts.dispatched > 0 &&
          Date.now() - drainStart < DRAIN_TIMEOUT_MS
        ) {
          await new Promise((r) => setTimeout(r, 3000));
          counts = magnificRepo.countByStatusForVideo(db, VIDEO_ID, "image-batch");
        }
        if (counts.pending + counts.dispatched > 0) {
          console.error(
            "[live-smoke] open tabs:",
            JSON.stringify(browserCtx.pages().map((p) => p.url())),
          );
          console.error(
            "[live-smoke] extension content-script logs (last 80 lines):\n" +
              (extLogs.slice(-80).join("\n") ||
                "(NONE captured — the content script never logged, so it likely never ran: " +
                  "suspect the SW handshake/dispatch, not a content-script step)"),
          );
          throw new Error(
            `live-smoke: queue did not drain within ${DRAIN_TIMEOUT_MS / 60000}min — ` +
              `pending=${counts.pending} dispatched=${counts.dispatched} done=${counts.done} failed=${counts.failed}`,
          );
        }

        // ── Phase 4: LOAD-BEARING assertions ──────────────────────────────────
        // (a) every row succeeded (surface error_reason on failure)
        const rows = db
          .prepare(
            "SELECT status, result_url, error_reason FROM magnific_queue WHERE video_id = ? ORDER BY id",
          )
          .all(VIDEO_ID) as Array<{
          status: string;
          result_url: string | null;
          error_reason: string | null;
        }>;
        const failed = rows.filter((r) => r.status !== "done");
        expect(
          failed.length,
          `failed rows: ${JSON.stringify(failed)}`,
        ).toBe(0);

        // (b) the Project was created (UUID cached on the video)
        const video = db
          .prepare("SELECT magnific_project_id FROM videos WHERE id = ?")
          .get(VIDEO_ID) as { magnific_project_id: string | null };
        expect(video.magnific_project_id, "no Project UUID was cached").toBeTruthy();
        createdProjectUuid = video.magnific_project_id;

        // (c) the images actually landed on disk
        for (let i = 0; i < IMAGE_PROMPTS.length; i++) {
          const p = join(projectsDir, VIDEO_ID, "images", `${String(i + 1).padStart(4, "0")}.png`);
          expect(existsSync(p), `missing image on disk: ${p}`).toBe(true);
        }

        // (d) harvested URLs are pikaso.cdnpk.net/.../<numericId>/render.png with
        //     DISTINCT numeric ids (proves the numeric-id harvest diff worked —
        //     not the same render.png grabbed N times)
        const numericIds = rows.map((r) => {
          const mm = String(r.result_url).match(/\/(\d+)\/render\.png(?:[?#]|$)/i);
          expect(
            mm,
            `result_url is not a pikaso .../<id>/render.png URL: ${r.result_url}`,
          ).not.toBeNull();
          return mm![1];
        });
        expect(
          new Set(numericIds).size,
          `numeric render ids were not distinct: ${numericIds.join(", ")}`,
        ).toBe(numericIds.length);

        // (e) containment: navigate into the created Project and confirm the
        //     generated images landed inside it. The v3 asset tile is
        //     [data-cy="feed-virtual-item"] (NOT feed-image-item, which doesn't
        //     exist in v3 — confirmed by a live [data-cy] probe). It's a
        //     VIRTUAL-LIST element (cf. feed-virtual-item-header), so its count
        //     is not a verified 1:1 with images — we use it only as a "feed view
        //     rendered" presence check and gate the QUANTITY on the cdnpk image
        //     count (the directly-verified signal). Asserting both means a
        //     feed-virtual-item rename can't silently pass (its presence check
        //     fails) and missing images can't pass (the cdnpk count fails). Wait
        //     for either to render so we count the feed, not a transient
        //     tools/loading panel.
        const page = await browserCtx.newPage();
        try {
          await page.goto(`${MAGNIFIC_PROJECTS_URL}/${createdProjectUuid}`, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
          try {
            await page.waitForSelector(
              '[data-cy="feed-virtual-item"], img[src*="cdnpk.net"]',
              { timeout: 20_000 },
            );
          } catch {
            const seen = await page.evaluate(() =>
              Array.from(
                new Set(
                  Array.from(document.querySelectorAll("[data-cy]")).map(
                    (el) => el.getAttribute("data-cy") || "",
                  ),
                ),
              ).slice(0, 60),
            );
            console.error(
              `[live-smoke] containment: neither feed-virtual-item nor a cdnpk image rendered in ${createdProjectUuid}; data-cy seen: ${JSON.stringify(seen)}`,
            );
          }
          await page.waitForTimeout(1500);
          const { tiles, cdnImgs } = await page.evaluate(() => ({
            tiles: document.querySelectorAll('[data-cy="feed-virtual-item"]')
              .length,
            cdnImgs: Array.from(
              document.querySelectorAll('img[src*="cdnpk.net"]'),
            ).filter(
              (img) =>
                img instanceof HTMLImageElement &&
                (img.naturalWidth >= 200 || img.width >= 200),
            ).length,
          }));
          expect(
            cdnImgs,
            `expected >= ${IMAGE_PROMPTS.length} cdnpk images inside the Project, found ${cdnImgs} (feed-virtual-item tiles=${tiles})`,
          ).toBeGreaterThanOrEqual(IMAGE_PROMPTS.length);
          expect(
            tiles,
            `feed-virtual-item not rendered (tiles=${tiles}) — the v3 feed view selector may have drifted; cdnpk images found=${cdnImgs}`,
          ).toBeGreaterThanOrEqual(1);
        } finally {
          await page.close().catch(() => {});
        }

        // ── Phase 5: best-effort cleanup of the throwaway Project ─────────────
        // Magnific's delete requires typing "delete" to confirm. Selectors here
        // are UNVERIFIED (the S0 probe exercised this manually); on any miss we
        // log loudly and leave the Project for manual removal (afterAll prints
        // the URL). A cleanup miss does NOT fail the smoke.
        await bestEffortDeleteProject(browserCtx, createdProjectUuid!).catch((e) => {
          console.warn("[live-smoke] project delete (best-effort) failed:", e);
        });

        // ── Phase 6: runtime down + orphan check ──────────────────────────────
        await magnificRuntime.stop();
        runtimeStarted = false;
        await new Promise((r) => setTimeout(r, 1000));
        const chromeAfter = countChromeProcesses();
        expect(
          chromeAfter,
          `orphan check: ${chromeAfter} chrome processes after stop vs ${chromeBefore} before`,
        ).toBeLessThanOrEqual(chromeBefore);
      },
      DRAIN_TIMEOUT_MS + 3 * 60 * 1000,
    );
  },
);

// Best-effort delete of the throwaway Project via Magnific's type-"delete"
// confirm flow. UNVERIFIED selectors — kept isolated so a drift here is loud
// and non-fatal (the smoke's value is the assertions above, not cleanup).
async function bestEffortDeleteProject(
  ctx: BrowserContext,
  uuid: string,
): Promise<void> {
  const page = await ctx.newPage();
  try {
    await page.goto(`${MAGNIFIC_PROJECTS_URL}/${uuid}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(2000);
    // Open the project actions/settings menu, click Delete, type the
    // confirmation word, confirm. These are best-guess selectors.
    const trigger = page
      .locator('[data-cy="project-tree-dropdown-trigger"], [data-cy="project-settings-button"]')
      .first();
    if ((await trigger.count()) === 0) {
      console.warn("[live-smoke] delete: no project actions trigger found — leaving Project for manual cleanup.");
      return;
    }
    await trigger.click();
    await page.waitForTimeout(500);
    const del = page.getByText(/^delete project$/i).first();
    if ((await del.count()) === 0) {
      console.warn("[live-smoke] delete: no 'Delete project' item found — leaving Project for manual cleanup.");
      return;
    }
    await del.click();
    await page.waitForTimeout(500);
    const confirmInput = page.locator('input[placeholder*="delete" i], input[type="text"]').first();
    if ((await confirmInput.count()) > 0) {
      await confirmInput.fill("delete");
    }
    const confirmBtn = page.getByRole("button", { name: /^delete$/i }).first();
    if ((await confirmBtn.count()) > 0) {
      await confirmBtn.click();
      await page.waitForTimeout(1500);
      console.warn("[live-smoke] delete: confirm clicked — verify the Project is gone in Magnific.");
    } else {
      console.warn("[live-smoke] delete: no confirm button found — leaving Project for manual cleanup.");
    }
  } finally {
    await page.close().catch(() => {});
  }
}
