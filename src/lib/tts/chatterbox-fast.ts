import type { Database as DatabaseType } from "better-sqlite3";
import { Agent } from "undici";
import { getDb } from "../db";
import { getSetting } from "../settings";
import { isAbortError, throwIfAborted } from "@/worker/cancellation";
import { wavBytesToMp3 } from "./chatterbox-transcode";
import {
  LIVENESS_FAILURE_REASON,
  startChatterboxLivenessWatcher,
} from "./chatterbox-liveness";
import { chunkScript } from "./chunker";
import type { TtsProvider, TtsResult } from "./types";

// Same long-running undici dispatcher reasoning as chatterbox.ts: the
// fast sidecar holds the connection open while it generates, then
// returns the WAV in one shot. Disabling header/body timeouts on a
// dedicated dispatcher lets very long generations complete without the
// fetch client timing out the request from under them.
//
// The trade-off (server crashing mid-request leaves fetch waiting
// forever) is covered by the same liveness watcher that chatterbox.ts
// uses — the sidecar exposes /health on the same FastAPI surface, so
// the probe semantics carry over verbatim.
const chatterboxFastDispatcher = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
});

export interface ChatterboxFastSynthesizeOpts {
  db?: DatabaseType;
  log?: (message: string) => void;
  /** Cancellation signal — passed straight to fetch and to the transcode helper. */
  signal?: AbortSignal;
  /**
   * WAV → MP3 transcode injection point — defaults to the real ffmpeg-
   * based helper. Tests pass a fake so they don't have to spawn ffmpeg.
   * Same DI shape as `chatterbox.ts`'s `synthesizeChatterbox`.
   */
  transcode?: (
    wavBytes: Buffer,
    outMp3Path: string,
    opts?: { signal?: AbortSignal; speed?: number }
  ) => Promise<void>;
  /**
   * Liveness-watcher injection point. Defaults to the real watcher.
   * Tests pass a fake to drive the abort path deterministically. See
   * `chatterbox-liveness.ts` for the watcher contract.
   */
  startLivenessWatcher?: typeof startChatterboxLivenessWatcher;
}

/**
 * Chatterbox-fast TTS — synchronous HTTP against the local fast sidecar
 * (rsxdalv/chatterbox@fast wrapped in chatterbox-fast-server/). The
 * sidecar exposes a single unified body shape (`voice_filename` +
 * `voice_mode`) rather than devnen's predefined-vs-clone split — the
 * sidecar resolves the directory itself.
 *
 * Phase 2: all calls go through `/tts/batch`. The chunker splits the
 * script on sentence boundaries (with abbreviation guard) and the
 * sidecar generates chunks in parallel — one model per concurrent
 * worker, leased from a thread-safe pool — joining them with
 * `silence_ms` of digital silence to mask seams.
 *
 * Speed handling lives in the WAV→MP3 transcode (ffmpeg `atempo`)
 * because the fast fork's `model.generate()` exposes no speed
 * parameter; see Task 0.2 in the chatterbox-parallelism plan.
 */
