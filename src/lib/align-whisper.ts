import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { AlignmentEntry } from "@/types";
import { splitSentences } from "./sentences";

/**
 * Default locations for the bundled whisper.cpp binary + model.
 *
 * `vendor/whisper/` is operator-installed (the install script extracts a
 * pre-built Windows zip whose root contains `Release/whisper-cli.exe`
 * and a sibling `ggml-base.en.bin` model). The `.gitignore` excludes
 * `vendor/`, so each operator pulls their own copy.
 */
const DEFAULT_BIN_RELATIVE = "vendor/whisper/Release/whisper-cli.exe";
const DEFAULT_MODEL_RELATIVE = "vendor/whisper/ggml-base.en.bin";

export interface AlignOpts {
  /** Override spawn for testing. */
  spawnFn?: typeof spawn;
  /** Override the binary path (absolute). Defaults to the bundled vendor copy. */
  binPath?: string;
  /** Override the model path (absolute). Defaults to the bundled vendor copy. */
  modelPath?: string;
  /** Override repo root (test seam — defaults to cwd). */
  repoRoot?: string;
}

/**
 * One whisper-cli segment as serialized by `--output-json`. The full
 * shape contains a lot more (model info, params, tokens), but the
 * aligner only consumes these three keys per `transcription[]` entry.
 */
interface WhisperSegment {
  offsets: { from: number; to: number };
  text: string;
}

interface WhisperOutput {
  transcription: WhisperSegment[];
}

/**
 * Forced alignment via whisper.cpp (`vendor/whisper/Release/whisper-cli.exe`).
 *
 * Replaces the prior WSL+aeneas path. Same signature as the old
 * `align()`:
 *
 *   align(audioPath, scriptPath, outPath): Promise<void>
 *
 * 1. Reads the script from `scriptPath` and splits it into sentences
 *    (existing `splitSentences()` helper).
 * 2. Spawns `whisper-cli.exe -m <model> -oj -of <tmp> <audio>` to
 *    transcribe the narration. Whisper writes a JSON file at
 *    `<tmp>.json` with segment-level timings (millisecond offsets).
 * 3. Builds a word-by-word timeline from the whisper segments,
 *    interpolating times linearly within each segment's character
 *    span (segment-internal precision isn't load-bearing — downstream
 *    consumers chunk by sentence groups, not individual words).
 * 4. For each script sentence, finds the position of its first few
 *    normalized words in the whisper transcript, takes that as
 *    `begin`, and uses the next sentence's begin as `end`. Last
 *    sentence's `end` falls back to the last whisper segment's
 *    end-time (≈ audio duration).
 * 5. Writes `[{id, text, begin, end}]` to `outPath`.
 *
 * The interface stays generic so a future hosted aligner (WhisperX,
 * stable-ts, etc.) can drop in by re-implementing this signature.
 */
export async function align(
  audioPath: string,
  scriptPath: string,
  outPath: string,
  opts: AlignOpts = {}
): Promise<void> {
  const spawnFn = opts.spawnFn ?? spawn;
  const repoRoot = opts.repoRoot ?? process.cwd();
  const binPath = opts.binPath ?? resolve(repoRoot, DEFAULT_BIN_RELATIVE);
  const modelPath = opts.modelPath ?? resolve(repoRoot, DEFAULT_MODEL_RELATIVE);

  // Friendly pre-flight: probing here gives a much better error than
  // letting `spawn` ENOENT into the orchestrator's generic step-failed
  // message.
  if (!existsSync(binPath)) {
    throw new Error(
      `whisper-cli not found at ${binPath} — install whisper.cpp under vendor/whisper/ (see docs/histforge-spec.md or run the install script).`
    );
  }
  if (!existsSync(modelPath)) {
    throw new Error(
      `whisper model not found at ${modelPath} — drop ggml-base.en.bin into vendor/whisper/.`
    );
  }

  const script = readFileSync(scriptPath, "utf-8");
  const sentences = splitSentences(script);
  if (sentences.length === 0) {
    throw new Error(`align: script at ${scriptPath} contained no sentences`);
  }

  // whisper-cli `-of` is a basename — it appends `.json`. Write into
  // the same alignment/ dir as the final output and delete after parse.
  const outDir = resolve(outPath, "..");
  mkdirSync(outDir, { recursive: true });
  const tmpBase = resolve(outDir, "whisper_out");
  const tmpJsonPath = `${tmpBase}.json`;

  await runWhisperCli(spawnFn, binPath, modelPath, audioPath, tmpBase);

  let whisperJson: WhisperOutput;
  try {
    whisperJson = JSON.parse(readFileSync(tmpJsonPath, "utf-8")) as WhisperOutput;
  } catch (err) {
    throw new Error(
      `align: failed to parse whisper output at ${tmpJsonPath}: ${
        (err as Error).message
      }`
    );
  } finally {
    try {
      unlinkSync(tmpJsonPath);
    } catch {
      // best-effort cleanup
    }
  }

  const entries = buildAlignmentEntries(sentences, whisperJson);

  writeFileSync(outPath, JSON.stringify(entries, null, 2), "utf-8");
}

