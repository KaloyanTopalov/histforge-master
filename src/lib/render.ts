/**
 * ffmpeg renderer — builds and spawns ffmpeg commands to compose the final
 * video from clip-chunk video clips, image-chunk still images, and the
 * narration audio track.
 *
 * Spec §13 Render.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Chunk } from "@/types";

export const CROSSFADE_SECONDS = 1.0;
export const ZOOM_TARGET = 1.275;
export const SEGMENT_CONCURRENCY = 4;

/**
 * Thrown by `render()` when one or more image-chunk files are missing on
 * disk before any ffmpeg work begins. Holds `missingChunkIds` for callers
 * (e.g. the worker step's failure logging) to surface specifically. Spec
 * §13.4's placeholder fallback was deliberately removed in the structural-
 * safety baseline — render must fail loudly rather than silently substitute
 * a black "MISSING" frame and then have cleanup wipe the intermediates.
 */
export class RenderPrecheckError extends Error {
  constructor(message: string, public readonly missingChunkIds: string[]) {
    super(message);
    this.name = "RenderPrecheckError";
  }
}

export type VideoEncoder =
  | "libx264"
  | "h264_nvenc"
  | "h264_amf"
  | "av1_nvenc";

// Per-encoder arg bundle for the fused Stage CD invocation. Stages A
// and B keep their libx264 args (ADR-0001 / ADR-0002); only Stage CD's
// three re-encoding sub-cases route through this helper. The two
// stream-copy sub-cases (1 image + 0 clip; ≥1 clip + 0 image) use none
// of these. Values are maintainer decisions per ADR-0004's table —
// refine in code if the operator A/B render shows perceptual drift.
export function getEncoderArgs(encoder: VideoEncoder): string[] {
  switch (encoder) {
    case "libx264":
      return ["-c:v", "libx264", "-preset", "medium", "-crf", "20"];
    case "h264_nvenc":
      return [
        "-c:v", "h264_nvenc",
        "-preset", "p5",
        "-tune", "hq",
        "-rc", "vbr",
        "-cq", "21",
        "-b:v", "0",
      ];
    case "h264_amf":
      return [
        "-c:v", "h264_amf",
        "-quality", "balanced",
        "-rc", "cqp",
        "-qp_i", "21",
        "-qp_p", "23",
      ];
    // AV1 NVENC's CQ scale runs 0-63 (vs H.264's 0-51), so cq 33 lands
    // ~where h264_nvenc's cq 21 sits perceptually. Hardware requires
    // RTX 40-series (Ada Lovelace) or newer — older NVIDIA GPUs will
    // error out at exec time with "Unknown encoder 'av1_nvenc'".
    case "av1_nvenc":
      return [
        "-c:v", "av1_nvenc",
        "-preset", "p5",
        "-tune", "hq",
        "-rc", "vbr",
        "-cq", "33",
        "-b:v", "0",
      ];
  }
}

const ASPECT_RATIOS: Record<string, [number, number]> = {
  "16:9": [16, 9],
  "9:16": [9, 16],
  "1:1": [1, 1],
  "4:5": [4, 5],
};

/**
 * Derive pixel W×H from an aspect ratio string and the long-edge pixel count.
 * The short edge is rounded to the nearest even number (ffmpeg requires even
 * dimensions for most codecs).
 */
export function computeResolution(
  aspectRatio: string,
  longEdgePx: number
): { width: number; height: number } {
  const pair = ASPECT_RATIOS[aspectRatio];
  if (!pair) throw new Error(`Unknown aspect ratio: ${aspectRatio}`);

  // Round both edges to even — libx264 requires even dimensions.
  const long = Math.round(longEdgePx / 2) * 2;
  const [w, h] = pair;
  if (w >= h) {
    // landscape or square — long edge is width
    const short = Math.round((long * h) / w / 2) * 2;
    return { width: long, height: short };
  }
  // portrait — long edge is height
  const short = Math.round((long * w) / h / 2) * 2;
  return { width: short, height: long };
}

export type RenderImageMotion = "ken_burns" | "static";