export async function synthesizeChatterboxFast(
  text: string,
  outMp3Path: string,
  opts: ChatterboxFastSynthesizeOpts = {}
): Promise<TtsResult> {
  const db = opts.db ?? getDb();

  const baseUrl = getSetting("chatterbox_fast_base_url", db);
  const voiceMode = getSetting("chatterbox_voice_mode", db);
  const voiceFilename = getSetting("chatterbox_voice_filename", db);
  const temperature = getSetting("chatterbox_temperature", db);
  const exaggeration = getSetting("chatterbox_exaggeration", db);
  const cfgWeight = getSetting("chatterbox_cfg_weight", db);
  const speedFactor = getSetting("chatterbox_speed_factor", db);
  const maxChunkChars = getSetting("chatterbox_fast_max_chunk_chars", db);
  const silenceMs = getSetting("chatterbox_fast_silence_ms", db);
  const workers = getSetting("chatterbox_fast_workers", db);

  if (voiceFilename === "") {
    throw new Error(
      "Chatterbox voice filename is empty — set it in Settings → TTS (filename inside the server's voices/ or reference_audio/ directory)."
    );
  }

  const chunks = chunkScript(text, { maxChars: maxChunkChars });
  if (chunks.length === 0) {
    throw new Error(
      "Chatterbox (fast) received empty text after chunking — script must contain at least one non-whitespace character."
    );
  }

  // Body shape matches chatterbox-fast-server/server.py's BatchRequest.
  // No `speed_factor` field — handled at the ffmpeg transcode stage.
  const body = {
    chunks,
    voice_mode: voiceMode,
    voice_filename: voiceFilename,
    temperature,
    exaggeration,
    cfg_weight: cfgWeight,
    silence_ms: silenceMs,
    workers,
  };

  const url = `${baseUrl}/tts/batch`;
  throwIfAborted(opts.signal);

  opts.log?.(
    `Chatterbox (fast) posting ${chunks.length} chunk${chunks.length === 1 ? "" : "s"} to ${url} (workers=${workers}, silence=${silenceMs}ms)`
  );
  const startedAt = Date.now();

  // Internal controller composes user-cancel with liveness-watcher
  // aborts onto a single signal — same pattern as chatterbox.ts.
  const internal = new AbortController();
  const userSignal = opts.signal;
  let userAbortForwarder: (() => void) | null = null;
  if (userSignal) {
    userAbortForwarder = () => {
      internal.abort(userSignal.reason);
    };
    userSignal.addEventListener("abort", userAbortForwarder, { once: true });
  }

  const startWatcher = opts.startLivenessWatcher ?? startChatterboxLivenessWatcher;
  const liveness = startWatcher({
    baseUrl,
    controller: internal,
    userSignal,
    log: opts.log,
  });

  // Periodic step-log heartbeat. Without this, a stalled sidecar shows
  // up in the dashboard as 20+ minutes of total silence between
  // "posting N chunks" and the final timeout — operators have no way
  // to tell "still working" from "wedged" without tailing the sidecar
  // terminal. unref()'d so the heartbeat never holds the worker alive
  // past the fetch resolution. Cleared in `finally` regardless of
  // outcome (success, error, abort, liveness-failure).
  const HEARTBEAT_MS = 60_000;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  if (opts.log) {
    heartbeatTimer = setInterval(() => {
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      opts.log!(
        `Chatterbox (fast) still waiting on /tts/batch — ${elapsedSec}s elapsed (chunks=${chunks.length}, workers=${workers}). Tail the sidecar console for per-chunk progress.`
      );
    }, HEARTBEAT_MS);
    if (typeof heartbeatTimer.unref === "function") {
      heartbeatTimer.unref();
    }
  }

  // `dispatcher` is undici's non-standard extension to RequestInit;
  // widen the type locally rather than casting so the rest stays typed.
  const init: RequestInit & { dispatcher?: Agent } = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: internal.signal,
    dispatcher: chatterboxFastDispatcher,
  };

  let wavBytes: Buffer;
  try {
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(
        `Chatterbox (fast) synthesize ${response.status}: ${await response.text()}`
      );
    }
    wavBytes = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    if (
      isAbortError(err) &&
      internal.signal.reason === LIVENESS_FAILURE_REASON
    ) {
      const summary = liveness.getFailureSummary();
      throw new Error(
        `Chatterbox (fast) server unreachable at ${baseUrl}${summary ? ` — ${summary}` : ""}. Is the server still running? (Detected via /health probes during in-flight TTS request.)`
      );
    }
    throw err;
  } finally {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
    }
    liveness.stop();
    if (userSignal && userAbortForwarder) {
      userSignal.removeEventListener("abort", userAbortForwarder);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  opts.log?.(
    `Chatterbox (fast) returned ${wavBytes.length} WAV bytes in ${elapsedMs} ms, transcoding`
  );

  const transcode = opts.transcode ?? wavBytesToMp3;
  await transcode(wavBytes, outMp3Path, {
    signal: opts.signal,
    speed: speedFactor,
  });

  return {};
}

export const chatterboxFastProvider: TtsProvider = {
  synthesize: synthesizeChatterboxFast,
};
