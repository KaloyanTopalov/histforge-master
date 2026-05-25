import type { Database as DatabaseType } from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Step } from "@/worker/pipeline";
import type { Chunk } from "@/types";
import { getSetting } from "@/lib/settings";
import { render } from "@/lib/prompts";
import * as videosRepo from "@/lib/repos/videos";
import { parseVisualStyleSnapshot } from "@/lib/visual-styles";
import type { ChatMessage } from "@/lib/llm/types";

interface BatchItem {
  id: string;
  prev_text: string;
  current_text: string;
  next_text: string;
}

const MAX_PARSE_ATTEMPTS = 2;

/**
 * Character-lock + style-lock: hard system instruction prepended to every
 * visual-prompt LLM call. Tells the model not to describe the character's
 * appearance or art style — the style and negative-prompt blocks are
 * appended verbatim by post-processing below, and re-describing them in
 * the LLM output is wasted tokens and a drift risk.
 */
const SYSTEM_INSTRUCTION =
  "Do not describe the character's appearance or art style. Only describe " +
  "the environment, the character's posture and action, and what is around " +
  "the character. The character is locked by a reference ingredient and the " +
  "style is appended by code.";

/**
 * Append the two operator-editable lock segments verbatim onto a single
 * LLM-returned prompt. Empty segments are skipped — an operator who
 * wants no lock leaves the textarea blank, and the final prompt has no
 * dangling ". Negative: ." artifact.
 *
 * Format (with both non-empty):
 *   `<prompt>. <styleLock>. Negative: <negativeLock>.`
 *
 * The exact form (separators, trailing period on each segment) is the
 * plan's spec; see __tests__/image/prompt-assembly.test.ts.
 */
function applyLocks(
  prompt: string,
  styleLock: string,
  negativeLock: string
): string {
  const segments: string[] = [];
  if (styleLock.length > 0) segments.push(styleLock);
  if (negativeLock.length > 0) segments.push(`Negative: ${negativeLock}`);
  if (segments.length === 0) return prompt;
  return `${prompt}. ${segments.join(". ")}.`;
}

/**
 * Raised by `parseEnvelopeReply` when the LLM's response is malformed.
 * The per-chunk fallback in `runOneBatch` only fires on this class —
 * transport errors (network, abort, etc.) bubble up to the orchestrator
 * untouched.
 */
class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

/**
 * Step 9 — generate_visual_prompts. Spec section 11.
 *
 * Per ADR-0002: batched JSON envelopes, per-provider bounded
 * concurrency, skip-already-enriched resume, retry-once-then-per-chunk
 * parse fallback, eager `prompt_history` reset on the to-regenerate
 * subset, and an in-process write mutex.
 */
