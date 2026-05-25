import type { Database as DatabaseType } from "better-sqlite3";
import * as videosRepo from "@/lib/repos/videos";

/**
 * Predicate abstraction over "should this pipeline run be cancelled?".
 * Production wires this to `videos.delete_requested`; tests inject a fake.
 *
 * Keeping the contract a bare predicate (DIP) means the orchestrator never
 * imports the videos repo for cancellation, and adding new cancel reasons
 * (e.g. a worker-level shutdown flag) is a matter of composing predicates,
 * not changing the orchestrator.
 */
export type CancellationSource = () => boolean;

/** Reason string passed to AbortController.abort on a delete-driven cancel. */
export const CANCEL_REASON_DELETE = "delete_requested";

/** Production CancellationSource — closes over (db, videoId). */
export function deleteRequestedSource(
  db: DatabaseType,
  videoId: string
): CancellationSource {
  return () => videosRepo.readDeleteRequested(db, videoId);
}

export interface CancellationWatcherOpts {
  /** Poll interval in ms. Default 2000. */
  intervalMs?: number;
  /** Reason string passed to controller.abort. Default CANCEL_REASON_DELETE. */
  reason?: string;
}

const DEFAULT_INTERVAL_MS = 2_000;

/**
 * Spawn a polling watcher that flips `controller` once `source()` returns
 * true. Returns a stop function the caller invokes in `finally`.
 *
 * Runs an immediate fast-path check at startup so a delete that landed
 * before the pipeline started aborts on tick zero rather than waiting
 * one interval.
 */
export function startCancellationWatcher(
  controller: AbortController,
  source: CancellationSource,
  opts: CancellationWatcherOpts = {}
): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const reason = opts.reason ?? CANCEL_REASON_DELETE;

  if (controller.signal.aborted) {
    return () => {};
  }
  if (source()) {
    controller.abort(reason);
    return () => {};
  }

  const handle = setInterval(() => {
    if (controller.signal.aborted) {
      clearInterval(handle);
      return;
    }
    let cancelled = false;
    try {
      cancelled = source();
    } catch {
      // Source is a DB read; if it throws (e.g. db closed during shutdown)
      // treat as "not cancelled" — the next tick or finally-stop will
      // tear the watcher down. Better than crashing the worker.
      return;
    }
    if (cancelled) {
      controller.abort(reason);
      clearInterval(handle);
    }
  }, intervalMs);

  // setInterval keeps the event loop alive; unref so a wedged source
  // never blocks process exit. The pipeline always stops the watcher in
  // finally, so this is purely defensive.
  if (typeof handle.unref === "function") {
    handle.unref();
  }

  return () => clearInterval(handle);
}

/**
 * True when an error originated from an `AbortController.abort()`. Centralized
 * because both `fetch` (DOMException name='AbortError') and `child_process.spawn`
 * (Error name='AbortError') surface cancellation this way and string-matching
 * the message would miss localized variants.
 */
export function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return true;
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  ) {
    return true;
  }
  return false;
}

/**
 * Throw an AbortError-shaped error if the signal is already aborted.
 * Used at the top of poll iterations and between batched items to
 * surface cancellation eagerly without waiting for the next fetch to
 * notice the signal.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error(
      typeof signal.reason === "string"
        ? `Cancelled: ${signal.reason}`
        : "Cancelled"
    );
    err.name = "AbortError";
    throw err;
  }
}
