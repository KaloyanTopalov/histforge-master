import { spawn } from "node:child_process";
import { throwIfAborted } from "@/worker/cancellation";
import type { ChatMessage, ChatOpts, LlmProvider } from "./types";

export type { ChatMessage, ChatOpts } from "./types";

/**
 * Shell out to the local `claude` binary via `claude -p --model <name>`
 * with the prompt piped over stdin. Roles aren't preserved — the CLI
 * takes one prompt blob, so messages are joined with `\n\n`. The four
 * script-module steps each pass a single user message, so v1 is
 * loss-free.
 *
 * Prompt-on-stdin (not argv) is load-bearing on Windows: `CreateProcessW`
 * caps the combined command line at ~32K chars, and prompts that embed
 * prior script files (write_hook, write_chapter, generate_visual_prompts)
 * blow past that and fail synchronously with ENAMETOOLONG. Stdin has no
 * such cap.
 *
 * Unlike openrouter.ts, no retry loop: CLI failures are usually deterministic
 * (bad path, bad flag, dead model). The orchestrator's per-step failure
 * handling decides whether to retry.
 */
export async function chat(
  messages: ChatMessage[],
  opts: ChatOpts = {}
): Promise<string> {
  if (!opts.model) {
    throw new Error(
      "claude-cli.chat: opts.model is required — the pipeline resolves the per-purpose model at the boundary."
    );
  }
  const model = opts.model;

  const prompt = messages.map((m) => m.content).join("\n\n");
  const args = ["-p", "--model", model];

  // Eager pre-spawn abort check — addEventListener("abort", …) does not
  // fire on an already-aborted signal, so without this a delete that
  // landed before the call would still pay the spawn cost.
  throwIfAborted(opts.signal);

  return spawnAndCapture("claude", args, prompt, opts.signal);
}

function spawnAndCapture(
  cliPath: string,
  args: string[],
  prompt: string,
  signal: AbortSignal | undefined
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args);
    // Write the prompt to stdin and close it. Closing without writing
    // would trip the CLI's "no stdin data received in 3s" warning;
    // writing the full prompt then closing gives the CLI EOF and lets
    // it process and exit.
    child.stdin.end(prompt, "utf8");
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    // Aborted flag wins over the close-handler's exit-code branch: a
    // kill-induced non-zero close would otherwise reject with "claude
    // exited with code N" and mask the AbortError shape callers expect.
    let aborted = false;
    let onAbort: (() => void) | undefined;
    if (signal) {
      onAbort = () => {
        aborted = true;
        child.kill();
        const err = new Error(
          typeof signal.reason === "string"
            ? `Cancelled: ${signal.reason}`
            : "Cancelled"
        );
        err.name = "AbortError";
        reject(err);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const detachAbortListener = (): void => {
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) => {
      detachAbortListener();
      reject(err);
    });
    child.on("close", (code) => {
      detachAbortListener();
      if (aborted) return;
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8").trim());
      } else {
        // The CLI writes some failures (e.g. invalid --model) to stdout,
        // not stderr — include both so the cause is visible.
        const out = Buffer.concat(stdout).toString("utf8").trim();
        const err = Buffer.concat(stderr).toString("utf8").trim();
        const detail =
          [err, out].filter(Boolean).join(" | ") || "(no output)";
        reject(new Error(`claude exited with code ${code}: ${detail}`));
      }
    });
  });
}

export const claudeCliProvider: LlmProvider = { chat };
