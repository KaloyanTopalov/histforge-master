/**
 * Integration smoke for the magnific-runtime. Launches a real Playwright
 * Chromium with the magnific-ext extension loaded, navigates to
 * magnific.com, and asserts Cloudflare lets us through (status 200 or a
 * redirect to /log-in). Tears the browser down and verifies no orphan
 * Chromium processes were left behind.
 *
 * Skipped unless `RUN_MAGNIFIC_RUNTIME=1` is set in the env. Never runs
 * in CI — this is a manual gate the operator runs locally after S2's
 * extension-ID probe to confirm the runtime's first end-to-end path
 * against real Chromium works. Every unit test in this subsystem mocks
 * Playwright at the type boundary; without this smoke, no test exercises
 * `chromium.launchPersistentContext` + `--load-extension` for real.
 *
 * Run with:
 *   RUN_MAGNIFIC_RUNTIME=1 npm run test -- magnific-runtime-smoke
 *   # PowerShell:
 *   $env:RUN_MAGNIFIC_RUNTIME="1"; npm run test -- magnific-runtime-smoke
 */
// Load DATABASE_URL etc. before the lib imports below resolve `getDb()`.
// Unit tests mock settings at the type boundary; this smoke talks to the
// real SQLite to snapshot/restore the live `magnific_runtime_user_data_dir`
// setting, so it needs the same env the worker entry loads.
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserContext } from "playwright";

import { getDb } from "@/lib/db";
import { magnificRuntime } from "@/lib/magnific-runtime";
import { getSetting, setSetting } from "@/lib/settings";

const RUN = process.env.RUN_MAGNIFIC_RUNTIME === "1";

const TEST_USER_DATA_DIR = "data/magnific-userdata-test";

function countChromeProcesses(): number {
  // Best-effort orphan check — `tasklist` / `pgrep` failures collapse to 0
  // rather than failing the test. Constraint per spec: "best-effort".
  try {
    if (process.platform === "win32") {
      const out = execSync(
        'tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV /NH',
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      );
      // CSV rows: one per process. Empty output when tasklist's filter
      // matches nothing is the literal string "INFO: No tasks ...".
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

describe.skipIf(!RUN)(
  "magnific-runtime smoke (real Playwright Chromium + extension) — requires RUN_MAGNIFIC_RUNTIME=1",
  () => {
    let originalUserDataDir = "";
    let originalToken = "";
    let chromeBefore = 0;

    beforeAll(() => {
      const db = getDb();
      originalUserDataDir = getSetting("magnific_runtime_user_data_dir", db);
      originalToken = getSetting("magnific_token", db);
      setSetting("magnific_runtime_user_data_dir", TEST_USER_DATA_DIR, db);
      if (!originalToken) {
        setSetting("magnific_token", "smoke-test-token", db);
      }
      chromeBefore = countChromeProcesses();
    });

    afterAll(() => {
      const db = getDb();
      setSetting("magnific_runtime_user_data_dir", originalUserDataDir, db);
      setSetting("magnific_token", originalToken, db);
      try {
        rmSync(resolve(process.cwd(), TEST_USER_DATA_DIR), {
          recursive: true,
          force: true,
        });
      } catch {
        // Cleanup failure shouldn't mask the real test result — the
        // operator can rm the directory manually if Chromium left a lock.
      }
    });

    it(
      "starts Chromium with magnific-ext, reaches magnific.com, stops cleanly, no orphans",
      async () => {
        try {
          await magnificRuntime.start();

          // The runtime's BrowserContext is private — a one-test typed
          // cast keeps the production API surface unchanged. Adding a
          // public getter for a single smoke consumer would be the
          // wrong shape of abstraction (per spec §"Scope/Out of scope").
          const ctx = (
            magnificRuntime as unknown as { context: BrowserContext | null }
          ).context;
          if (!ctx) {
            throw new Error(
              "runtime.start() resolved but context is still null",
            );
          }

          const page = await ctx.newPage();
          try {
            const res = await page.goto("https://www.magnific.com", {
              waitUntil: "domcontentloaded",
              timeout: 60_000,
            });
            const status = res?.status() ?? 0;
            const url = page.url();
            const ok = status === 200 || /\/log-in/.test(url);
            expect(
              ok,
              `expected status 200 or /log-in redirect; got status=${status}, url=${url}`,
            ).toBe(true);
          } finally {
            try {
              await page.close();
            } catch {
              // tab close failure isn't worth masking the navigation result
            }
          }
        } finally {
          try {
            await magnificRuntime.stop();
          } catch {
            // Stop failure leaves orphans — the orphan check below will
            // catch it; preserve the underlying assertion if any.
          }
        }

        // Give the OS a beat to release the Chromium processes before the
        // orphan headcount — Playwright's context.close resolves before
        // the bundled binary's process tree is fully reaped on Windows.
        await new Promise((r) => setTimeout(r, 1000));
        const chromeAfter = countChromeProcesses();
        expect(
          chromeAfter,
          `orphan check: ${chromeAfter} chrome processes after stop vs ${chromeBefore} before`,
        ).toBeLessThanOrEqual(chromeBefore);
      },
      120_000,
    );
  },
);
