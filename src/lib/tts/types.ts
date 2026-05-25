import type { Database as DatabaseType } from "better-sqlite3";

export interface TtsResult {
  transcripts?: {
    srtPath?: string;
    jsonPath?: string;
  };
}

export interface TtsProvider {
  synthesize(
    text: string,
    outMp3Path: string,
    opts: {
      db?: DatabaseType;
      log?: (message: string) => void;
      /**
       * Cancellation signal. When aborted (the user requested deletion
       * mid-step), the provider should propagate to fetch and throw an
       * AbortError. Optional so ad-hoc callers (tests, scripts) can omit
       * cancellation; production wires it from `StepContext.signal`.
       */
      signal?: AbortSignal;
    }
  ): Promise<TtsResult>;
}
