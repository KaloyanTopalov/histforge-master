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

export interface AI33SynthesizeOpts {
  db?: DatabaseType;
  log?: (message: string) => void;
  /** Base delay for submit-retry exponential backoff, in ms. Tests pass 0. */
  retryDelayMs?: number;
  /** Delay between task-status polls, in ms. Tests pass 0. */
  pollIntervalMs?: number;
  /** Cancellation signal — passed to fetch and checked before each poll. */
  signal?: AbortSignal;
}

const BASE_URL = "https://api.ai33.pro/v1";
const MAX_SUBMIT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
/**
 * Bound on consecutive non-fatal poll failures (network, HTTP non-2xx,
 * non-JSON body, schema mismatch). A permanently-down upstream surfaces
 * as a step error after this many ticks instead of spinning forever —
 * the original AI33 incident class. Independent of cancellation.
 */
const MAX_CONSECUTIVE_POLL_FAILURES = 60;

/**
 * Runtime schema for the task-status poll response. Validated at runtime
 * so a wrong shape surfaces as a logged line instead of a silent spin.
 * `status` is kept as an open string — unknown values are treated as
 * non-terminal and logged.
 */
const PollResponseSchema = z.object({
  status: z.string(),
  error_message: z.string().nullable().optional(),
  progress: z.number().nullable().optional(),
  metadata: z
    .object({
      audio_url: z.string().nullable().optional(),
      srt_url: z.string().nullable().optional(),
      json_url: z.string().nullable().optional(),
    })
    .passthrough()
    .optional(),
});
type PollResponse = z.infer<typeof PollResponseSchema>;