export interface SegmentArgsOpts {
  imagePath: string;
  chunkDuration: number;
  isLast: boolean;
  width: number;
  height: number;
  framerate: number;
  outPath: string;
  /**
   * Per-image motion mode. `"ken_burns"` preserves the historical
   * pre-upscale + zoompan chain (1.0 → ZOOM_TARGET linear ramp).
   * `"static"` emits a flat scale-to-W:H still and skips the
   * `deriveZoomBuffer` pre-upscale entirely — its only purpose was to
   * feed the zoompan headroom, which is wasted work when there is no
   * zoom. Required so the choice is explicit at every call site; the
   * Stage B caller reads `getSetting("render_image_motion")` and passes
   * it in.
   */
  motion: RenderImageMotion;
  /**
   * Pre-rendered draw-on reveal clip for this image chunk (produced by
   * the `draw_on_images` step). When set, `buildSegmentArgs` emits a
   * draw-on segment chain — no `-loop`, no zoompan, the clip itself is
   * the input — with a `tpad=stop_mode=clone` extending the last frame
   * to cover the Stage CD crossfade overlap on non-last segments.
   *
   * When `undefined`, the function is byte-identical to its pre-Phase-6
   * shape — the cinematic ken_burns and static `-vf` strings are pinned
   * by `render.test.ts:160-179` and `:280-294`. The gate is the literal
   * absence of this field; the field's optionality is load-bearing.
   * Phase 5 (`materializeStepList`) decides whether the upstream
   * `draw_on_images` step ran; Phase 7 wires Stage B to pass this path
   * in only for chunks belonging to a draw-on-style workflow.
   */
  drawOnClipPath?: string;
}

export interface ZoomBuffer {
  upscaleLong: number;
  ceilingClamped: boolean;
  derived: number;
}

/**
 * Per-chunk Stage B pre-crop upscale-buffer derivation (ADR-0005):
 *   upscaleLong = min(12000, max(max(W, H) * 2, ceil(N_frames * 9)))
 *
 * The multiplier 9 ≈ the integer-pixel-step comfortable margin at z = 1.275
 * (≥ 1.5 px/frame at the slowest point of the ramp). The 12000 ceiling caps
 * working-buffer memory at the long tail; the max(W,H)*2 floor keeps short
 * chunks from deriving a buffer below output resolution, which would make
 * the pre-crop scale a downscale and feed undersampled pixels into crop.
 *
 * `ceilingClamped` distinguishes the ceiling case (possible quality
 * degradation — should be logged) from the floor case (silent — the floor
 * protects filter preconditions, not perceived quality).
 */
export function deriveZoomBuffer(
  frames: number,
  width: number,
  height: number
): ZoomBuffer {
  const derived = Math.ceil(frames * 9);
  const floor = Math.max(width, height) * 2;
  const upscaleLong = Math.min(12000, Math.max(floor, derived));
  return { upscaleLong, ceilingClamped: derived > 12000, derived };
}

/**
 * Build the ffmpeg argv for rendering one image-chunk still into a zoom-in
 * video segment via pre-upscale + zoompan. Non-last segments are extended by
 * CROSSFADE_SECONDS so the image xfade chain in Stage CD absorbs the overlap
 * without shortening visible content. Spec §13.3 (Stage B); ADR-0005 for the
 * per-chunk upscale-buffer derivation.
 *
 * ADR-0005's filter swap to `crop=…:eval=frame, scale=W:H:flags=lanczos` was
 * reverted: ffmpeg's `crop` filter has no `eval` option (its w/h expressions
 * are init-only — only x/y re-evaluate per frame), so the chain errored at
 * "Option not found" before doing any work. The load-bearing fix from
 * ADR-0005 is the buffer derivation, which is filter-agnostic and retained.
 */
