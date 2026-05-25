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
import type { TtsProvider, TtsResult } from "./types";

// Node's global fetch (undici) defaults to a 5-minute headersTimeout and
// bodyTimeout. Chatterbox is a synchronous endpoint — the wrapper holds the
// connection open while it generates the full WAV, then returns it in one shot.
// Long scripts can take well over 5 minutes, at which point fetch throws
// "TypeError: fetch failed" while the server keeps generating and eventually
// succeeds with no client to receive the audio. Disabling both timeouts on a
// dedicated dispatcher lets the client patiently wait for the server.
// connectTimeout is left at the default so unreachable hosts still fail fast.
//
// The trade-off (no client-side timeout means a server that crashes mid-
// request leaves fetch waiting forever) is covered by the liveness watcher
// in `./chatterbox-liveness.ts` — application-level GET /health probes
// abort the in-flight fetch when the server stops responding.
const chatterboxDispatcher = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
});

export interface ChatterboxSynthesizeOpts {
  db?: DatabaseType;
  log?: (message: string) => void;
  /** Cancellation signal — passed straight to fetch and to the transcode helper. */
  signal?: AbortSignal;
  /**
   * WAV → MP3 transcode injection point — defaults to the real ffmpeg-
   * based helper. Tests pass a fake so they don't have to spawn ffmpeg.
   * Not part of the cross-provider `TtsProvider` contract; callers go
   * through `chatterboxProvider.synthesize` which exposes only the
   * narrow opts. Tests import `synthesizeChatterbox` directly to reach
   * the wider type.
   */
  transcode?: (
    wavBytes: Buffer,
    outMp3Path: string,
    opts?: { signal?: AbortSignal; speed?: number }
  ) => Promise<void>;
  /**
   * Liveness-watcher injection point. Defaults to the real watcher
   * (10 s grace, 15 s interval, 5 s probe timeout, 3 consecutive
   * failures). Tests pass a fake to drive the abort path deterministically.
   */
  startLivenessWatcher?: typeof startChatterboxLivenessWatcher;
}

/**
 * Chatterbox TTS — synchronous HTTP against the local devnen wrapper.
 * Diverges from the AI33 / GenAIPro submit/poll/sidecar pattern because
 * the wrapper returns audio inline. Receives WAV bytes from the wrapper
 * and transcodes them to MP3 (the format the rest of the pipeline
 * expects) via piped ffmpeg.
 *
 * Posts to the wrapper's custom `/tts` endpoint (not the OpenAI-compat
 * `/v1/audio/speech`) because `/tts` exposes the
 * predefined-vs-clone-reference selection as explicit body fields,
 * making the `chatterbox_voice_mode` setting load-bearing rather than
 * unused.
 */
export async function synthesizeChatterbox(
  text: string,
  outMp3Path: string,
  opts: ChatterboxSynthesizeOpts = {}
): Promise<TtsResult> {
  const db = opts.db ?? getDb();
  const baseUrl = getSetting("chatterbox_base_url", db);
  const voiceMode = getSetting("chatterbox_voice_mode", db);
  const voiceFilename = getSetting("chatterbox_voice_filename", db);
  const temperature = getSetting("chatterbox_temperature", db);
  const exaggeration = getSetting("chatterbox_exaggeration", db);
  const cfgWeight = getSetting("chatterbox_cfg_weight", db);
  const speedFactor = getSetting("chatterbox_speed_factor", db);

  if (voiceFilename === "") {
    throw new Error(
      "Chatterbox voice filename is empty — set it in Settings → TTS (filename inside the server's voices/ or reference_audio/ directory)."
    );
  }

  // Build the request body. The wrapper accepts predefined_voice_id
  // OR reference_audio_filename depending on voice_mode; sending the
  // unused field as `undefined` keeps it out of the JSON entirely.
  // Tuning params are sent explicitly so what's saved in HistForge
  // settings is what runs — independent of any web-UI slider state on
  // the wrapper at localhost:8004. No `speed_factor` field — speed is
  // applied client-side via ffmpeg `atempo` in the WAV→MP3 transcode
  // (mirrors the chatterbox-fast path). The wrapper's own speed_factor
  // path produces audible distortion at sub-1.0 rates on current builds;
  // atempo gives identical, deterministic behavior across both providers.
  const body: Record<string, unknown> = {
    text,
    voice_mode: voiceMode,
    output_format: "wav",
    temperature,
    exaggeration,
    cfg_weight: cfgWeight,
  };
  if (voiceMode === "predefined") {
    body.predefined_voice_id = voiceFilename;
  } else {
    body.reference_audio_filename = voiceFilename;
  }

  const url = `${baseUrl}/tts`;
  throwIfAborted(opts.signal);

  // Internal controller carries either kind of cancellation: the user's
  // (forwarded from opts.signal) or a liveness-watcher abort triggered
  // when /health probes consistently fail. fetch sees one signal; we
  // disambiguate after the fact via internal.signal.reason.
  const internal = new AbortController();
  const userSignal = opts.signal;
  let userAbortForwarder: (() => void) | null = null;
  if (userSignal) {
    userAbortForwarder = () => {
      // Preserve the user's reason so a delete-driven abort doesn't get
      // mistaken for a liveness-driven abort downstream.
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

  // `dispatcher` is undici's non-standard extension to RequestInit; widen the
  // type locally rather than casting so the rest of the init stays type-checked.
  const init: RequestInit & { dispatcher?: Agent } = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: internal.signal,
    dispatcher: chatterboxDispatcher,
  };

  let wavBytes: Buffer;
  try {
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(
        `Chatterbox synthesize ${response.status}: ${await response.text()}`
      );
    }
    wavBytes = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    // A liveness-driven abort surfaces as AbortError on fetch — translate
    // to a clear server-down error so the worker doesn't mistake it for
    // user cancellation. Pull the watcher's failure summary into the
    // message so the failed-step row in the dashboard names the actual
    // mode (timeouts vs ECONNREFUSED) instead of a generic "stopped
    // responding"; the operator gets the same hint they'd get from
    // tailing pipeline.log, without having to.
    if (
      isAbortError(err) &&
      internal.signal.reason === LIVENESS_FAILURE_REASON
    ) {
      const summary = liveness.getFailureSummary();
      throw new Error(
        `Chatterbox server unreachable at ${baseUrl}${summary ? ` — ${summary}` : ""}. Is the server still running? (Detected via /health probes during in-flight TTS request.)`
      );
    }
    throw err;
  } finally {
    liveness.stop();
    if (userSignal && userAbortForwarder) {
      userSignal.removeEventListener("abort", userAbortForwarder);
    }
  }

  opts.log?.(`Chatterbox returned ${wavBytes.length} WAV bytes, transcoding`);

  const transcode = opts.transcode ?? wavBytesToMp3;
  await transcode(wavBytes, outMp3Path, {
    signal: opts.signal,
    speed: speedFactor,
  });

  return {};
}

export const chatterboxProvider: TtsProvider = {
  synthesize: synthesizeChatterbox,
};
