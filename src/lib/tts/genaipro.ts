import type { Database as DatabaseType } from "better-sqlite3";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { getDb } from "../db";
import { getSetting } from "../settings";
import { isAbortError, throwIfAborted } from "@/worker/cancellation";
import { TTS_PROVIDER_META } from "./meta";
import type { TtsProvider, TtsResult } from "./types";

export interface GenAIProSynthesizeOpts {
  db?: DatabaseType;
  log?: (message: string) => void;
  /** Base delay for submit-retry exponential backoff, in ms. Tests pass 0. */
  retryDelayMs?: number;
  /** Delay between task-status polls, in ms. Tests pass 0. */
  pollIntervalMs?: number;
  /** Cancellation signal — passed to fetch and checked before each poll. */
  signal?: AbortSignal;
}

const BASE_URL = "https://genaipro.vn/api";
const MAX_SUBMIT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
/**
 * Bound on consecutive non-fatal poll failures (network, HTTP non-2xx,
 * non-JSON body, schema mismatch). A permanently-down upstream surfaces
 * as a step error after this many ticks instead of spinning forever.
 * Counter resets on a schema-valid response.
 */
const MAX_CONSECUTIVE_POLL_FAILURES = 60;
/**
 * Cap on subtitle-export polls. Subtitle export is best-effort — alignment
 * later runs against the MP3 directly, so a missing SRT is not fatal.
 */
const MAX_SUBTITLE_POLL_ATTEMPTS = 10;
/** Body params for the subtitle-export call. Editorial defaults — no
 * recommendation in the API doc. Tuned for ~2 short cue lines per row. */
const SUBTITLE_EXPORT_BODY = {
  max_characters_per_line: 42,
  max_lines_per_cue: 2,
  max_seconds_per_cue: 5,
};

/**
 * Runtime schema for a `LabTask` poll response. Validated at runtime so a
 * wrong shape surfaces as a logged line instead of a silent spin.
 * `status` is kept as an open string — unknown values are treated as
 * non-terminal and logged. `result` and `subtitle` are nullable strings:
 * they only populate after the task completes / after subtitle export.
 */
const LabTaskSchema = z
  .object({
    status: z.string(),
    result: z.string().nullable().optional(),
    subtitle: z.string().nullable().optional(),
  })
  .passthrough();
type LabTask = z.infer<typeof LabTaskSchema>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the submit body. GenAIPro uses a **flat** body (no `voice_settings`
 * nesting like AI33). Voice tuning params come from Settings.
 */
function buildSubmitBody(text: string, db: DatabaseType): string {
  return JSON.stringify({
    input: text,
    model_id: getSetting("voiceover_model_id", db),
    voice_id: getSetting("voice_id", db),
    similarity: getSetting("voice_similarity", db),
    speed: getSetting("voice_speed", db),
    stability: getSetting("voice_stability", db),
    style: getSetting("voice_style", db),
    use_speaker_boost: getSetting("voice_use_speaker_boost", db),
  });
}

