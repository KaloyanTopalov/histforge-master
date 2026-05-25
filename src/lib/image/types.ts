import type { Database as DatabaseType } from "better-sqlite3";
import type { DeferSignal } from "@/worker/pipeline";

export interface ImageProviderGenerateBatchOpts {
  db?: DatabaseType;
  log?: (message: string) => void;
  videoId: string;
  projectsDir: string;
  pollIntervalMs?: number;
  nowSec?: () => number;
  nowMs?: () => number;
  /**
   * Cancellation signal threaded from the orchestrator. Providers should
   * pass it to fetch / spawn so an aborted controller stops in-flight HTTP
   * polls promptly. Optional for ad-hoc callers (tests) that don't want
   * to manage cancellation.
   */
  signal?: AbortSignal;
}

export interface ImageProviderCleanupOpts {
  db?: DatabaseType;
  log?: (message: string) => void;
  projectsDir: string;
}

export interface ImageProvider {
  generateBatch(
    items: { id: string; prompt: string }[],
    targetDir: string,
    opts: ImageProviderGenerateBatchOpts
  ): Promise<void | DeferSignal>;
  cleanup?(
    videoId: string,
    opts: ImageProviderCleanupOpts
  ): Promise<void> | void;
}
