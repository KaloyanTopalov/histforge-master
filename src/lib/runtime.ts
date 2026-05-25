import type { VideoStep } from "@/types";

/**
 * Format a millisecond duration as a human-readable elapsed time:
 * `<1s` for sub-second values, `Xs` / `Xm Ys` / `Xh Ym Zs` otherwise.
 */
export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec <= 0) return "<1s";
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Total active step time across the supplied steps. Mirrors the algo on
 * the video detail page: each started step contributes (finished_at ?? now)
 * - started_at, so completed/failed steps freeze at their final span and
 * the running step (at most one in this codebase) extrapolates to `now`.
 *
 * Returns `null` when no step has started — the caller uses this to hide
 * the timer entirely until the first step picks up. Pending-only videos
 * return `null`.
 */
export function computeRuntimeMs(
  steps: readonly VideoStep[],
  now: number,
): number | null {
  let totalMs = 0;
  let anyStarted = false;
  for (const s of steps) {
    if (s.started_at === null) continue;
    anyStarted = true;
    const end = s.finished_at ?? now;
    totalMs += end - s.started_at;
  }
  if (!anyStarted) return null;
  return totalMs;
}

/**
 * Format the per-video "Total time" label for the videos list. Takes the
 * server-side snapshot (sum of completed step durations + the open step's
 * started_at, if any) and extrapolates the in-flight piece to `now`.
 *
 * Returns `null` when the video has not started any step yet — callers
 * render that as an em-dash. Otherwise returns the `formatDuration`
 * string the detail page would show for the same data.
 */
export function videoTimerLabel(
  snapshot: { runtime_ms: number; running_step_started_at: number | null },
  now: number,
): string | null {
  const open = snapshot.running_step_started_at;
  if (snapshot.runtime_ms === 0 && open === null) return null;
  const inflight = open !== null ? Math.max(0, now - open) : 0;
  return formatDuration(snapshot.runtime_ms + inflight);
}
