import type { Database as DatabaseType } from "better-sqlite3";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Step } from "@/worker/pipeline";
import { getEncoderArgs } from "@/lib/render";
import { getSetting } from "@/lib/settings";

/**
 * Final-output scale + pad + setsar applied to the xfade chain. The
 * Magnific clip is usually 16:9 but not always 1920×1080 (Seedance
 * historically produces 864×496 or similar mid-resolution outputs); the
 * pad-to-decrease keeps source aspect without distortion.
 */
const FINAL_VF =
  "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1";

/**
 * Test-only injection surface — mirrors the 14-render.ts shape. `exec` lets
 * tests verify the assembled ffmpeg args without spawning a real process;
 * `probe` lets tests pin the loop clip's duration without spawning ffprobe;
 * `signal` is wired into the default exec / probe so a delete mid-render
 * kills the child (`project_long_running_step_cancellation`).
 */
export interface RenderMusicVideoDeps {
  db?: DatabaseType;
  projectsDir?: string;
  exec?: (args: string[]) => void | Promise<void>;
  probe?: (path: string) => Promise<number>;
  signal?: AbortSignal;
}

/**
 * Signal-aware ffmpeg spawn. Same shape as 14-render.ts and make-thumbnail.ts
 * — kept inline rather than extracted because the three sites diverge on
 * args composition and inlining keeps each step file self-contained.
 */
function buildFfmpegExec(
  signal?: AbortSignal
): (args: string[]) => Promise<void> {
  return (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn("ffmpeg", ["-y", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        signal,
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 64 * 1024) stderr += chunk.toString("utf-8");
      });
      child.on("error", (err) => reject(err));
      child.on("exit", (code, sig) => {
        if (code === 0) {
          resolve();
          return;
        }
        const tail = stderr.trim().split("\n").slice(-20).join(" | ");
        reject(
          new Error(
            `ffmpeg exited with ${code === null ? `signal=${sig}` : `code=${code}`}: ${tail}`
          )
        );
      });
    });
}

/**
 * Signal-aware ffprobe wrapper — returns the media file's duration in
 * seconds. Same shape as 14-render.ts's `buildFfprobeExec`; inlined here
 * for the same reason `buildFfmpegExec` is.
 */
function buildFfprobeExec(
  signal?: AbortSignal
): (path: string) => Promise<number> {
  return (path: string) =>
    new Promise<number>((resolve, reject) => {
      const child = spawn(
        "ffprobe",
        [
          "-v", "error",
          "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1",
          path,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          signal,
        }
      );
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 64 * 1024) stderr += chunk.toString("utf-8");
      });
      child.on("error", (err) => reject(err));
      child.on("exit", (code, sig) => {
        if (code !== 0) {
          const tail = stderr.trim().split("\n").slice(-3).join(" | ");
          reject(
            new Error(
              `ffprobe exited with ${code === null ? `signal=${sig}` : `code=${code}`}: ${tail}`
            )
          );
          return;
        }
        const duration = parseFloat(stdout);
        if (Number.isNaN(duration)) {
          reject(
            new Error(
              `ffprobe returned non-numeric duration for ${path}: ${stdout.trim() || "(empty)"}`
            )
          );
          return;
        }
        resolve(duration);
      });
    });
}