export const step: Step = {
  name: "generate_visual_prompts",
  module: "glue",
  label: "Generate visual prompts",
  description: "Generates a visual prompt for each chunk via batched LLM calls.",
  for_each: "chunks",
  inputs: ["chunks/chunks.json"],
  // Re-running fills missing prompts only (skip-already-enriched);
  // partial state is harmless to leave.
  outputs: [],
  produces: ["chunks/chunks.json"],
  async run(videoId, ctx) {
    const projectDir = resolve(ctx.projectsDir, videoId);
    const chunksPath = join(projectDir, "chunks", "chunks.json");

    const chunks: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));

    // Skip-already-enriched: only null-prompt chunks need work. If the
    // working set is empty the file already reflects the final state —
    // no LLM calls, no write.
    const workingIndexes = chunks
      .map((c, i) => (c.prompt === null ? i : -1))
      .filter((i) => i >= 0);
    if (workingIndexes.length === 0) return;

    // Per-video style snapshot pinned at create/queue time. NULL =
    // "Default (no style)" — empty string into the `style_prompt`
    // template variable.
    const video = videosRepo.findById(ctx.db, videoId);
    const snapshot = parseVisualStyleSnapshot(video?.visual_style_snapshot);
    const stylePrompt = snapshot?.prompt ?? "";
    const K = getSetting("visual_prompts_batch_size", ctx.db);
    // Lock settings: read once at step entry, applied as a post-process
    // on every persisted prompt. Empty = skip that segment. See
    // applyLocks() above for the exact format.
    const styleLock = getSetting("style_lock_description", ctx.db);
    const negativeLock = getSetting("character_lock_negative", ctx.db);

    // Eager prompt_history sweep: clear lineage on the to-regenerate
    // subset *before* any LLM call so a mid-step crash leaves consistent
    // state. Persist once.
    for (const i of workingIndexes) {
      chunks[i].prompt_history = [];
    }
    writeFileSync(chunksPath, JSON.stringify(chunks, null, 2), "utf-8");

    // Build BatchItem[] for each working-set chunk, drawing prev/next
    // from the *full* chunks array (not the batch) — neighbourliness is
    // global, not per-batch.
    const items: BatchItem[] = workingIndexes.map((i) => ({
      id: chunks[i].id,
      prev_text: i > 0 ? chunks[i - 1].text : "",
      current_text: chunks[i].text,
      next_text: i < chunks.length - 1 ? chunks[i + 1].text : "",
    }));

    // Slice into K-sized batches, preserving order.
    const batches: BatchItem[][] = [];
    for (let i = 0; i < items.length; i += K) {
      batches.push(items.slice(i, i + K));
    }

    // In-process write mutex. A Promise chain held in `writeLock`
    // serializes all file writes so concurrent batches can't tear JSON.
    let writeLock: Promise<void> = Promise.resolve();
    const persistBatch = (results: Map<string, string>): Promise<void> => {
      writeLock = writeLock.then(() => {
        for (const c of chunks) {
          const p = results.get(c.id);
          if (p !== undefined) c.prompt = p;
        }
        writeFileSync(chunksPath, JSON.stringify(chunks, null, 2), "utf-8");
      });
      return writeLock;
    };

    // Wrap a Map<id, raw-llm-prompt> with the lock-segment post-process
    // before handing it to persistBatch. Applied uniformly on the main
    // batch and per-chunk fallback paths so all persisted prompts carry
    // the locks.
    const enrich = (raw: Map<string, string>): Map<string, string> => {
      const out = new Map<string, string>();
      for (const [id, prompt] of raw) {
        out.set(id, applyLocks(prompt, styleLock, negativeLock));
      }
      return out;
    };

    const runOneBatch = async (batch: BatchItem[]): Promise<void> => {
      try {
        const results = await callBatchWithRetry(batch, {
          chat: ctx.visualPromptChat,
          db: ctx.db,
          promptsDir: ctx.promptsDir,
          stylePrompt,
        });
        await persistBatch(enrich(results));
      } catch (err) {
        // Only parse failures trigger the per-chunk fallback. Transport
        // errors (network, abort) propagate up to the orchestrator.
        if (!(err instanceof ParseError)) throw err;
        // Parse failure persisted across retry — fall back to per-chunk
        // (K=1) calls for *this batch only*. Other batches still run
        // batched at full concurrency. A per-chunk call that also
        // parse-fails twice throws out of here, and the orchestrator
        // marks the step failed.
        for (const item of batch) {
          const results = await callBatchWithRetry([item], {
            chat: ctx.visualPromptChat,
            db: ctx.db,
            promptsDir: ctx.promptsDir,
            stylePrompt,
          });
          await persistBatch(enrich(results));
        }
      }
    };

    // Bounded-concurrency worker pool. Each worker pulls the next batch
    // index from a shared cursor until exhausted. `concurrency` workers
    // run in parallel; if N batches < concurrency, the extra workers
    // exit immediately. The shared `stop` flag short-circuits sibling
    // workers once one has thrown: without it, a failed step keeps
    // burning LLM calls + disk writes in the background while the
    // orchestrator is already marking it failed. The current in-flight
    // batch on each sibling still completes (preserves its persist
    // primitive); subsequent batches are not picked up.
    let cursor = 0;
    let stop = false;
    const worker = async (): Promise<void> => {
      while (!stop) {
        const i = cursor++;
        if (i >= batches.length) return;
        try {
          await runOneBatch(batches[i]);
        } catch (err) {
          stop = true;
          throw err;
        }
      }
    };
    const workers: Promise<void>[] = [];
    for (let w = 0; w < Math.max(1, ctx.visualPromptsConcurrency); w++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    // Drain the write queue so anything still in flight lands before
    // we return.
    await writeLock;
  },
};

