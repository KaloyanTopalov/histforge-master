import type { BrowserContext } from "playwright";

export interface RuntimeStatus {
  running: boolean;
  connected: boolean;
  session_valid: boolean;
  last_error: string | null;
}

export interface ConnectResult {
  success: boolean;
  reason?: string;
}

const NOT_IMPLEMENTED = "magnific-runtime: not implemented in S1 (foundation)";

export class MagnificRuntime {
  // S1 keeps the field so S2's lifecycle code has the slot in place. The
  // singleton instance is constructed at module load (see export at bottom)
  // so any caller importing magnificRuntime gets the same reference.
  private context: BrowserContext | null = null;
  private lastError: string | null = null;

  async start(): Promise<void> {
    void this.context;
    void this.lastError;
    throw new Error(NOT_IMPLEMENTED);
  }

  async stop(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async connect(_timeoutMs?: number): Promise<ConnectResult> {
    void _timeoutMs;
    throw new Error(NOT_IMPLEMENTED);
  }

  async status(): Promise<RuntimeStatus> {
    throw new Error(NOT_IMPLEMENTED);
  }
}

export const magnificRuntime = new MagnificRuntime();