/**
 * Phase 2.4 music-video step: mux the looped real Magnific clip with a
 * silent stereo audio track into final.mp4. Duration = song_count ×
 * repeat_factor seconds — the Plan-1 download_music stub writes 1-second
 * silent WAVs per song so the math works out for the silent-audio gate;
 * Plan 3 Phase 3.3 swaps the audio source to the concat of downloaded
 * Suno songs.
 *
 * Two ffmpeg invocations:
 *
 *   1. Pre-trim re-encode: ffprobe `loop_clip.mp4` for its duration, then
 *      re-encode `loop_clip.mp4` → `build/loop_clip_trimmed.mp4` with
 *      `-t (clipDur - music_video_loop_trim_tail_seconds)`. The re-encode
 *      is required because `-c copy -t T` would cut at the nearest
 *      keyframe and typically overshoot/undershoot the precise frame
 *      target. A single-pass attempt that combined `-stream_loop -1`
 *      with an input-level `-t` was empirically rejected: ffmpeg treats
 *      the input-level `-t` as a TOTAL read cap (not per-loop), so the
 *      output ended up with ~one iteration's worth of frames padded out
 *      to the wall-clock duration in container metadata.
 *
 *   2. xfade-chained mux: open the trimmed clip as N separate `-i`
 *      inputs, chain `xfade=transition=fade:duration=
 *      music_video_loop_xfade_seconds` between each consecutive pair,
 *      scale-pad-setsar the chain output to 1920×1080, mux with anullsrc
 *      audio, and `-t totalSeconds` pin. N is sized so the chain length
 *      exceeds totalSeconds even after the xfade overlaps eat into
 *      per-iteration unique time. `-stream_loop -1` is not usable here:
 *      xfade is a 2-input filter and the chain needs N distinct input
 *      streams. When the operator dials xfade to 0, pass 2 collapses to
 *      a plain `-stream_loop -1` mux of the trimmed clip — ffmpeg's
 *      xfade filter rejects duration=0.
 *
 * Loop-seam mitigation rationale: Magnific Seedance treats `last_frame`
 * as a soft target — the rendered clip's final ~5-10 frames drift away
 * from the static end-frame guidance, producing a visible seam at every
 * loop boundary. The trim removes the drifted frames; the xfade hides
 * whatever single-frame discontinuity is left between consecutive
 * trimmed iterations. The two tunables live in DB settings
 * (`music_video_loop_trim_tail_seconds`, `music_video_loop_xfade_seconds`)
 * so an operator can dial each knob from the Magnific tab without code edits.
 *
 * Idempotent on re-entry: skip-and-return if final.mp4 already exists,
 * so a crash-resume after Magnific delivered both artifacts doesn't
 * re-render. The intermediate trimmed clip is overwritten unconditionally
 * (`-y`) on each call so a partial prior run doesn't pollute the next.
 */