/**
 * Send a batch through the LLM with retry-once-on-parse-failure
 * semantics (MAX_PARSE_ATTEMPTS = 2). On the retry, append a stricter
 * envelope reminder to give the model a chance to fix its shape. Any
 * call that returns a parseable envelope satisfying the id-keyed
 * invariants resolves; otherwise the last parse error propagates.
 */
async function callBatchWithRetry(
  batch: BatchItem[],
  deps: {
    chat: (
      messages: ChatMessage[],
      opts?: { db?: DatabaseType }
    ) => Promise<string>;
    db: DatabaseType;
    promptsDir: string;
    stylePrompt: string;
  }
): Promise<Map<string, string>> {
  const expectedIds = new Set(batch.map((b) => b.id));
  const userPrompt = render(
    "09_generate_visual_prompts.md",
    {
      batch_json: JSON.stringify(batch, null, 2),
      style_prompt: deps.stylePrompt,
    },
    deps.promptsDir
  );
  const retryReminder =
    "\n\nREMINDER: Respond with a single JSON object of the exact shape " +
    '`{"prompts": [{"id": "<chunk_id>", "prompt": "<string>"}, ...]}`. ' +
    "One entry per input id, using the input ids exactly. No preamble, " +
    "no commentary, no markdown fences. Begin your response with `{` and end with `}`.";

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_PARSE_ATTEMPTS; attempt++) {
    const content = attempt === 0 ? userPrompt : `${userPrompt}${retryReminder}`;
    const reply = await deps.chat(
      [
        { role: "system", content: SYSTEM_INSTRUCTION },
        { role: "user", content },
      ],
      { db: deps.db }
    );
    try {
      return parseEnvelopeReply(reply, expectedIds);
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ParseError(String(lastError));
}

/**
 * Strict envelope validation. Returns an `id → prompt` map iff:
 *   - the reply parses as JSON,
 *   - it has a top-level `prompts` array,
 *   - every entry has string `id` + non-empty string `prompt`,
 *   - the entry id set equals `expectedIds` exactly (no missing, no
 *     extra, no duplicates).
 */
function parseEnvelopeReply(
  reply: string,
  expectedIds: Set<string>
): Map<string, string> {
  const cleaned = stripCodeFence(reply);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new ParseError(
      `generate_visual_prompts: JSON.parse failed: ${(err as Error).message}`
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { prompts?: unknown }).prompts)
  ) {
    throw new ParseError(
      `generate_visual_prompts: response missing prompts[]: ${reply.slice(0, 200)}`
    );
  }
  const out = new Map<string, string>();
  const entries = (parsed as { prompts: unknown[] }).prompts;
  for (const e of entries) {
    if (
      !e ||
      typeof e !== "object" ||
      typeof (e as { id?: unknown }).id !== "string" ||
      typeof (e as { prompt?: unknown }).prompt !== "string"
    ) {
      throw new ParseError(
        `generate_visual_prompts: bad entry: ${JSON.stringify(e).slice(0, 200)}`
      );
    }
    const item = e as { id: string; prompt: string };
    if (item.prompt.length === 0) {
      throw new ParseError(
        `generate_visual_prompts: empty prompt for id ${item.id}`
      );
    }
    if (!expectedIds.has(item.id)) {
      throw new ParseError(
        `generate_visual_prompts: unexpected id ${item.id}`
      );
    }
    if (out.has(item.id)) {
      throw new ParseError(
        `generate_visual_prompts: duplicate id ${item.id}`
      );
    }
    out.set(item.id, item.prompt);
  }
  if (out.size !== expectedIds.size) {
    const missing = [...expectedIds].filter((id) => !out.has(id));
    throw new ParseError(
      `generate_visual_prompts: missing ids ${missing.join(", ")}`
    );
  }
  return out;
}

// The prompt forbids markdown fences but LLMs sometimes wrap JSON in
// ```json ... ``` anyway. Strip a single surrounding fence so JSON.parse
// can consume the body. Mirrors lib/moderator.ts.
function stripCodeFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "");
}