export function buildSegmentArgs(opts: SegmentArgsOpts): string[] {
  const {
    imagePath,
    chunkDuration,
    isLast,
    width,
    height,
    framerate,
    outPath,
    motion,
    drawOnClipPath,
  } = opts;

  const renderDur = isLast ? chunkDuration : chunkDuration + CROSSFADE_SECONDS;

  // Draw-on branch — FIRST so the cinematic motion code below is only
  // reachable when drawOnClipPath is undefined. This keeps the
  // ken_burns + static `-vf` regression pins byte-identical: the gate
  // is the literal absence of this field, not a value check.
  //
  // Inputs differ from the cinematic path: no `-loop 1` because the
  // draw-on clip is already a video, and the clip is the only `-i`.
  // `-t` is exactly `chunkDuration` (NOT `renderDur`) and the `-vf`
  // chain is just `scale + format=yuv420p` — no `tpad`. Phase 10's
  // Stage CD concat-demuxer hard-cuts segments together with no
  // crossfade overlap, so there is no last-frame tail to pad. The
  // CLI's `hold_sec` (Phase 9) keeps the fully-drawn image visible for
  // the last ~2s of each clip; the hard cut to the next clip's first
  // frame happens at exactly `chunkDuration`.
  if (drawOnClipPath !== undefined) {
    return [
      "-i",
      drawOnClipPath,
      "-t",
      String(chunkDuration),
      "-vf",
      // flags=lanczos — Magnific Nano Banana 2 Flash emits 800×447 PNGs,
      // and the draw-on stage renders the clip at source dims, so this
      // scale is a ~2.4× linear / ~5.8× area upscale of high-contrast
      // doodle linework. Default ffmpeg scaling (bilinear/bicubic) softens
      // edges; lanczos preserves them visibly. The cinematic branch (line
      // 257 below) already uses lanczos per ADR-0005; this aligns the
      // draw-on branch with the same quality contract. Helps every existing
      // 800×447 source video that's re-rendered (no Magnific re-gen needed).
      `scale=${width}:${height}:flags=lanczos,format=yuv420p`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "18",
      outPath,
    ];
  }

  let vf: string;
  if (motion === "static") {
    // No zoompan → no pre-upscale headroom needed; deriveZoomBuffer is
    // intentionally NOT called on this path. The chain collapses to a
    // direct scale-to-W:H + yuv420p, which is what `loop=1 -t renderDur`
    // pipes into x264 to produce a still-frame segment.
    vf = `scale=${width}:${height},format=yuv420p`;
  } else {
    // ken_burns: byte-identical to the pre-motion-param baseline pinned
    // in render.test.ts ("ken_burns regression pin"). Pre-upscale buffer
    // (deriveZoomBuffer) → zoompan linear ramp 1.0 → ZOOM_TARGET → yuv420p.
    const frames = Math.round(renderDur * framerate);
    const { upscaleLong } = deriveZoomBuffer(frames, width, height);
    vf = [
      `scale=${upscaleLong}:-1`,
      `zoompan=z='1.0+(${ZOOM_TARGET}-1.0)*on/${frames}':d=${frames}:s=${width}x${height}:fps=${framerate}`,
      `format=yuv420p`,
    ].join(",");
  }

  return [
    "-loop", "1",
    "-i", imagePath,
    "-t", String(renderDur),
    "-vf", vf,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "18",
    outPath,
  ];
}

export interface XfadeGraph {
  inputs: string[];
  filterComplex: string;
}

export interface XfadeGraphOpts {
  /**
   * Index of the first segment input in the caller's overall input list.
   * Default `0` (segments are inputs `[0:v]…[N-1:v]`). Set to `1` (or more)
   * when the caller prepends other inputs — fused Stage CD prepends the
   * clip stream at `[0:v]` and asks for `inputOffset: 1` so segment slots
   * become `[1:v]…[N:v]`.
   */
  inputOffset?: number;
  /**
   * Label of the chain's final output. Default `[vout]`. Fused Stage CD
   * passes `[vimage]` so the caller can xfade `[vclip]` against `[vimage]`
   * downstream in the same filter graph.
   */
  outputLabel?: string;
}

/**
 * Build the xfade filter graph that chains N segment files with crossfade
 * transitions. Each transition uses `transition=fade` with
 * `duration=CROSSFADE_SECONDS`.
 *
 * Offset for transition i = cumulative chunk duration through segment i.
 * Each non-last segment is rendered with D_i + CF content, so
 * offset_i = R_i - CF = D_i (first), then cascades as cumSum(D).
 *
 * Spec §13.2 (The crossfade duration math).
 */
export function buildXfadeFilterGraph(
  segPaths: string[],
  chunkDurations: number[],
  opts: XfadeGraphOpts = {}
): XfadeGraph {
  const inputOffset = opts.inputOffset ?? 0;
  const outputLabel = opts.outputLabel ?? "[vout]";
  const inputs = segPaths.flatMap((p) => ["-i", p]);

  if (segPaths.length <= 1) {
    return { inputs, filterComplex: "" };
  }

  // Normalize each disk segment input's timebase to AVTB before xfade.
  // MP4 inputs come in at container timebase 1/(framerate × 512); xfade's
  // chain output uses a different (framerate-derived) timebase. Without
  // explicit settb on every disk input, mid-chain xfades reject with
  // "input link timebases do not match" whenever filter-graph reinit
  // runs (NVENC's pixfmt negotiation is the known trigger; libx264 happens
  // to skip reinit and silently masks the bug). AVTB is the universal
  // common-timebase choice for filter graphs.
  const tbParts = segPaths.map(
    (_, i) => `[${inputOffset + i}:v]settb=AVTB[seg${i}]`
  );

  const CF = CROSSFADE_SECONDS;
  const xfadeParts: string[] = [];
  let cumDur = 0;

  for (let i = 0; i < segPaths.length - 1; i++) {
    cumDur += chunkDurations[i];
    // Each non-last segment is rendered with D_i + CF content. The xfade
    // offset for transition i is where in the *output* timeline the fade
    // begins. For a chain: offset_i = R_i - CF = (D_i + CF) - CF = D_i
    // (first), then offset_i = prev_output - CF = cumSum(D) (subsequent).
    // In all cases: offset = cumulative chunk duration, no CF subtraction.
    const offset = cumDur;

    const inLabel = i === 0 ? `[seg0]` : `[v${i}]`;
    const outLabel =
      i === segPaths.length - 2 ? outputLabel : `[v${i + 1}]`;

    xfadeParts.push(
      `${inLabel}[seg${i + 1}]xfade=transition=fade:duration=${CF}:offset=${offset}${outLabel}`
    );
  }

  return { inputs, filterComplex: [...tbParts, ...xfadeParts].join(";") };
}