/**
 * Spawn whisper-cli with the standard flag set HistForge uses:
 *   -m <model>     model file
 *   -oj            output JSON
 *   -of <base>     output file basename (whisper appends `.json`)
 *
 * Resolves on exit code 0; rejects with captured stderr otherwise.
 * Stderr is captured (not inherited) so we can surface the real error
 * to the operator if whisper-cli refuses a file format or can't load
 * the model.
 */
function runWhisperCli(
  spawnFn: typeof spawn,
  binPath: string,
  modelPath: string,
  audioPath: string,
  outBase: string
): Promise<void> {
  return new Promise<void>((resolveP, reject) => {
    const args = ["-m", modelPath, "-oj", "-of", outBase, audioPath];
    const child: ChildProcess = spawnFn(binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      // whisper-cli is chatty on stderr (model load info, timings,
      // etc.); keep only the tail so the eventual error doesn't dump
      // the entire log onto the operator.
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on("error", (err) => {
      reject(new Error(`failed to spawn whisper-cli: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(" | ");
        reject(
          new Error(
            `whisper-cli exited with code ${code}${tail ? `: ${tail}` : ""}`
          )
        );
      } else {
        resolveP();
      }
    });
  });
}

/**
 * Internal data shape: every normalized word in the whisper transcript
 * with its estimated start time in seconds. Times within a segment are
 * linearly interpolated by character position — precise enough for
 * sentence-level alignment, which is all downstream consumers need.
 */
interface TimedWord {
  word: string;
  start_sec: number;
}

/**
 * Linearly interpolate per-word start times within a whisper segment,
 * concatenated end-to-end across all segments. The output is a
 * positional index: `timeline[k].start_sec` is the start time of the
 * k-th normalized word in the whole transcript.
 */
export function buildWordTimeline(segments: WhisperSegment[]): TimedWord[] {
  const out: TimedWord[] = [];
  for (const seg of segments) {
    const normalized = normalize(seg.text);
    const words = normalized.split(" ").filter((w) => w.length > 0);
    if (words.length === 0) continue;
    const startSec = seg.offsets.from / 1000;
    const endSec = seg.offsets.to / 1000;
    const dur = Math.max(0, endSec - startSec);
    const perWord = dur / words.length;
    for (let i = 0; i < words.length; i++) {
      out.push({ word: words[i], start_sec: startSec + i * perWord });
    }
  }
  return out;
}

/**
 * Normalize text for fuzzy matching: lowercase, strip everything that
 * isn't a letter or digit, collapse whitespace. TTS audio sometimes
 * gets transcribed with odd word splits ("thousand" → "yiddles" on
 * the base.en model with numbers), so the normalizer has to be tight
 * about punctuation but lenient enough that small typos don't break
 * the match heuristic.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Sentence → time-range mapping. For each script sentence:
 *   1. Take the first `PROBE_WORDS` of its normalized form as a needle.
 *   2. Scan forward in the word timeline from the current cursor for
 *      a window of that length whose words match the needle.
 *   3. If a confident match is found, that's the sentence's begin.
 *      Otherwise fall back to proportional distribution from the
 *      cursor — keeps the function total-error-bounded by the audio
 *      duration even when whisper transcription quality is poor.
 *   4. `end` is the next sentence's begin (or the timeline tail for
 *      the last sentence).
 *
 * Exported for testing — the fuzzy matcher is the most-likely-to-drift
 * piece and benefits from being exercised with hand-crafted timelines.
 */
export function buildAlignmentEntries(
  sentences: string[],
  whisperJson: WhisperOutput
): AlignmentEntry[] {
  const timeline = buildWordTimeline(whisperJson.transcription);
  const audioEndSec =
    whisperJson.transcription.length > 0
      ? whisperJson.transcription[whisperJson.transcription.length - 1].offsets.to /
        1000
      : 0;

  const begins: number[] = new Array(sentences.length).fill(0);
  let cursor = 0;
  for (let i = 0; i < sentences.length; i++) {
    const norm = normalize(sentences[i]);
    if (norm.length === 0) {
      begins[i] = i === 0 ? 0 : begins[i - 1];
      continue;
    }
    const sentWords = norm.split(" ").filter((w) => w.length > 0);
    if (sentWords.length === 0) {
      begins[i] = i === 0 ? 0 : begins[i - 1];
      continue;
    }
    const match = findSentenceStart(sentWords, timeline, cursor);
    if (match !== null) {
      begins[i] = timeline[match].start_sec;
      cursor = match + 1;
    } else {
      // Fall back to proportional placement from current cursor → end.
      // Use the remaining sentences' summed normalized length as the
      // denominator so per-sentence weights stay accurate even when
      // some matches succeed and others don't.
      const remaining = sentences.slice(i).map(
        (s) => Math.max(1, normalize(s).length)
      );
      const total = remaining.reduce((a, b) => a + b, 0);
      const startSec = cursor < timeline.length ? timeline[cursor].start_sec : audioEndSec;
      const remainSec = Math.max(0, audioEndSec - startSec);
      let offset = 0;
      for (let j = 0; j < remaining.length; j++) {
        begins[i + j] = startSec + (offset / total) * remainSec;
        offset += remaining[j];
      }
      break;
    }
  }

  const entries: AlignmentEntry[] = sentences.map((text, i) => ({
    id: `f${String(i + 1).padStart(6, "0")}`,
    text,
    begin: roundMs(begins[i]),
    end: roundMs(i + 1 < sentences.length ? begins[i + 1] : audioEndSec),
  }));

  // Defense: enforce monotonic non-decreasing `begin` and `end >=
  // begin`. Whisper segments can occasionally cross-over on the base
  // model; clamping here means the chunker downstream never sees a
  // negative-duration alignment row.
  for (let i = 0; i < entries.length; i++) {
    if (i > 0 && entries[i].begin < entries[i - 1].begin) {
      entries[i].begin = entries[i - 1].begin;
    }
    if (entries[i].end < entries[i].begin) {
      entries[i].end = entries[i].begin;
    }
  }

  return entries;
}

/** Round to millisecond precision. */
function roundMs(sec: number): number {
  return Math.round(sec * 1000) / 1000;
}

/** First N words of a sentence used as the search needle. */
const PROBE_WORDS = 3;
/** Minimum exact word matches in the probe before we accept a hit. */
const MIN_PROBE_HITS = 2;
/** How far forward in the timeline to scan before declaring no match. */
const MAX_PROBE_SCAN = 200;

/**
 * Find the start index of a script sentence in the whisper word
 * timeline, returning null if no confident match is found before the
 * scan window expires.
 *
 * Algorithm: take the sentence's first PROBE_WORDS words. Slide a
 * window of that size through the timeline starting at `cursor`. The
 * best window is the one with the most exact word-equal hits; if it
 * meets MIN_PROBE_HITS, accept it.
 */
function findSentenceStart(
  sentWords: string[],
  timeline: TimedWord[],
  cursor: number
): number | null {
  if (timeline.length === 0) return null;
  const needle = sentWords.slice(0, PROBE_WORDS);
  if (needle.length === 0) return null;
  const minHits = Math.min(MIN_PROBE_HITS, needle.length);

  const scanEnd = Math.min(timeline.length, cursor + MAX_PROBE_SCAN);
  let bestStart = -1;
  let bestHits = 0;
  for (let i = cursor; i < scanEnd; i++) {
    let hits = 0;
    for (let j = 0; j < needle.length; j++) {
      if (i + j >= timeline.length) break;
      if (timeline[i + j].word === needle[j]) hits++;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestStart = i;
      if (hits === needle.length) break; // perfect match, stop scanning
    }
  }

  return bestHits >= minHits ? bestStart : null;
}