export async function runRenderMusicVideo(
  videoId: string,
  deps: RenderMusicVideoDeps
): Promise<void> {
  if (!deps.db) {
    throw new Error("render_music_video requires a database connection");
  }
  const projectsDir =
    deps.projectsDir ?? process.env.PROJECTS_DIR ?? "./projects";

  const projDir = join(projectsDir, videoId);
  const finalPath = join(projDir, "final.mp4");
  if (existsSync(finalPath)) return;

  const row = deps.db
    .prepare("SELECT song_count, repeat_factor FROM videos WHERE id = ?")
    .get(videoId) as
    | { song_count: number | null; repeat_factor: number | null }
    | undefined;
  if (!row) {
    throw new Error(`No video found for id ${videoId}`);
  }
  if (row.song_count === null || row.song_count === undefined) {
    throw new Error(
      `Video ${videoId} has no song_count — music_video rows must carry one`
    );
  }
  if (row.repeat_factor === null || row.repeat_factor === undefined) {
    throw new Error(
      `Video ${videoId} has no repeat_factor — music_video rows must carry one`
    );
  }

  mkdirSync(projDir, { recursive: true });
  const buildDir = join(projDir, "build");
  mkdirSync(buildDir, { recursive: true });

  const totalSeconds = row.song_count * row.repeat_factor;
  const videoEncoder = getSetting("video_encoder", deps.db);
  const trimTailSeconds = getSetting(
    "music_video_loop_trim_tail_seconds",
    deps.db
  );
  const xfadeSeconds = getSetting("music_video_loop_xfade_seconds", deps.db);
  const loopClipPath = join(projDir, "loop_clip.mp4");
  const trimmedClipPath = join(buildDir, "loop_clip_trimmed.mp4");

  const probe = deps.probe ?? buildFfprobeExec(deps.signal);
  const clipDuration = await probe(loopClipPath);
  // Guard: a clip shorter than the trim amount would yield -t <= 0 and
  // ffmpeg would write zero frames. Fall back to no trim so the render
  // still produces output (a tiny test fixture or a Magnific misfire
  // should not block the step).
  const trimmedDuration =
    clipDuration > trimTailSeconds
      ? clipDuration - trimTailSeconds
      : clipDuration;

  const exec = deps.exec ?? buildFfmpegExec(deps.signal);

  // Pass 1 — pre-trim re-encode. Output-side `-t` is frame-precise
  // because we're re-encoding (libx264 / NVENC honor the cutoff to the
  // frame, unlike `-c copy` which snaps to keyframes). `-an` drops any
  // audio track Magnific might've left in the clip; the mux supplies its
  // own audio via anullsrc.
  await exec([
    "-i", loopClipPath,
    "-an",
    "-t", trimmedDuration.toFixed(3),
    ...getEncoderArgs(videoEncoder),
    trimmedClipPath,
  ]);

  // Pass 2 — xfade=0 escape hatch. The operator turned off the
  // cross-blend, so collapse to a plain `-stream_loop` mux. ffmpeg's
  // xfade filter errors on duration=0, so we cannot just pass the
  // value through. The trimmed clip already has Seedance's drift tail
  // removed; without xfade the seam is a hard cut but at least the
  // post-trim discontinuity is the smallest one available.
  if (xfadeSeconds === 0) {
    await exec([
      "-stream_loop", "-1",
      "-i", trimmedClipPath,
      "-f", "lavfi",
      "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-vf", FINAL_VF,
      "-map", "0:v:0",
      "-map", "1:a:0",
      ...getEncoderArgs(videoEncoder),
      "-c:a", "aac",
      "-b:a", "192k",
      "-t", String(totalSeconds),
      finalPath,
    ]);
    return;
  }

  // Pass 2 — xfade-chained mux. Each chained xfade fades the tail of the
  // running chain into the head of the next trimmed-clip copy, so every
  // loop boundary in the output is a cross-blend rather than a hard cut.
  // Guard against pathological short trimmed clips by clamping
  // xfade ≤ half the trimmed duration (otherwise the offset arithmetic
  // gives a negative first-fade offset and ffmpeg rejects the graph).
  const xfadeDur = Math.min(xfadeSeconds, trimmedDuration / 2);
  const effectiveIterDur = trimmedDuration - xfadeDur;
  // +1 cushion: the last input also contributes its full duration (no
  // xfade after it). The `-t totalSeconds` truncates any leftover.
  const nIterations = Math.max(
    2,
    Math.ceil(totalSeconds / effectiveIterDur) + 1
  );

  // N video inputs (same trimmed clip opened N times — ffmpeg handles
  // this fine; each `-i` is its own demuxer instance), then the lavfi
  // audio input. Audio sits at input slot `nIterations`.
  const inputArgs: string[] = [];
  for (let i = 0; i < nIterations; i++) {
    inputArgs.push("-i", trimmedClipPath);
  }
  inputArgs.push(
    "-f", "lavfi",
    "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"
  );

  // settb=AVTB on every input normalizes timebases so the xfade chain
  // doesn't reject mid-graph on a "input link timebases do not match"
  // error — same precaution as `buildXfadeFilterGraph` in lib/render.ts.
  const tbParts: string[] = [];
  for (let i = 0; i < nIterations; i++) {
    tbParts.push(`[${i}:v]settb=AVTB[v${i}]`);
  }

  // Chain: xfade i (1-indexed) joins input i into the running chain.
  // Offset_i = i × (T - D) — the cumulative unique-time per iteration.
  // Final chain output is `[vchain]`, which then runs through FINAL_VF
  // to land at 1920×1080.
  const xfadeParts: string[] = [];
  for (let i = 0; i < nIterations - 1; i++) {
    const inLabel = i === 0 ? "[v0]" : `[x${i}]`;
    const outLabel = i === nIterations - 2 ? "[vchain]" : `[x${i + 1}]`;
    const offset = (i + 1) * effectiveIterDur;
    xfadeParts.push(
      `${inLabel}[v${i + 1}]xfade=transition=fade:duration=${xfadeDur.toFixed(3)}:offset=${offset.toFixed(3)}${outLabel}`
    );
  }

  const filterComplex = [
    ...tbParts,
    ...xfadeParts,
    `[vchain]${FINAL_VF}[vout]`,
  ].join(";");

  await exec([
    ...inputArgs,
    "-filter_complex", filterComplex,
    "-map", "[vout]",
    "-map", `${nIterations}:a:0`,
    ...getEncoderArgs(videoEncoder),
    "-c:a", "aac",
    "-b:a", "192k",
    "-t", String(totalSeconds),
    finalPath,
  ]);
}

export const step: Step = {
  name: "render_music_video",
  module: "music_video",
  label: "Render music video",
  description:
    "Muxes the looped Magnific clip with silent audio (Plan 2) or the concatenated Suno songs (Plan 3) into final.mp4.",
  inputs: ["loop_clip.mp4", "songs/"],
  outputs: ["final.mp4"],
  run(videoId, ctx) {
    return runRenderMusicVideo(videoId, {
      db: ctx.db,
      projectsDir: ctx.projectsDir,
      signal: ctx.signal,
    });
  },
};
