import type { Database as DatabaseType } from "better-sqlite3";
import type { DeferSignal } from "@/worker/pipeline";

export interface VideoProviderGenerateBatchOpts {
  db?: DatabaseType;
  log?: (message: string) => void;
  videoId: string;
  projectsDir: string;
  pollIntervalMs?: number;
  nowSec?: () => number;
  nowMs?: () => number;
  /** Cancellation signal — see ImageProviderGenerateBatchOpts. */
  signal?: AbortSignal;
}

export interface VideoProviderCleanupOpts {
  db?: DatabaseType;
  log?: (message: string) => void;
  projectsDir: string;
}

export interface VideoProvider {
  generateBatch(
    items: { id: string; prompt: string }[],
    targetDir: string,
    opts: VideoProviderGenerateBatchOpts
  ): Promise<void | DeferSignal>;
  cleanup?(
    videoId: string,
    opts: VideoProviderCleanupOpts
  ): Promise<void> | void;
}
