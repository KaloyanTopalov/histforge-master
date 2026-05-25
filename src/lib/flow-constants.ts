/**
 * Shared Flow constants usable from both server (worker, reaper) and
 * client (dashboard) code. Keep this module free of Node-only imports
 * — `flow-watcher.ts` depends on `better-sqlite3`, so constants it
 * shares with the browser bundle live here instead.
 */

import type { GoogleFlowQueueMode } from "@/types";

/**
 * Stale-account threshold in minutes. If a `google_flow_accounts` row's
 * `last_seen_at` is older than this, the account is treated as silent:
 *   - reaper (`flow-watcher.ts`) requeues any dispatched work under it
 *   - dashboard credits cell reports "polling stopped" instead of the
 *     last-known credit value
 */
export const DEFAULT_STALE_ACCOUNT_MINUTES = 10;

/**
 * Concurrency bucket discriminant — the canonical noun shared between
 * the extension's settings/runner and the server's dispatch filter.
 * The two values map to two independent slot counters in the
 * extension and to two disjoint subsets of `GoogleFlowQueueMode` on
 * the server (see `FLOW_BUCKET_MODES`).
 */
export type FlowBucket = "image" | "video";

/**
 * Concurrency-bucket → queue-modes map. The extension declares which
 * bucket it has free capacity for on `/api/flow/next-task` via
 * `wantBucket`; the server filters claimable rows to the modes in
 * this bucket. Values are the server-side `GoogleFlowQueueMode`
 * strings (camelCase) — the extension's EXECUTORS table uses
 * lowercased keys, but only these four values appear in the queue's
 * `mode` column.
 *
 * - `image` bucket: fast image generation (`createImage` only).
 * - `video` bucket: video generation in all three submission shapes
 *   (`text`, `image`, `frames`).
 */
export const FLOW_BUCKET_MODES: Record<FlowBucket, GoogleFlowQueueMode[]> = {
  image: ["createImage"],
  video: ["text", "image", "frames"],
};
