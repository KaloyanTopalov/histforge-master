import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  runRenderMusicVideo,
  step as renderMusicVideoStep,
} from "@/worker/steps/render-music-video";
import { setSetting } from "@/lib/settings";
import {
  cleanup,
  freshDb,
  tempDir,
} from "../../../helpers/step-fixtures";

afterEach(cleanup);

function seedMusicVideo(
  db: DatabaseType,
  videoId: string,
  opts: { song_count: number | null; repeat_factor: number | null }
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO videos
       (id, title, topic_info, workflow_id, status, kind, song_count, repeat_factor, created_at)
     VALUES (?, ?, '', ?, 'in_progress', 'music_video', ?, ?, ?)`
  ).run(
    videoId,
    "Test",
    "music-video-magnific-suno",
    opts.song_count,
    opts.repeat_factor,
    now
  );
}

function seedLoopClip(projectsDir: string, videoId: string): string {
  const projDir = join(projectsDir, videoId);
  mkdirSync(projDir, { recursive: true });
  const path = join(projDir, "loop_clip.mp4");
  writeFileSync(path, Buffer.from("fake-loop-clip-bytes"));
  return path;
}

describe("render_music_video (music-video)", () => {
  it("exports a Step with the music_video metadata contract", () => {
    expect(renderMusicVideoStep.name).toBe("render_music_video");
    expect(renderMusicVideoStep.module).toBe("music_video");
    expect(renderMusicVideoStep.inputs ?? []).toEqual([
      "loop_clip.mp4",
      "songs/",
    ]);
    expect(renderMusicVideoStep.outputs).toEqual(["final.mp4"]);
  });

  it("pre-trims then xfade-chain muxes the trimmed clip with anullsrc silent audio, scaled-and-padded to 1920x1080, output duration = song_count × repeat_factor", async () => {
    const db = freshDb();
    const projectsDir = tempDir("render-mv");
    const videoId = "v_render_real_01";
    seedMusicVideo(db, videoId, { song_count: 10, repeat_factor: 3 });
    const loopClipPath = seedLoopClip(projectsDir, videoId);
    setSetting("music_video_loop_trim_tail_seconds", 0.3, db);
    setSetting("music_video_loop_xfade_seconds", 0.2, db);
    const exec = vi.fn().mockResolvedValue(undefined);
    const probe = vi.fn().mockResolvedValue(5.0);

    await runRenderMusicVideo(videoId, { db, projectsDir, exec, probe });

    expect(probe).toHaveBeenCalledWith(loopClipPath);
    expect(exec).toHaveBeenCalledTimes(2);

    // --- Pass 1: pre-trim re-encode of loop_clip.mp4 → build/loop_clip_trimmed.mp4 ---
    const trimArgs = exec.mock.calls[0][0] as string[];
    const trimmedClipPath = join(
      projectsDir,
      videoId,
      "build",
      "loop_clip_trimmed.mp4"
    );
    expect(trimArgs[0]).toBe("-i");
    expect(trimArgs[1]).toBe(loopClipPath);
    expect(trimArgs).toContain("-an");
    // -t is the trimmed-duration target; for a 5.0s clip with 0.3s tail trim → 4.700
    const trimTIdx = trimArgs.indexOf("-t");
    expect(trimTIdx).toBeGreaterThanOrEqual(0);
    expect(trimArgs[trimTIdx + 1]).toBe("4.700");
    // Output of pass 1 is the trimmed clip path (last arg)
    expect(trimArgs[trimArgs.length - 1]).toBe(trimmedClipPath);

    // --- Pass 2: xfade-chain mux of the trimmed clip ---
    // trimmedDuration=4.7, xfadeDur=0.2, effectiveIterDur=4.5
    // nIterations = max(2, ceil(30/4.5)+1) = max(2, 7+1) = 8
    const muxArgs = exec.mock.calls[1][0] as string[];

    // Should NOT use -stream_loop (incompatible with xfade chain)
    expect(muxArgs).not.toContain("-stream_loop");

    // Should have 8 `-i trimmedClipPath` pairs followed by `-f lavfi -i anullsrc=...`
    const iIndices = muxArgs
      .map((arg, idx) => (arg === "-i" ? idx : -1))
      .filter((idx) => idx >= 0);
    expect(iIndices.length).toBe(9); // 8 video inputs + 1 audio input
    for (let i = 0; i < 8; i++) {
      expect(muxArgs[iIndices[i] + 1]).toBe(trimmedClipPath);
    }
    expect(muxArgs[iIndices[8] + 1]).toBe(
      "anullsrc=channel_layout=stereo:sample_rate=44100"
    );

    // Filter complex contains settb=AVTB for each input, an xfade chain
    // joining v0..v7, and the FINAL_VF scale-pad-setsar applied to [vchain].
    const fcIdx = muxArgs.indexOf("-filter_complex");
    expect(fcIdx).toBeGreaterThanOrEqual(0);
    const filterComplex = muxArgs[fcIdx + 1];
    for (let i = 0; i < 8; i++) {
      expect(filterComplex).toContain(`[${i}:v]settb=AVTB[v${i}]`);
    }
    // 7 xfade joints — first uses [v0][v1], last lands at [vchain]
    expect(filterComplex).toContain(
      "[v0][v1]xfade=transition=fade:duration=0.200:offset=4.500[x1]"
    );
    expect(filterComplex).toContain(
      "[x6][v7]xfade=transition=fade:duration=0.200:offset=31.500[vchain]"
    );
    expect(filterComplex).toContain(
      "[vchain]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[vout]"
    );

    // Mapping: -map [vout] (chain output) and -map 8:a:0 (audio input at slot 8)
    expect(muxArgs).toContain("[vout]");
    expect(muxArgs).toContain("8:a:0");

    // Encoder args from settings (default libx264)
    expect(muxArgs).toContain("-c:v");
    expect(muxArgs).toContain("libx264");
    expect(muxArgs).toContain("-preset");
    expect(muxArgs).toContain("medium");
    expect(muxArgs).toContain("-crf");
    expect(muxArgs).toContain("20");

    // Audio
    expect(muxArgs).toContain("-c:a");
    expect(muxArgs).toContain("aac");
    expect(muxArgs).toContain("-b:a");
    expect(muxArgs).toContain("192k");

    // Output-side -t = 10 × 3 = 30 (the wall-clock total).
    const muxTIdx = muxArgs.lastIndexOf("-t");
    expect(muxArgs[muxTIdx + 1]).toBe("30");

    // Last arg is the final.mp4 output path
    expect(muxArgs[muxArgs.length - 1]).toBe(
      join(projectsDir, videoId, "final.mp4")
    );
  });

  it("clamps the xfade duration to half the trimmed clip when the clip is very short", async () => {
    const db = freshDb();
    const projectsDir = tempDir("render-mv-xfade-clamp");
    const videoId = "v_render_xfade_01";
    seedMusicVideo(db, videoId, { song_count: 1, repeat_factor: 1 });
    seedLoopClip(projectsDir, videoId);
    setSetting("music_video_loop_trim_tail_seconds", 0.3, db);
    setSetting("music_video_loop_xfade_seconds", 0.2, db);
    const exec = vi.fn().mockResolvedValue(undefined);
    // 0.5s clip → 0.2s trimmed → xfade should clamp to 0.1 (half of 0.2)
    const probe = vi.fn().mockResolvedValue(0.5);

    await runRenderMusicVideo(videoId, { db, projectsDir, exec, probe });

    const muxArgs = exec.mock.calls[1][0] as string[];
    const fcIdx = muxArgs.indexOf("-filter_complex");
    const filterComplex = muxArgs[fcIdx + 1];
    expect(filterComplex).toContain("duration=0.100");
  });

  it("trims music_video_loop_trim_tail_seconds (0.3s) off the loop clip in the pre-trim pass", async () => {
    const db = freshDb();
    const projectsDir = tempDir("render-mv-trim");
    const videoId = "v_render_trim_01";
    seedMusicVideo(db, videoId, { song_count: 10, repeat_factor: 3 });
    seedLoopClip(projectsDir, videoId);
    setSetting("music_video_loop_trim_tail_seconds", 0.3, db);
    setSetting("music_video_loop_xfade_seconds", 0.2, db);
    const exec = vi.fn().mockResolvedValue(undefined);
    const probe = vi.fn().mockResolvedValue(7.0);

    await runRenderMusicVideo(videoId, { db, projectsDir, exec, probe });

    const trimArgs = exec.mock.calls[0][0] as string[];
    const trimTIdx = trimArgs.indexOf("-t");
    expect(trimTIdx).toBeGreaterThanOrEqual(0);
    expect(trimArgs[trimTIdx + 1]).toBe("6.700");
  });

  it("skips the trim when the clip is shorter than music_video_loop_trim_tail_seconds (guard against degenerate fixtures)", async () => {
    const db = freshDb();
    const projectsDir = tempDir("render-mv-short");
    const videoId = "v_render_short_01";
    seedMusicVideo(db, videoId, { song_count: 1, repeat_factor: 1 });
    seedLoopClip(projectsDir, videoId);
    setSetting("music_video_loop_trim_tail_seconds", 0.3, db);
    setSetting("music_video_loop_xfade_seconds", 0.2, db);
    const exec = vi.fn().mockResolvedValue(undefined);
    const probe = vi.fn().mockResolvedValue(0.1);

    await runRenderMusicVideo(videoId, { db, projectsDir, exec, probe });

    const trimArgs = exec.mock.calls[0][0] as string[];
    const trimTIdx = trimArgs.indexOf("-t");
    // No trim applied: -t equals the clip's full duration (0.100), not negative.
    expect(trimArgs[trimTIdx + 1]).toBe("0.100");
  });

  it("uses the encoder pinned in settings (h264_nvenc swap) for both pre-trim and mux passes", async () => {
    const db = freshDb();
    const projectsDir = tempDir("render-mv-nvenc");
    const videoId = "v_render_real_02";
    seedMusicVideo(db, videoId, { song_count: 2, repeat_factor: 4 });
    seedLoopClip(projectsDir, videoId);
    setSetting("video_encoder", "h264_nvenc", db);
    setSetting("music_video_loop_trim_tail_seconds", 0.3, db);
    setSetting("music_video_loop_xfade_seconds", 0.2, db);
    const exec = vi.fn().mockResolvedValue(undefined);
    const probe = vi.fn().mockResolvedValue(5.0);

    await runRenderMusicVideo(videoId, { db, projectsDir, exec, probe });

    expect(exec).toHaveBeenCalledTimes(2);
    const trimArgs = exec.mock.calls[0][0] as string[];
    const muxArgs = exec.mock.calls[1][0] as string[];
    expect(trimArgs).toContain("h264_nvenc");
    expect(trimArgs).not.toContain("libx264");
    expect(muxArgs).toContain("h264_nvenc");
    expect(muxArgs).not.toContain("libx264");
    // Mux output-side -t = 2 × 4 = 8 (the wall-clock totalSeconds).
    const muxTIdx = muxArgs.lastIndexOf("-t");
    expect(muxArgs[muxTIdx + 1]).toBe("8");
  });

  it("skips ffmpeg invocation when final.mp4 already exists (idempotent re-entry)", async () => {
    const db = freshDb();
    const projectsDir = tempDir("render-mv-skip");
    const videoId = "v_render_real_03";
    seedMusicVideo(db, videoId, { song_count: 10, repeat_factor: 3 });
    seedLoopClip(projectsDir, videoId);
    writeFileSync(
      join(projectsDir, videoId, "final.mp4"),
      Buffer.from("already-rendered")
    );
    const exec = vi.fn().mockResolvedValue(undefined);

    await runRenderMusicVideo(videoId, { db, projectsDir, exec });

    expect(exec).not.toHaveBeenCalled();
  });

  it("throws when song_count is null", async () => {
    const db = freshDb();
    const projectsDir = tempDir("render-mv-nullcount");
    const videoId = "v_render_real_04";
    seedMusicVideo(db, videoId, { song_count: null, repeat_factor: 3 });
    seedLoopClip(projectsDir, videoId);
    const exec = vi.fn();

    await expect(
      runRenderMusicVideo(videoId, { db, projectsDir, exec })
    ).rejects.toThrow(/song_count/i);
    expect(exec).not.toHaveBeenCalled();
  });

  it("throws when repeat_factor is null", async () => {
    const db = freshDb();
    const projectsDir = tempDir("render-mv-nullrepeat");
    const videoId = "v_render_real_05";
    seedMusicVideo(db, videoId, { song_count: 10, repeat_factor: null });
    seedLoopClip(projectsDir, videoId);
    const exec = vi.fn();

    await expect(
      runRenderMusicVideo(videoId, { db, projectsDir, exec })
    ).rejects.toThrow(/repeat_factor/i);
    expect(exec).not.toHaveBeenCalled();
  });

  it("xfade=0 setting falls back to -stream_loop mux without filter_complex", async () => {
    // Operator dialing xfade down to zero turns off the cross-blend and
    // collapses pass 2 to a plain stream_loop mux of the trimmed clip.
    // ffmpeg's xfade filter rejects duration=0, so the implementation
    // must branch on xfade > 0 — not just pass 0 through.
    const db = freshDb();
    const projectsDir = tempDir("render-mv-xfade-zero");
    const videoId = "v_render_xfade_zero_01";
    seedMusicVideo(db, videoId, { song_count: 10, repeat_factor: 3 });
    seedLoopClip(projectsDir, videoId);
    setSetting("music_video_loop_xfade_seconds", 0, db);
    const exec = vi.fn().mockResolvedValue(undefined);
    const probe = vi.fn().mockResolvedValue(5.0);

    await runRenderMusicVideo(videoId, { db, projectsDir, exec, probe });

    expect(exec).toHaveBeenCalledTimes(2);

    // Pass 1 is unchanged — still pre-trims to 4.700.
    const trimmedClipPath = join(
      projectsDir,
      videoId,
      "build",
      "loop_clip_trimmed.mp4"
    );
    const trimArgs = exec.mock.calls[0][0] as string[];
    const trimTIdx = trimArgs.indexOf("-t");
    expect(trimArgs[trimTIdx + 1]).toBe("4.700");

    // Pass 2 reads as a plain stream_loop mux of the trimmed clip.
    const muxArgs = exec.mock.calls[1][0] as string[];
    expect(muxArgs).not.toContain("-filter_complex");
    const streamLoopIdx = muxArgs.indexOf("-stream_loop");
    expect(streamLoopIdx).toBeGreaterThanOrEqual(0);
    expect(muxArgs[streamLoopIdx + 1]).toBe("-1");
    // Trimmed clip is the looped video input; anullsrc supplies audio.
    expect(muxArgs).toContain(trimmedClipPath);
    expect(muxArgs).toContain(
      "anullsrc=channel_layout=stereo:sample_rate=44100"
    );

    // Total duration -t = 10 × 3 = 30, last arg is final.mp4.
    const muxTIdx = muxArgs.lastIndexOf("-t");
    expect(muxArgs[muxTIdx + 1]).toBe("30");
    expect(muxArgs[muxArgs.length - 1]).toBe(
      join(projectsDir, videoId, "final.mp4")
    );
  });

  it("bubbles exec failures so the orchestrator can mark the step failed", async () => {
    const db = freshDb();
    const projectsDir = tempDir("render-mv-fail");
    const videoId = "v_render_real_06";
    seedMusicVideo(db, videoId, { song_count: 10, repeat_factor: 3 });
    seedLoopClip(projectsDir, videoId);
    const exec = vi
      .fn()
      .mockRejectedValue(new Error("ffmpeg exited with code=1"));
    const probe = vi.fn().mockResolvedValue(5.0);

    await expect(
      runRenderMusicVideo(videoId, { db, projectsDir, exec, probe })
    ).rejects.toThrow(/ffmpeg/i);
  });
});
