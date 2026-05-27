import "dotenv/config";
import { getDb } from "@/lib/db";
import { startReaper } from "@/lib/flow-watcher";
import { magnificRuntime } from "@/lib/magnific-runtime";
import * as gfRepo from "@/lib/repos/google-flow";
import * as magnificRepo from "@/lib/repos/magnific";
import { getSetting } from "@/lib/settings";
import { bootValidate } from "./boot";
import { runPipeline } from "./pipeline";
import { resetStaleRunningSteps, runLoop } from "./runner";

let shutdownRequested = false;

process.on("SIGINT", () => {
  shutdownRequested = true;
});
process.on("SIGTERM", () => {
  shutdownRequested = true;
});

/**
 * Worker entry point. Long-running process; one Node instance per worker.
 *
 * On startup:
 *   1. Open the DB (singleton via getDb()).
 *   2. bootValidate(db) — fail-fast schema/registry consistency check.
 *      Runs before any state-mutating call so a corrupt DB (e.g., a
 *      workflow row referencing a deleted slug) doesn't get partial
 *      cleanup before the operator sees the error.
 *   3. Normalize stale `running` step rows back to `pending` — anything left
 *      in `running` is a crash leftover, the worker is definitely not
 *      running it now.
 *   4. Flip any stuck `dispatched` Google Flow + Magnific queue rows back
 *      to `pending` — the extension may have been mid-task when HistForge
 *      died. Both submit-result handlers are state-tolerant, so any late
 *      submissions from either extension resolve cleanly as duplicates.
 *   5. Enter the main loop.
 *
 * On SIGINT/SIGTERM the loop finishes its current step, then exits cleanly.
 */
async function main(): Promise<void> {
  const db = getDb();
  const projectsDir = process.env.PROJECTS_DIR ?? "./projects";
  bootValidate(db, projectsDir);
  resetStaleRunningSteps(db);
  gfRepo.resetAllDispatchedOnStartup(db);
  magnificRepo.resetAllDispatchedOnStartup(db);
  // Magnific runtime auto-boot (Decision 3 in the runtime spec): skipped
  // in development so tsx watch reloads don't fight over the userDataDir
  // lock — developers click "Connect Magnific" in the dashboard when they
  // need the browser during a dev session. The runtime's start() is a noop
  // in S1 (throws "not implemented"); the guard is what's being verified.
  if (
    process.env.NODE_ENV !== "development" &&
    getSetting("magnific_runtime_enabled", db)
  ) {
    void magnificRuntime.start().catch((err) => {
      console.error("[magnific-runtime] start failed:", err);
    });
  }
  const stopReaper = startReaper(db, {
    dispatchTimeoutMinutes: getSetting(
      "google_flow_dispatch_timeout_minutes",
      db
    ),
    magnificDispatchTimeoutMinutes: getSetting(
      "magnific_dispatch_timeout_minutes",
      db
    ),
    log: (msg) => console.log(`[flow-watcher] ${msg}`),
  });
  try {
    await runLoop(db, (videoId) => runPipeline(videoId), {
      shouldStop: () => shutdownRequested,
    });
  } finally {
    stopReaper();
  }
}

main().catch((err) => {
  // Top-level crash → exit non-zero so a supervisor (or `concurrently`)
  // notices. The loop itself catches per-pipeline errors; reaching here
  // means something more fundamental failed (DB open, etc.).
  console.error("[worker] fatal:", err);
  process.exit(1);
});