export interface ClipArgsOpts {
  sourcePath: string;
  outPath: string;
  /**
   * Seconds to pad with a held last frame (chunk audio span − source clip
   * duration). Caller is responsible for clamping ≤ 0 to 0; the helper
   * skips the tpad filter when `padSeconds < 1/framerate` (sub-frame pads
   * are meaningless).
   */
  padSeconds: number;
  framerate: number;
}

/**
 * Build the ffmpeg argv for rendering one clip chunk's source clip into
 * a per-chunk timed clip. If `padSeconds` is at least one frame interval
 * (`1/framerate`), the video stream is extended via
 * `tpad=stop_mode=clone:stop_duration=padSeconds` — holding the clip's
 * last frame to cover the audio that outlasts the provider-emitted clip.
 * Below threshold the source is passthrough re-encoded (no filter).
 *
 * Source resolution / SAR / framerate / pixel format are preserved;
 * Stage CD's clip-side normalize handles cross-shape reconciliation with
 * the image stream before the clip→image xfade. See ADR-0001 for why this
 * binding lives in the renderer rather than in the video-provider
 * interface.
 */
export function buildClipArgs(opts: ClipArgsOpts): string[] {
  const { sourcePath, outPath, padSeconds, framerate } = opts;
  const frameInterval = 1 / framerate;
  const args = ["-i", sourcePath];
  if (padSeconds >= frameInterval) {
    args.push(
      "-vf",
      `tpad=stop_mode=clone:stop_duration=${padSeconds}`
    );
  }
  args.push(
    "-an",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "20",
    outPath
  );
  return args;
}

/**
 * Find a chunk's asset file by basename, regardless of extension.
 * Accepts a pre-read file list to avoid calling readdirSync per chunk.
 * Returns the full path if found, null otherwise.
 */
function findChunkAsset(
  dir: string,
  files: string[],
  chunkId: string
): string | null {
  const match = files.find(
    (f) => f.startsWith(chunkId + ".") && !f.endsWith(".json")
  );
  return match ? join(dir, match) : null;
}