async function submitTask(
  text: string,
  apiKey: string,
  db: DatabaseType,
  baseDelay: number,
  signal?: AbortSignal
): Promise<string> {
  const url = `${BASE_URL}/v1/labs/task`;
  const init: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: buildSubmitBody(text, db),
    signal,
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_SUBMIT_ATTEMPTS; attempt++) {
    throwIfAborted(signal);
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        throw new Error(
          `GenAIPro submit ${response.status}: ${await response.text()}`
        );
      }
      const json = (await response.json()) as { task_id?: string };
      if (typeof json.task_id !== "string") {
        throw new Error(
          `GenAIPro submit response missing task_id: ${JSON.stringify(json)}`
        );
      }
      return json.task_id;
    } catch (err) {
      // Cancellation is terminal — don't burn the remaining retries on it.
      if (isAbortError(err)) throw err;
      lastError = err;
      if (attempt < MAX_SUBMIT_ATTEMPTS - 1) {
        await sleep(baseDelay * 2 ** attempt);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

interface PollFailureCounter {
  count: number;
  bump(kind: string): void;
}

function makeFailureCounter(taskId: string): PollFailureCounter {
  const counter: PollFailureCounter = {
    count: 0,
    bump(kind: string): void {
      counter.count += 1;
      if (counter.count >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new Error(
          `GenAIPro task ${taskId}: ${MAX_CONSECUTIVE_POLL_FAILURES} consecutive poll failures (${kind}) — giving up`
        );
      }
    },
  };
  return counter;
}

/**
 * Single poll iteration. Returns the validated `LabTask` on success, or
 * `null` when the iteration was a non-fatal failure (network/HTTP/JSON/
 * schema). The caller owns the loop, the sleep, and the cancellation
 * checks; this keeps the main and subtitle loops sharing the same poll
 * mechanics without duplicating retry/log logic.
 */
async function pollOnce(
  url: string,
  headers: Record<string, string>,
  taskId: string,
  failureCounter: PollFailureCounter,
  logOnce: (message: string) => void,
  signal?: AbortSignal
): Promise<LabTask | null> {
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", headers, signal });
  } catch (err) {
    if (isAbortError(err)) throw err;
    logOnce(
      `GenAIPro task ${taskId} poll network error (will retry): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    failureCounter.bump("network");
    return null;
  }
  if (!response.ok) {
    logOnce(`GenAIPro task ${taskId} poll HTTP ${response.status} (will retry)`);
    failureCounter.bump(`http-${response.status}`);
    return null;
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    logOnce(`GenAIPro task ${taskId} poll body was not JSON (will retry)`);
    failureCounter.bump("non-json-body");
    return null;
  }

  const parsed = LabTaskSchema.safeParse(raw);
  if (!parsed.success) {
    logOnce(
      `GenAIPro task ${taskId} poll response did not match schema: ${JSON.stringify(raw)}`
    );
    failureCounter.bump("schema-mismatch");
    return null;
  }
  failureCounter.count = 0;
  return parsed.data;
}

interface MainPollResult {
  audioUrl: string;
}

async function pollUntilCompleted(
  taskId: string,
  apiKey: string,
  pollIntervalMs: number,
  log?: (message: string) => void,
  signal?: AbortSignal
): Promise<MainPollResult> {
  const url = `${BASE_URL}/v1/labs/task/${taskId}`;
  const headers = { Authorization: `Bearer ${apiKey}` };

  const seenLogLines = new Set<string>();
  const logOnce = (message: string): void => {
    if (seenLogLines.has(message)) return;
    seenLogLines.add(message);
    log?.(message);
  };

  const failureCounter = makeFailureCounter(taskId);

  for (;;) {
    throwIfAborted(signal);
    await sleep(pollIntervalMs);
    throwIfAborted(signal);

    const task = await pollOnce(url, headers, taskId, failureCounter, logOnce, signal);
    if (task === null) continue;

    if (task.status === "completed") {
      const audioUrl = task.result;
      if (typeof audioUrl !== "string" || audioUrl === "") {
        logOnce(
          `GenAIPro task ${taskId} completed without result URL — will retry poll`
        );
        continue;
      }
      return { audioUrl };
    }
    if (task.status !== "processing") {
      logOnce(
        `GenAIPro task ${taskId} returned unknown poll status: ${task.status}`
      );
    }
    // processing | unknown-non-terminal → loop
  }
}

/**
 * Trigger subtitle export on a completed task and poll for the URL to
 * appear on the `subtitle` field. Best-effort: bounded by
 * MAX_SUBTITLE_POLL_ATTEMPTS so a stuck export does not block the step.
 * Returns the SRT URL or `null` if export failed / never populated.
 */
async function fetchSubtitleUrl(
  taskId: string,
  apiKey: string,
  pollIntervalMs: number,
  log?: (message: string) => void,
  signal?: AbortSignal
): Promise<string | null> {
  const exportUrl = `${BASE_URL}/v1/labs/task/subtitle/${taskId}`;
  const taskUrl = `${BASE_URL}/v1/labs/task/${taskId}`;
  const headers = { Authorization: `Bearer ${apiKey}` };

  try {
    throwIfAborted(signal);
    const response = await fetch(exportUrl, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(SUBTITLE_EXPORT_BODY),
      signal,
    });
    if (!response.ok) {
      log?.(
        `GenAIPro subtitle export failed for task ${taskId}: HTTP ${response.status} — continuing without SRT`
      );
      return null;
    }
  } catch (err) {
    if (isAbortError(err)) throw err;
    log?.(
      `GenAIPro subtitle export request errored for task ${taskId}: ${
        err instanceof Error ? err.message : String(err)
      } — continuing without SRT`
    );
    return null;
  }

  const failureCounter = makeFailureCounter(taskId);
  const seen = new Set<string>();
  const logOnce = (message: string): void => {
    if (seen.has(message)) return;
    seen.add(message);
    log?.(message);
  };

  for (let attempt = 0; attempt < MAX_SUBTITLE_POLL_ATTEMPTS; attempt++) {
    throwIfAborted(signal);
    await sleep(pollIntervalMs);
    throwIfAborted(signal);

    const task = await pollOnce(
      taskUrl,
      headers,
      taskId,
      failureCounter,
      logOnce,
      signal
    );
    if (task === null) continue;

    if (typeof task.subtitle === "string" && task.subtitle !== "") {
      return task.subtitle;
    }
  }

  log?.(
    `GenAIPro subtitle URL did not populate for task ${taskId} within ${MAX_SUBTITLE_POLL_ATTEMPTS} polls — continuing without SRT`
  );
  return null;
}

/**
 * Sidecar file living next to `narration.mp3` that holds the in-flight
 * GenAIPro task_id. Written after a successful submit so a worker restart
 * can resume polling instead of submitting a duplicate (paid) task. Deleted
 * after a successful download. Terminal step failures are cleaned up by
 * the orchestrator via `step.outputs` in `06-voiceover.ts`, so the client
 * deliberately does not wipe the sidecar on throw — leaving it on disk
 * after a worker crash is what makes resume work.
 *
 * Filename and on-disk format are byte-compatible with `ai33.ts` because
 * both providers share `step.outputs = ["audio/.tts_task_id"]` for failure
 * cleanup.
 */
const SIDECAR_NAME = ".tts_task_id";

function readSidecar(
  path: string,
  log?: (message: string) => void
): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return null;
    log?.(
      `GenAIPro sidecar read failed (treating as missing, will submit fresh): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function writeSidecar(
  path: string,
  taskId: string,
  log?: (message: string) => void
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, taskId);
    renameSync(tmp, path);
  } catch (err) {
    log?.(
      `GenAIPro sidecar write failed (continuing with in-memory task_id): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

async function downloadFile(
  url: string,
  outPath: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`GenAIPro download ${response.status}: ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, bytes);
}

async function synthesize(
  text: string,
  outMp3Path: string,
  opts: GenAIProSynthesizeOpts = {}
): Promise<TtsResult> {
  const envKey = TTS_PROVIDER_META.genaipro.envKey;
  const apiKey = process.env[envKey];
  if (!apiKey) {
    throw new Error(
      `${envKey} is not set. Copy .env.example to .env and fill it in.`
    );
  }

  const db = opts.db ?? getDb();
  const baseDelay = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const pollInterval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const audioDir = dirname(outMp3Path);
  const sidecarPath = join(audioDir, SIDECAR_NAME);

  let taskId: string;
  const resumedTaskId = readSidecar(sidecarPath, opts.log);
  if (resumedTaskId !== null) {
    taskId = resumedTaskId;
    opts.log?.(`GenAIPro resuming task ${taskId} from sidecar`);
  } else {
    taskId = await submitTask(text, apiKey, db, baseDelay, opts.signal);
    opts.log?.(`GenAIPro task submitted: ${taskId}`);
    writeSidecar(sidecarPath, taskId, opts.log);
  }

  const pollResult = await pollUntilCompleted(
    taskId,
    apiKey,
    pollInterval,
    opts.log,
    opts.signal
  );
  opts.log?.(`GenAIPro task ${taskId} completed, downloading audio`);

  await downloadFile(pollResult.audioUrl, outMp3Path, opts.signal);

  const transcripts: NonNullable<TtsResult["transcripts"]> = {};

  // Subtitle export is best-effort. The documented LabTask shape has no
  // JSON transcript field — only an SRT-style `subtitle` URL after export.
  const srtUrl = await fetchSubtitleUrl(
    taskId,
    apiKey,
    pollInterval,
    opts.log,
    opts.signal
  );
  if (srtUrl) {
    const srtPath = join(audioDir, "narration.srt");
    await downloadFile(srtUrl, srtPath, opts.signal);
    transcripts.srtPath = srtPath;
  }

  // Success — drop the resume token so the next run starts cleanly.
  rmSync(sidecarPath, { force: true });

  return {
    transcripts:
      Object.keys(transcripts).length > 0 ? transcripts : undefined,
  };
}

export const genaiproProvider: TtsProvider = { synthesize };
