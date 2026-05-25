import { isAbortError, throwIfAborted } from "@/worker/cancellation";
import type { ChatMessage, ChatOpts, LlmProvider } from "./types";

export type { ChatMessage, ChatOpts } from "./types";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

/**
 * Call OpenRouter's chat-completions endpoint. Returns the assistant's
 * content string from `choices[0].message.content`.
 *
 * Interface contract from docs/histforge-spec.md:788 — the rest of the
 * pipeline depends on this shape and nothing else.
 *
 * Retries up to MAX_ATTEMPTS with exponential backoff on non-2xx
 * responses and thrown fetch errors. A dead API key or a steady 4xx
 * will exhaust retries quickly (1s + 2s pause) and surface a clear
 * error to the orchestrator, which marks the step failed.
 */
export async function chat(
  messages: ChatMessage[],
  opts: ChatOpts = {}
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Copy .env.example to .env and fill it in."
    );
  }

  if (!opts.model) {
    throw new Error(
      "openrouter.chat: opts.model is required — the pipeline resolves the per-purpose model at the boundary."
    );
  }
  const model = opts.model;
  const baseDelay = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  const body = JSON.stringify({ model, messages });
  const init: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body,
    signal: opts.signal,
  };

  // Eager pre-loop check — a pre-aborted signal must not hit the network.
  throwIfAborted(opts.signal);

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(ENDPOINT, init);
      if (!response.ok) {
        throw new Error(
          `OpenRouter ${response.status}: ${await response.text()}`
        );
      }
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error(
          `OpenRouter response missing choices[0].message.content: ${JSON.stringify(json)}`
        );
      }
      return content;
    } catch (err) {
      // Cancellation must not respect the backoff schedule. throwIfAborted
      // handles the "signal flipped, fetch threw something else" race by
      // emitting an AbortError-shape regardless of err's original type;
      // the second check covers the case where fetch rejected with
      // AbortError before the signal observably flipped.
      throwIfAborted(opts.signal);
      if (isAbortError(err)) throw err;
      lastError = err;
      if (attempt < MAX_ATTEMPTS - 1) {
        // Exponential backoff: 1s, 2s, 4s by default. Tests pass 0.
        await sleep(baseDelay * 2 ** attempt);
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const openrouterProvider: LlmProvider = { chat };