function listDir(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

/**
 * Run tasks with bounded concurrency. Rejects with the first task error
 * and stops scheduling new ones; in-flight siblings are left to settle on
 * their own (orchestrator AbortSignal kills the underlying processes).
 */
function runWithConcurrency(
  tasks: Array<() => void | Promise<void>>,
  concurrency: number
): Promise<void> {
  if (tasks.length === 0) return Promise.resolve();

  let nextIndex = 0;
  let stopped = false;
  let finished = 0;

  return new Promise<void>((resolve, reject) => {
    function spawn(): void {
      if (stopped) return;
      if (nextIndex >= tasks.length) return;
      const idx = nextIndex++;
      Promise.resolve()
        .then(() => tasks[idx]())
        .then(
          () => {
            if (stopped) return;
            finished++;
            if (finished === tasks.length) {
              resolve();
            } else {
              spawn();
            }
          },
          (err) => {
            if (stopped) return;
            stopped = true;
            reject(err);
          }
        );
    }

    const initial = Math.min(concurrency, tasks.length);
    for (let i = 0; i < initial; i++) spawn();
  });
}

// ─── Full render orchestration ─────────────────────────────────────────

export interface RenderDeps {
  projectsDir: string;
  aspectRatio: string;
  longEdgePx: number;
  framerate: number;
  /**
   * Stage CD encoder selection (ADR-0004). Stages A and B keep their
   * existing libx264 args; only Stage CD's three re-encoding sub-cases
   * route through `getEncoderArgs(videoEncoder)`.
   */
  videoEncoder: VideoEncoder;
  /**
   * Per-image motion mode for the Stage B segment build. Read once from
   * `render_image_motion` by the worker step and passed in — keeps render
   * pure (no DB import) and matches the dependency-injection shape of
   * `exec` / `probe` / `log`.
   */
  motion: RenderImageMotion;
  /**
   * Per-render reveal mode resolved from the workflow snapshot's
   * `image_style`. `"draw_on"` routes every image chunk's Stage B segment
   * through `clips_drawn/<id>.mp4` (produced upstream by `draw_on_images`)
   * and the precheck switches from images/ to clips_drawn/. `"none"` keeps
   * the cinematic-still path byte-identical. Required so the choice is
   * explicit at every call site — same shape as `motion`.
   */
  revealEffect: "none" | "draw_on";
  /**
   * Pre-render health probe for the draw-on Python interpreter. Called
   * once during the precheck when `revealEffect === "draw_on"`. The
   * worker step builds it as a closure over the resolved python path so
   * `render` stays decoupled from the resolver. Optional because the
   * cinematic path never needs it — when `revealEffect === "none"` the
   * field is ignored entirely. When provided AND revealEffect === "draw_on",
   * the precheck awaits this before any ffmpeg work.
   */
  drawOnHealthCheck?: () => Promise<void>;
  /**
   * Run one ffmpeg invocation. Async so production can use `spawn` with
   * an AbortSignal — when the orchestrator cancels mid-render, the in-flight
   * child process is killed instead of running to completion. Tests can
   * still pass `vi.fn()` (returns undefined → resolved promise).
   */
  exec: (args: string[]) => void | Promise<void>;
  /**
   * Read a media file's duration in seconds. Production uses ffprobe;
   * tests mock with `vi.fn().mockResolvedValue(...)`. Stage CD uses this
   * to align the clip→image xfade offset to the *actual* clip concat
   * duration — chunker target + sentence-boundary snapping means the
   * real value is only knowable post-concat.
   */
  probe: (path: string) => Promise<number>;
  log: (message: string) => void;
}

/**
 * Render the final video for a project. Orchestrates Stages A, B, CD, E
 * from the spec (§13.3 Pipeline).
 */
export async function render(
  videoId: string,
  deps: RenderDeps
): Promise<void> {
  const {
    projectsDir,
    aspectRatio,
    longEdgePx,
    framerate,
    videoEncoder,
    motion,
    revealEffect,
    drawOnHealthCheck,
    exec,
    probe,
    log,
  } = deps;
  const projectDir = resolve(projectsDir, videoId);
  const renderDir = join(projectDir, "render");
  const { width, height } = computeResolution(aspectRatio, longEdgePx);

  // Setup: delete render/ (spec :573)
  rmSync(renderDir, { recursive: true, force: true });
  mkdirSync(renderDir, { recursive: true });

  // Read chunks
  const chunks: Chunk[] = JSON.parse(
    readFileSync(join(projectDir, "chunks", "chunks.json"), "utf-8")
  );
  const clipChunks = chunks.filter((c) => c.kind === "clip");
  const imageChunks = chunks.filter((c) => c.kind === "image");

  // Pre-read asset directories once so we don't readdirSync per chunk
  const imageDir = join(projectDir, "images");
  const imageFiles = listDir(imageDir);
  const clipDir = join(projectDir, "videos", "clip");
  const clipFiles = listDir(clipDir);
  const clipsDrawnDir = join(projectDir, "clips_drawn");

  // Render precheck: refuse to render when any image-chunk's expected
  // input is absent on disk. Spec §13.4's placeholder fallback (a black
  // "MISSING" frame) silently substituted in production and was then
  // masked by the cleanup step wiping intermediates — see the structural-
  // safety baseline PR.
  //
  // The required file per chunk depends on the reveal effect:
  //   - `"draw_on"`: clips_drawn/<id>.mp4 (the per-image draw-on clip
  //      produced by the upstream `draw_on_images` step). Stage B
  //      consumes the clip directly via `drawOnClipPath`; the still PNG
  //      is irrelevant by render time.
  //   - `"none"` (cinematic): images/<id>.<ext> (the still that Stage B
  //      loops + zoompans). Pre-Phase-7 behavior, byte-identical.
  //
  // Clip-chunk missing is intentionally NOT covered here — Stage A's
  // existing `Missing clip video for <id>` throw still handles that
  // (pinned by the "precheck does NOT cover clip-missing" test).
  if (revealEffect === "draw_on") {
    const missingDraws = imageChunks
      .filter((c) => !existsSync(join(clipsDrawnDir, `${c.id}.mp4`)))
      .map((c) => c.id);
    if (missingDraws.length > 0) {
      throw new RenderPrecheckError(
        `Render precheck failed (draw-on): missing clip files for ${missingDraws.join(", ")}`,
        missingDraws
      );
    }
    // Health-check the Python interpreter that produced clips_drawn/.
    // Defense-in-depth: the upstream draw_on_images step already had to
    // succeed for the clip files above to exist, so the catatonic-Python
    // case only arises when the .venv vanishes between steps. Awaited
    // here so a half-broken environment surfaces before any ffmpeg work.
    if (drawOnHealthCheck) {
      await drawOnHealthCheck();
    }
  } else {
    const missingImages = imageChunks
      .filter((c) => findChunkAsset(imageDir, imageFiles, c.id) === null)
      .map((c) => c.id);
    if (missingImages.length > 0) {
      throw new RenderPrecheckError(
        `Render precheck failed: missing image files for ${missingImages.join(", ")}`,
        missingImages
      );
    }
  }

  // ── Stages A and B run in parallel ────────────────────────────────
  // They share no inputs and write to disjoint output trees; Stage CD/E
  // consume the outputs post-join.

  const [clipFinalPath, { segPaths, imageDurations }] = await Promise.all([
    (async () => {
      // ── Stage A — Clip concat ──────────────────────────────────────
      const clipFinalPath = join(renderDir, "clip_final.mp4");
      if (clipChunks.length === 0) return clipFinalPath;

      const clipConcatPath = join(renderDir, "clip_concat.mp4");

      // Per-chunk audio-video binding (ADR 0001): for each clip chunk,
      // probe its source clip and pad the video to cover the chunk's audio
      // span when the clip is too short. V > A is intentionally left
      // unfixed; see the follow-up note in docs/research/2026-05-12-audio-media-sync.md.
      const timedPaths: string[] = [];
      for (const c of clipChunks) {
        const sourcePath = findChunkAsset(clipDir, clipFiles, c.id);
        if (!sourcePath) {
          throw new Error(
            `Missing clip video for ${c.id} — cannot produce correct clip segment`
          );
        }
        const sourceDuration = await probe(sourcePath);
        const audioSpan = c.end - c.start;
        const padSeconds = Math.max(0, audioSpan - sourceDuration);
        const timedPath = join(renderDir, `${c.id}_timed.mp4`);
        timedPaths.push(timedPath);

        if (padSeconds >= 1 / framerate) {
          log(
            `Padded ${c.id}: V=${sourceDuration.toFixed(3)}s, A=${audioSpan.toFixed(3)}s, +${padSeconds.toFixed(3)}s last-frame`
          );
        }

        await exec(
          buildClipArgs({
            sourcePath,
            outPath: timedPath,
            padSeconds,
            framerate,
          })
        );
      }

      // Write concat demuxer list pointing at the per-chunk timed clips
      const clipListPath = join(renderDir, "clip_list.txt");
      const clipLines = timedPaths.map(
        (p) => `file '${p.replace(/\\/g, "/")}'`
      );
      writeFileSync(clipListPath, clipLines.join("\n") + "\n");

      // The held-frame tail exists only to feed Stage CD's clip→image
      // crossfade. In the clips-only topology (no image chunks) there is
      // no xfade to bridge to, so the tail and its second concat are
      // skipped — the initial concat writes clip_final.mp4 directly.
      const needsTail = imageChunks.length > 0;

      // Concat clip pieces (no crossfade)
      await exec([
        "-f", "concat", "-safe", "0",
        "-i", clipListPath,
        "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        needsTail ? clipConcatPath : clipFinalPath,
      ]);

      if (!needsTail) return clipFinalPath;

      // Append last-frame still for CF seconds (crossfade tail)
      const clipTailPath = join(renderDir, "clip_tail.mp4");
      await exec([
        "-sseof", `-${CROSSFADE_SECONDS}`,
        "-i", clipConcatPath,
        "-vframes", "1",
        "-vf", `loop=loop=${Math.round(CROSSFADE_SECONDS * framerate)}:size=1:start=0,setpts=N/${framerate}/TB,format=yuv420p`,
        "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        clipTailPath,
      ]);

      // Concat clip_concat + clip_tail
      const clipFinalListPath = join(renderDir, "clip_final_list.txt");
      writeFileSync(
        clipFinalListPath,
        `file '${clipConcatPath.replace(/\\/g, "/")}'\nfile '${clipTailPath.replace(/\\/g, "/")}'\n`
      );
      await exec([
        "-f", "concat", "-safe", "0",
        "-i", clipFinalListPath,
        "-an", "-c:v", "copy",
        clipFinalPath,
      ]);

      return clipFinalPath;
    })(),
    (async () => {
      // ── Stage B — Per-segment renders ──────────────────────────────
      // Segments share no inputs and write to disjoint outputs — safe to
      // render up to SEGMENT_CONCURRENCY in parallel.
      const segPaths: string[] = [];
      const imageDurations: number[] = [];
      const segmentTasks: Array<() => void | Promise<void>> = [];

      for (let i = 0; i < imageChunks.length; i++) {
        const chunk = imageChunks[i];
        const duration = chunk.end - chunk.start;
        imageDurations.push(duration);
        const isLast = i === imageChunks.length - 1;
        const padded = String(i + 1).padStart(3, "0");
        const segPath = join(renderDir, `segment_${padded}.mp4`);
        segPaths.push(segPath);

        // Draw-on branch: route the segment through the pre-rendered
        // clip in clips_drawn/. The precheck above already verified the
        // file's existence (and ran the python health check) — Stage B
        // just builds the FFmpeg args via the draw-on early-return in
        // buildSegmentArgs. The cinematic motion branches below are
        // unreachable on this path, so the still-PNG lookup + buffer-cap
        // warning are skipped entirely.
        if (revealEffect === "draw_on") {
          const drawOnClipPath = join(clipsDrawnDir, `${chunk.id}.mp4`);
          segmentTasks.push(() =>
            exec(
              buildSegmentArgs({
                // imagePath is required on the type for the cinematic
                // branch but ignored by the draw-on early-return. Pass
                // the clip path so a stray fall-through would at least
                // reference a real file in error messages.
                imagePath: drawOnClipPath,
                chunkDuration: duration,
                isLast,
                width,
                height,
                framerate,
                outPath: segPath,
                motion,
                drawOnClipPath,
              })
            )
          );
          continue;
        }

        const imagePath = findChunkAsset(imageDir, imageFiles, chunk.id);
        if (imagePath === null) {
          // Unreachable in practice: the render precheck (above the
          // Promise.all) throws on any missing image. Kept as a TypeScript
          // narrowing throw and a regression backstop so a precheck
          // regression surfaces loudly here instead of NPE-ing inside
          // buildSegmentArgs.
          throw new RenderPrecheckError(
            `invariant: image for ${chunk.id} disappeared after precheck`,
            [chunk.id]
          );
        }
        // The Stage B buffer-cap warning is meaningful only when the
        // zoom path actually runs — derive + log gated on motion. On the
        // static path deriveZoomBuffer is never invoked (its sole purpose
        // is feeding the zoompan headroom that no longer exists).
        if (motion === "ken_burns") {
          const renderDur = isLast ? duration : duration + CROSSFADE_SECONDS;
          const frames = Math.round(renderDur * framerate);
          const { ceilingClamped, derived } = deriveZoomBuffer(
            frames,
            width,
            height
          );
          if (ceilingClamped) {
            log(
              `Stage B buffer capped at 12000 for chunk ${chunk.id} (N_frames=${frames}, derived=${derived})`
            );
          }
        }
        segmentTasks.push(() =>
          exec(
            buildSegmentArgs({
              imagePath,
              chunkDuration: duration,
              isLast,
              width,
              height,
              framerate,
              outPath: segPath,
              motion,
            })
          )
        );
      }

      await runWithConcurrency(segmentTasks, SEGMENT_CONCURRENCY);
      return { segPaths, imageDurations };
    })(),
  ]);

  // ── Stage CD — Fused image xfade chain + clip→image crossfade ─────
  // Single ffmpeg invocation replaces the previous Stage C (image concat
  // → image_concat.mp4) and Stage D (clip→image xfade → video_only.mp4).
  // Eliminates one full re-encode of the long timeline plus the
  // image_concat.mp4 intermediate. Five sub-cases below, keyed on
  // (clip count, image count): two stream-copy paths (1 image + 0 clip;
  // ≥1 clip + 0 image) and three re-encoding paths (≥2 image + 0 clip;
  // 1 image + ≥1 clip; ≥2 image + ≥1 clip).

  const videoOnlyPath = join(renderDir, "video_only.mp4");
  const hasClips = clipChunks.length > 0;
  log(`Encoder: ${videoEncoder}`);

  if (!hasClips && segPaths.length === 1) {
    // Sub-case: 1 image + 0 clip — no filter graph, stream copy.
    // Hard-cut by definition (nothing to crossfade), so draw_on and none
    // share this path.
    await exec(["-i", segPaths[0], "-c", "copy", videoOnlyPath]);
  } else if (!hasClips && revealEffect === "draw_on") {
    // Sub-case: ≥2 image + 0 clip, doodle — hard-cut concat. Segments
    // are already W×H/framerate/yuv420p/libx264 from buildSegmentArgs'
    // draw-on branch, so stream-copy through ffmpeg's concat demuxer:
    // no re-encode, no xfade overlap, no filter graph. Same precedent
    // as sub-case 1 (1-image stream copy) which also bypasses the
    // videoEncoder setting because no transform is needed.
    const concatListPath = join(renderDir, "draw_on_concat_list.txt");
    const concatLines = segPaths.map(
      (p) => `file '${p.replace(/\\/g, "/")}'`
    );
    writeFileSync(concatListPath, concatLines.join("\n") + "\n");
    await exec([
      "-f", "concat", "-safe", "0",
      "-i", concatListPath,
      "-an", "-c:v", "copy",
      videoOnlyPath,
    ]);
  } else if (!hasClips) {
    // Sub-case: ≥2 image + 0 clip — image xfade chain only, encode
    // directly to video_only.mp4 (no image_concat intermediate).
    const graph = buildXfadeFilterGraph(segPaths, imageDurations);
    await exec([
      ...graph.inputs,
      "-filter_complex", graph.filterComplex,
      "-map", "[vout]",
      ...getEncoderArgs(videoEncoder),
      videoOnlyPath,
    ]);
  } else if (segPaths.length === 0) {
    // Sub-case: ≥1 clip + 0 image (clips-only topology) — clip_final.mp4
    // is the entire video. Stream-copy to video_only.mp4; the xfade
    // chain is bypassed (no image stream to bridge to, and Stage A
    // skipped the held-frame tail for the same reason).
    await exec(["-i", clipFinalPath, "-c", "copy", videoOnlyPath]);
  } else {
    // Clips present — probe clip_final for the clip→image xfade offset.
    // Chunker target + sentence-boundary snapping + provider clip-length
    // drift mean the real clip-section duration is only knowable
    // post-concat.
    const clipDuration = await probe(clipFinalPath);
    // Clips come from external generators (e.g. Google Flow at 1280x720,
    // 24fps) and may not match the configured target resolution, SAR,
    // framerate, or pixel format. xfade requires both inputs to share
    // resolution, pixel format, AND timebase, so the clip input is
    // normalized in front of the xfade. The image side is already
    // W×H/framerate/yuv420p by construction (buildSegmentArgs' zoompan
    // s=…:fps=… + format=yuv420p), so it skips normalization.
    const clipNorm =
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${framerate},` +
      `settb=AVTB,format=yuv420p[vclip]`;
    // Offset = clipDuration - CF so the fade window
    // [clipDuration - CF, clipDuration] lands inside clip_final, with
    // the last-frame tail consumed by the fade as Stage A's tail was
    // built to be.
    const xfadeOffset = clipDuration - CROSSFADE_SECONDS;

    // NOTE on revealEffect === "draw_on" for sub-cases 4 + 5 below:
    // doodle workflows seed with `video_provider: null` today, so a
    // doodle render NEVER has clipChunks — this branch is unreachable
    // for the canonical doodle path. If a future workflow combines
    // doodle image styles with hook clips, the image→image xfade chain
    // here would need a doodle-concat variant (and the clip→image
    // xfade-into-doodle transition would need its own decision). Left
    // deferred until that workflow exists; current behavior keeps the
    // xfade path even if the field is somehow set.
    if (segPaths.length === 1) {
      // Sub-case: 1 image + ≥1 clip — segment_001 is the image stream
      // directly at [1:v]; no image xfade chain. settb=AVTB on the
      // segment input matches [vclip]'s AVTB so the single xfade
      // doesn't trip the same timebase mismatch as the chain case.
      await exec([
        "-i", clipFinalPath,
        "-i", segPaths[0],
        "-filter_complex",
        `${clipNorm};[1:v]settb=AVTB[vimage1];` +
          `[vclip][vimage1]xfade=transition=fade:duration=${CROSSFADE_SECONDS}:offset=${xfadeOffset}[vout]`,
        "-map", "[vout]",
        ...getEncoderArgs(videoEncoder),
        videoOnlyPath,
      ]);
    } else {
      // Sub-case: ≥2 image + ≥1 clip — image xfade chain emits [vimage],
      // then crossfaded with [vclip]. Segments start at input slot 1
      // because [0:v] is the clip stream.
      const graph = buildXfadeFilterGraph(segPaths, imageDurations, {
        inputOffset: 1,
        outputLabel: "[vimage]",
      });
      await exec([
        "-i", clipFinalPath,
        ...graph.inputs,
        "-filter_complex",
        `${clipNorm};${graph.filterComplex};` +
          `[vclip][vimage]xfade=transition=fade:duration=${CROSSFADE_SECONDS}:offset=${xfadeOffset}[vout]`,
        "-map", "[vout]",
        ...getEncoderArgs(videoEncoder),
        videoOnlyPath,
      ]);
    }
  }

  // ── Stage E — Mux audio ────────────────────────────────────────────

  const audioPath = join(projectDir, "audio", "narration.mp3");
  const finalPath = join(projectDir, "final.mp4");
  await exec([
    "-i", videoOnlyPath,
    "-i", audioPath,
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    finalPath,
  ]);
}