interface PollResult {
  audioUrl: string;
  srtUrl?: string;
  jsonUrl?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the submit body using ElevenLabs-compatible voice_settings nesting.
 * Voice tuning params come from Settings (not hardcoded).
 */
function buildSubmitBody(text: string, db: DatabaseType): string {
  return JSON.stringify({
    text,
    model_id: getSetting("voiceover_model_id", db),
    with_transcript: true,
    voice_settings: {
      stability: getSetting("voice_stability", db),
      similarity_boost: getSetting("voice_similarity", db),
      style: getSetting("voice_style", db),
      use_speaker_boost: getSetting("voice_use_speaker_boost", db),
      speed: getSetting("voice_speed", db),
    },
  });
}

async function submitTask(
  text: string,
  apiKey: string,
  voiceId: string,
  db: DatabaseType,
  baseDelay: number,
  signal?: AbortSignal
): Promise<string> {
  const url = `${BASE_URL}/text-to-speech/${voiceId}?output_format=mp3_44100_128`;
  const init: RequestInit = {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
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
          `AI33 submit ${response.status}: ${await response.text()}`
        );
      }
      const json = (await response.json()) as { task_id?: string };
      if (typeof json.task_id !== "string") {
        throw new Error(
          `AI33 submit response missing task_id: ${JSON.stringify(json)}`
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

async function pollUntilReady(
  taskId: string,
  apiKey: string,
  pollIntervalMs: number,
  log?: (message: string) => void,
  signal?: AbortSignal
): Promise<PollResult> {
  const url = `${BASE_URL}/task/${taskId}`;
  const headers = { "xi-api-key": apiKey };

  const seenLogLines = new Set<string>();
  const logOnce = (message: string): void => {
    if (seenLogLines.has(message)) return;
    seenLogLines.add(message);
    log?.(message);
  };

  let lastLoggedProgress: number | null = null;
  let consecutiveFailures = 0;

  // Surface a permanent upstream outage as a step failure rather than a
  // forever-spin. Cancellation is handled separately (throwIfAborted +
  // signal-aware fetch).
  const noteFailure = (kind: string): void => {
    consecutiveFailures += 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
      throw new Error(
        `AI33 task ${taskId}: ${MAX_CONSECUTIVE_POLL_FAILURES} consecutive poll failures (${kind}) — giving up`
      );
    }
  };

  for (;;) {
    throwIfAborted(signal);
    await sleep(pollIntervalMs);
    throwIfAborted(signal);

    let response: Response;
    try {
      response = await fetch(url, { method: "GET", headers, signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      logOnce(
        `AI33 task ${taskId} poll network error (will retry): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      noteFailure("network");
      continue;
    }
    if (!response.ok) {
      logOnce(
        `AI33 task ${taskId} poll HTTP ${response.status} (will retry)`
      );
      noteFailure(`http-${response.status}`);
      continue;
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      logOnce(`AI33 task ${taskId} poll body was not JSON (will retry)`);
      noteFailure("non-json-body");
      continue;
    }

    const parsed = PollResponseSchema.safeParse(raw);
    if (!parsed.success) {
      logOnce(
        `AI33 task ${taskId} poll response did not match schema: ${JSON.stringify(raw)}`
      );
      noteFailure("schema-mismatch");
      continue;
    }
    const json: PollResponse = parsed.data;
    consecutiveFailures = 0;

    if (typeof json.progress === "number" && json.progress !== lastLoggedProgress) {
      log?.(`AI33 task ${taskId} progress: ${json.progress}% (status=${json.status})`);
      lastLoggedProgress = json.progress;
    }

    if (json.status === "done") {
      const audioUrl = json.metadata?.audio_url;
      if (typeof audioUrl !== "string" || audioUrl === "") {
        logOnce(
          `AI33 task ${taskId} done without audio_url, raw: ${JSON.stringify(raw)} — will retry poll`
        );
        continue;
      }
      return {
        audioUrl,
        srtUrl: json.metadata?.srt_url ?? undefined,
        jsonUrl: json.metadata?.json_url ?? undefined,
      };
    }
    if (json.status === "error") {
      const msg = json.error_message ?? "unknown error";
      throw new Error(`AI33 task ${taskId} failed: ${msg}`);
    }
    if (json.status !== "doing") {
      logOnce(
        `AI33 task ${taskId} returned unknown poll status: ${json.status}`
      );
    }
    // doing | unknown-non-terminal → loop
  }
}

/**
 * Sidecar file living next to `narration.mp3` that holds the in-flight
 * AI33 task_id. Written after a successful submit so a worker restart can
 * resume polling instead of submitting a duplicate (paid) task. Deleted
 * after a successful download. Terminal step failures are cleaned up by
 * the orchestrator via `step.outputs` in `06-voiceover.ts`, so the AI33
 * client deliberately does not wipe the sidecar on throw — leaving it on
 * disk after a worker crash is what makes resume work.
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
      `AI33 sidecar read failed (treating as missing, will submit fresh): ${
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
      `AI33 sidecar write failed (continuing with in-memory task_id): ${
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
    throw new Error(`AI33 download ${response.status}: ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, bytes);
}

async function synthesize(
  text: string,
  outMp3Path: string,
  opts: AI33SynthesizeOpts = {}
): Promise<TtsResult> {
  const envKey = TTS_PROVIDER_META.ai33.envKey;
  const apiKey = process.env[envKey];
  if (!apiKey) {
    throw new Error(
      `${envKey} is not set. Copy .env.example to .env and fill it in.`
    );
  }

  const db = opts.db ?? getDb();
  const baseDelay = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const pollInterval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const voiceId = getSetting("voice_id", db);

  const audioDir = dirname(outMp3Path);
  const sidecarPath = join(audioDir, SIDECAR_NAME);

  let taskId: string;
  const resumedTaskId = readSidecar(sidecarPath, opts.log);
  if (resumedTaskId !== null) {
    taskId = resumedTaskId;
    opts.log?.(`AI33 resuming task ${taskId} from sidecar`);
  } else {
    taskId = await submitTask(
      text,
      apiKey,
      voiceId,
      db,
      baseDelay,
      opts.signal
    );
    opts.log?.(`AI33 task submitted: ${taskId} (voice=${voiceId})`);
    writeSidecar(sidecarPath, taskId, opts.log);
  }

  const pollResult = await pollUntilReady(
    taskId,
    apiKey,
    pollInterval,
    opts.log,
    opts.signal
  );
  opts.log?.(`AI33 task ${taskId} completed, downloading audio`);

  // Download MP3
  await downloadFile(pollResult.audioUrl, outMp3Path, opts.signal);

  // Download transcripts to sibling paths
  const transcripts: NonNullable<TtsResult["transcripts"]> = {};

  if (pollResult.srtUrl) {
    const srtPath = join(audioDir, "narration.srt");
    await downloadFile(pollResult.srtUrl, srtPath, opts.signal);
    transcripts.srtPath = srtPath;
  }

  if (pollResult.jsonUrl) {
    const jsonPath = join(audioDir, "narration.json");
    await downloadFile(pollResult.jsonUrl, jsonPath, opts.signal);
    transcripts.jsonPath = jsonPath;
  }

  // Success — drop the resume token so the next run starts cleanly.
  rmSync(sidecarPath, { force: true });

  return {
    transcripts:
      Object.keys(transcripts).length > 0 ? transcripts : undefined,
  };
}

export const ai33Provider = { synthesize } satisfies TtsProvider;
