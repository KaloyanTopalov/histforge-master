import type { Database as DatabaseType } from "better-sqlite3";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOpts {
  model?: string;
  db?: DatabaseType;
  /**
   * Base delay for exponential backoff between retries, in ms. Tests pass
   * 0 to avoid real sleeps. Production default is 1000 (1s, 2s, 4s).
   */
  retryDelayMs?: number;
  /** Honored by both providers; aborts in-flight fetch / kills the spawned CLI. */
  signal?: AbortSignal;
}

export interface LlmProvider {
  chat(messages: ChatMessage[], opts?: ChatOpts): Promise<string>;
}
