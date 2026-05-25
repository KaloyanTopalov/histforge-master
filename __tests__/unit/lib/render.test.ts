import { join } from "node:path";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  computeResolution,
  buildSegmentArgs,
  buildPlaceholderArgs,
  buildXfadeFilterGraph,
  buildClipArgs,
  getEncoderArgs,
  render,
  CROSSFADE_SECONDS,
  ZOOM_TARGET,
  SEGMENT_CONCURRENCY,
} from "@/lib/render";
import type { Chunk } from "@/types";

const tmpDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `histforge-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore Windows lock races
    }
  }
});

// Drain microtasks until `cond` returns true. Bounded so tests fail fast
// instead of hanging when the awaited interleaving never happens.
async function waitFor(cond: () => boolean, label = "condition") {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
  throw new Error(`Timeout waiting for: ${label}`);
}

describe("render constants", () => {
  it("exports CROSSFADE_SECONDS = 1.0", () => {
    expect(CROSSFADE_SECONDS).toBe(1.0);
  });

  it("exports ZOOM_TARGET = 1.275", () => {
    expect(ZOOM_TARGET).toBe(1.275);
  });
});

describe("computeResolution", () => {
  it("16:9 + 1920 -> 1920x1080", () => {
    expect(computeResolution("16:9", 1920)).toEqual({ width: 1920, height: 1080 });
  });

  it("9:16 + 1920 -> 1080x1920", () => {
    expect(computeResolution("9:16", 1920)).toEqual({ width: 1080, height: 1920 });
  });

  it("1:1 + 1920 -> 1920x1920", () => {
    expect(computeResolution("1:1", 1920)).toEqual({ width: 1920, height: 1920 });
  });

  it("4:5 + 1920 -> 1536x1920", () => {
    expect(computeResolution("4:5", 1920)).toEqual({ width: 1536, height: 1920 });
  });

  it("16:9 + 1080 -> 1080x608 (rounds short edge to even)", () => {
    // 1080 * 9/16 = 607.5 -> round to nearest even = 608
    expect(computeResolution("16:9", 1080)).toEqual({ width: 1080, height: 608 });
  });

  it("odd long edge is rounded to even", () => {
    // 1919 -> 1920 (long), 1920*9/16 = 1080 (short)
    expect(computeResolution("16:9", 1919)).toEqual({ width: 1920, height: 1080 });
  });

  it("1:1 + odd -> both dimensions even", () => {
    // 1919 -> 1920 for both
    expect(computeResolution("1:1", 1919)).toEqual({ width: 1920, height: 1920 });
  });
});

describe("buildSegmentArgs", () => {
  const baseOpts = {
    width: 1920,
    height: 1080,
    framerate: 30,
  };

  it("non-last segment renders dur + CROSSFADE_SECONDS", () => {
    const args = buildSegmentArgs({
      ...baseOpts,
      imagePath: "C:/tmp/images/image_001.png",
      chunkDuration: 30,
      isLast: false,
      outPath: "C:/tmp/render/segment_001.mp4",
    });
    // -t flag should be dur + CF = 31
    const tIdx = args.indexOf("-t");
    expect(tIdx).toBeGreaterThan(-1);
    expect(args[tIdx + 1]).toBe("31");
  });

  it("last segment renders exact dur (no crossfade extension)", () => {
    const args = buildSegmentArgs({
      ...baseOpts,
      imagePath: "C:/tmp/images/image_005.png",
      chunkDuration: 28.5,
      isLast: true,
      outPath: "C:/tmp/render/segment_005.mp4",
    });
    const tIdx = args.indexOf("-t");
    expect(args[tIdx + 1]).toBe("28.5");
  });

  it("typical chunk: pre-upscale + zoompan chain with derived buffer ceil(N*9)", () => {
    // 30s non-last @ 30fps → renderDur=31, frames=round(31*30)=930.
    // Derived upscaleLong = min(12000, max(3840, ceil(930*9))) = 8370.
    const args = buildSegmentArgs({
      ...baseOpts,
      imagePath: "C:/tmp/images/image_002.png",
      chunkDuration: 30,
      isLast: false,
      outPath: "C:/tmp/render/segment_002.mp4",
    });
    const vfIdx = args.indexOf("-vf");
    const vfValue = args[vfIdx + 1];
    // Pre-zoompan upscale buffer (derivation hits, between floor and ceiling).
    expect(vfValue).toContain("scale=8370:-1");
    // zoompan: `on` is output frame index; denominator `frames` (not
    // `frames-1`) so the last frame lands at z = 1 + 0.275*(N-1)/N.
    expect(vfValue).toContain("zoompan=");
    expect(vfValue).toContain("*on/930");
    expect(vfValue).toContain("s=1920x1080");
    expect(vfValue).toContain("fps=30");
    expect(vfValue).toContain("format=yuv420p");
  });

  it("upscaleLong derivation is orientation-safe: portrait matches landscape at same N", () => {
    // Both orientations at 30 s non-last @ 30 fps should derive 8370.
    const landscape = buildSegmentArgs({
      ...baseOpts,
      width: 1920,
      height: 1080,
      imagePath: "C:/tmp/images/image_l.png",
      chunkDuration: 30,
      isLast: false,
      outPath: "C:/tmp/render/seg_l.mp4",
    });
    const portrait = buildSegmentArgs({
      ...baseOpts,
      width: 1080,
      height: 1920,
      imagePath: "C:/tmp/images/image_p.png",
      chunkDuration: 30,
      isLast: false,
      outPath: "C:/tmp/render/seg_p.mp4",
    });
    expect(landscape[landscape.indexOf("-vf") + 1]).toContain("scale=8370:-1");
    expect(portrait[portrait.indexOf("-vf") + 1]).toContain("scale=8370:-1");

    // Same invariant at the floor: both orientations at 5 s isLast hit 3840.
    const landscapeShort = buildSegmentArgs({
      ...baseOpts,
      width: 1920,
      height: 1080,
      imagePath: "C:/tmp/images/image_ls.png",
      chunkDuration: 5,
      isLast: true,
      outPath: "C:/tmp/render/seg_ls.mp4",
    });
    const portraitShort = buildSegmentArgs({
      ...baseOpts,
      width: 1080,
      height: 1920,
      imagePath: "C:/tmp/images/image_ps.png",
      chunkDuration: 5,
      isLast: true,
      outPath: "C:/tmp/render/seg_ps.mp4",
    });
    expect(landscapeShort[landscapeShort.indexOf("-vf") + 1]).toContain("scale=3840:-1");
    expect(portraitShort[portraitShort.indexOf("-vf") + 1]).toContain("scale=3840:-1");
  });

  it("short chunk hits the max(W,H)*2 floor (preserves today's behavior under ~14 s)", () => {
    // 5s isLast @ 30fps: frames=150 → ceil(150*9)=1350; floor wins → 3840.
    const args = buildSegmentArgs({
      ...baseOpts,
      imagePath: "C:/tmp/images/image_short.png",
      chunkDuration: 5,
      isLast: true,
      outPath: "C:/tmp/render/seg_short.mp4",
    });
    const vfIdx = args.indexOf("-vf");
    expect(args[vfIdx + 1]).toContain("scale=3840:-1");
  });

  it("long chunk is clamped at the 12000 ceiling (memory-pressure backstop)", () => {
    // 60s non-last @ 30fps: frames=1830 → ceil(1830*9)=16470; ceiling clamps → 12000.
    const args = buildSegmentArgs({
      ...baseOpts,
      imagePath: "C:/tmp/images/image_long.png",
      chunkDuration: 60,
      isLast: false,
      outPath: "C:/tmp/render/seg_long.mp4",
    });
    const vfIdx = args.indexOf("-vf");
    expect(args[vfIdx + 1]).toContain("scale=12000:-1");
  });

  it("output path is the provided outPath", () => {
    const args = buildSegmentArgs({
      ...baseOpts,
      imagePath: "C:/tmp/images/image_042.png",
      chunkDuration: 30,
      isLast: false,
      outPath: "C:/tmp/render/segment_042.mp4",
    });
    expect(args[args.length - 1]).toBe("C:/tmp/render/segment_042.mp4");
  });

  it("uses -preset ultrafast -crf 18 (Stage B throwaway intermediate, ADR-0002)", () => {
    const args = buildSegmentArgs({
      ...baseOpts,
      imagePath: "C:/tmp/images/image_001.png",
      chunkDuration: 30,
      isLast: false,
      outPath: "C:/tmp/render/segment_001.mp4",
    });
    const presetIdx = args.indexOf("-preset");
    expect(presetIdx).toBeGreaterThan(-1);
    expect(args[presetIdx + 1]).toBe("ultrafast");
    const crfIdx = args.indexOf("-crf");
    expect(crfIdx).toBeGreaterThan(-1);
    expect(args[crfIdx + 1]).toBe("18");
  });
});

describe("buildXfadeFilterGraph", () => {
  it("produces correct xfade chain with cumulative offsets for 3 segments", () => {
    // 3 segments with chunk durations [30, 25, 20].
    // Rendered durations: [31, 26, 20] (non-last get +CF).
    // offset_0 = R0 - CF = 31 - 1 = 30 = D0
    // output01 = offset_0 + R1 = 30 + 26 = 56
    // offset_1 = output01 - CF = 56 - 1 = 55 = D0 + D1
    // Pattern: offset_i = cumulative chunk duration.
    const segPaths = ["seg_001.mp4", "seg_002.mp4", "seg_003.mp4"];
    const durations = [30, 25, 20];
    const graph = buildXfadeFilterGraph(segPaths, durations);

    expect(graph.filterComplex).toContain("xfade=transition=fade:duration=1:offset=30");
    expect(graph.filterComplex).toContain("xfade=transition=fade:duration=1:offset=55");
    expect(graph.inputs).toEqual(["-i", "seg_001.mp4", "-i", "seg_002.mp4", "-i", "seg_003.mp4"]);
  });

  it("returns empty filter for a single segment", () => {
    const graph = buildXfadeFilterGraph(["seg_001.mp4"], [30]);
    expect(graph.filterComplex).toBe("");
    expect(graph.inputs).toEqual(["-i", "seg_001.mp4"]);
  });

  it("2 segments produce one transition", () => {
    const graph = buildXfadeFilterGraph(
      ["seg_001.mp4", "seg_002.mp4"],
      [30, 20]
    );
    expect(graph.filterComplex).toContain("xfade=transition=fade:duration=1:offset=30");
    // only one xfade
    expect((graph.filterComplex.match(/xfade/g) || []).length).toBe(1);
  });

  it("default opts wire [0:v]/[1:v] disk inputs into the chain via settb-normalized labels, terminating at [vout]", () => {
    const graph = buildXfadeFilterGraph(
      ["seg_001.mp4", "seg_002.mp4", "seg_003.mp4"],
      [30, 25, 20]
    );
    // Each disk segment is settb=AVTB-normalized at chain entry; the
    // xfade chain consumes [segN] labels, not raw [N:v].
    expect(graph.filterComplex).toMatch(/^\[0:v\]settb=AVTB\[seg0\];/);
    expect(graph.filterComplex).toContain("[1:v]settb=AVTB[seg1]");
    expect(graph.filterComplex).toContain("[seg0][seg1]xfade=");
    expect(graph.filterComplex).toContain("[vout]");
    expect(graph.filterComplex).not.toContain("[vimage]");
  });

  it("inputOffset shifts settb-normalized labels and the xfade chain consumes [segN]", () => {
    // With inputOffset=1, segments are read from disk as [1:v], [2:v],
    // [3:v] and settb-normalized into [seg0], [seg1], [seg2] respectively
    // — leaving [0:v] free for the caller's extra input (the hook in
    // fused Stage CD).
    const graph = buildXfadeFilterGraph(
      ["seg_001.mp4", "seg_002.mp4", "seg_003.mp4"],
      [30, 25, 20],
      { inputOffset: 1 }
    );
    expect(graph.filterComplex).toContain("[1:v]settb=AVTB[seg0]");
    expect(graph.filterComplex).toContain("[2:v]settb=AVTB[seg1]");
    expect(graph.filterComplex).toContain("[3:v]settb=AVTB[seg2]");
    // First transition reads [seg0] + [seg1]
    expect(graph.filterComplex).toContain("[seg0][seg1]xfade=");
    // Second transition reads previous-out + [seg2]
    expect(graph.filterComplex).toContain("[v1][seg2]xfade=");
    // Offsets must NOT shift — math depends on chunk durations, not input slot.
    expect(graph.filterComplex).toContain("offset=30");
    expect(graph.filterComplex).toContain("offset=55");
    // Inputs array is unchanged — caller still gets just the segment -i flags.
    expect(graph.inputs).toEqual([
      "-i", "seg_001.mp4", "-i", "seg_002.mp4", "-i", "seg_003.mp4",
    ]);
  });

  it("outputLabel replaces [vout] on the final transition only", () => {
    const graph = buildXfadeFilterGraph(
      ["seg_001.mp4", "seg_002.mp4", "seg_003.mp4"],
      [30, 25, 20],
      { outputLabel: "[vimage]" }
    );
    expect(graph.filterComplex).toContain("[vimage]");
    expect(graph.filterComplex).not.toContain("[vout]");
    // Intermediate label [v1] remains — only the *final* transition's output shifts.
    expect(graph.filterComplex).toContain("[v1]");
  });

  it("inputOffset and outputLabel compose for the fused Stage CD main fragment", () => {
    // The shape the fused-exec dispatcher will emit for ≥2 main + ≥1 hook:
    //   [0:v]norm[vclip]; <this fragment, inputOffset=1, outputLabel=[vimage]>; [vclip][vimage]xfade…
    // Each segment input is settb=AVTB-normalized so its container
    // timebase (1/15360 from MP4) aligns with the chain's downstream
    // timebase.
    const graph = buildXfadeFilterGraph(
      ["seg_001.mp4", "seg_002.mp4"],
      [30, 25],
      { inputOffset: 1, outputLabel: "[vimage]" }
    );
    expect(graph.filterComplex).toBe(
      "[1:v]settb=AVTB[seg0];[2:v]settb=AVTB[seg1];" +
        "[seg0][seg1]xfade=transition=fade:duration=1:offset=30[vimage]"
    );
  });

  it("emits a settb=AVTB pre-filter for every disk segment input (timebase-mismatch guard)", () => {
    // MP4 inputs have container timebase 1/15360 (30fps × 512). xfade
    // chain output is at a different timebase. Without explicit settb
    // on each disk input, mid-chain xfades reject with "input link
    // timebases do not match" under any filter-graph reinit pass
    // (NVENC's pixfmt negotiation is the known trigger; libx264 happens
    // to mask the bug). The settb prefix ensures all chain legs land on
    // the same timebase regardless of encoder.
    const graph = buildXfadeFilterGraph(
      ["a.mp4", "b.mp4", "c.mp4", "d.mp4"],
      [10, 10, 10, 10]
    );
    // One settb per segment, indexed in input-list order.
    const settbCount = (graph.filterComplex.match(/settb=AVTB/g) || []).length;
    expect(settbCount).toBe(4);
  });

  it("single segment returns empty filter regardless of opts", () => {
    const graph = buildXfadeFilterGraph(["seg_001.mp4"], [30], {
      inputOffset: 5,
      outputLabel: "[whatever]",
    });
    expect(graph.filterComplex).toBe("");
  });
});

describe("buildClipArgs", () => {
  const baseOpts = {
    sourcePath: "C:/tmp/videos/clip/clip_01.mp4",
    outPath: "C:/tmp/render/clip_01_timed.mp4",
    framerate: 30,
  };

  it("includes tpad filter when padSeconds >= 1/framerate", () => {
    const args = buildClipArgs({ ...baseOpts, padSeconds: 1.2 });
    const vfIdx = args.indexOf("-vf");
    expect(vfIdx).toBeGreaterThan(-1);
    expect(args[vfIdx + 1]).toBe(
      "tpad=stop_mode=clone:stop_duration=1.2"
    );
  });

  it("omits tpad filter when padSeconds is below the frame quantum", () => {
    // 1/30 ≈ 0.0333… ; 0.01s is sub-frame and should be skipped
    const args = buildClipArgs({ ...baseOpts, padSeconds: 0.01 });
    expect(args.indexOf("-vf")).toBe(-1);
  });

  it("omits tpad filter when padSeconds is zero", () => {
    const args = buildClipArgs({ ...baseOpts, padSeconds: 0 });
    expect(args.indexOf("-vf")).toBe(-1);
  });

  it("applies tpad exactly at the frame-quantum boundary", () => {
    const args = buildClipArgs({
      ...baseOpts,
      padSeconds: 1 / 30,
    });
    expect(args.indexOf("-vf")).toBeGreaterThan(-1);
  });

  it("always passes -an, libx264, and the output path as last arg", () => {
    const args = buildClipArgs({ ...baseOpts, padSeconds: 0.5 });
    expect(args).toContain("-an");
    expect(args).toContain("-c:v");
    expect(args[args.indexOf("-c:v") + 1]).toBe("libx264");
    expect(args[args.length - 1]).toBe("C:/tmp/render/clip_01_timed.mp4");
  });

  it("reads the source path from -i", () => {
    const args = buildClipArgs({ ...baseOpts, padSeconds: 0 });
    const iIdx = args.indexOf("-i");
    expect(args[iIdx + 1]).toBe("C:/tmp/videos/clip/clip_01.mp4");
  });

  it("keeps -preset medium -crf 20 (Stage A regression guard per ADR-0002)", () => {
    const args = buildClipArgs({ ...baseOpts, padSeconds: 0 });
    const presetIdx = args.indexOf("-preset");
    expect(presetIdx).toBeGreaterThan(-1);
    expect(args[presetIdx + 1]).toBe("medium");
    const crfIdx = args.indexOf("-crf");
    expect(crfIdx).toBeGreaterThan(-1);
    expect(args[crfIdx + 1]).toBe("20");
  });
});

describe("getEncoderArgs", () => {
  it("libx264 → today's literal Stage CD args (-preset medium -crf 20)", () => {
    expect(getEncoderArgs("libx264")).toEqual([
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "20",
    ]);
  });

  it("h264_nvenc → NVENC starting point per ADR-0004 (-cq 21, -b:v 0)", () => {
    expect(getEncoderArgs("h264_nvenc")).toEqual([
      "-c:v", "h264_nvenc",
      "-preset", "p5",
      "-tune", "hq",
      "-rc", "vbr",
      "-cq", "21",
      "-b:v", "0",
    ]);
  });

  it("h264_amf → AMF starting point per ADR-0004 (cqp, -qp_i 21 -qp_p 23)", () => {
    expect(getEncoderArgs("h264_amf")).toEqual([
      "-c:v", "h264_amf",
      "-quality", "balanced",
      "-rc", "cqp",
      "-qp_i", "21",
      "-qp_p", "23",
    ]);
  });

  // AV1 NVENC's CQ scale is 0-63 (twice the 0-51 of H.264). cq 33 lands
  // roughly where h264_nvenc's cq 21 sits perceptually — keeps quality
  // parity with the existing NVENC default while taking the AV1 size win.
  it("av1_nvenc → AV1 NVENC starting point (-cq 33, -b:v 0)", () => {
    expect(getEncoderArgs("av1_nvenc")).toEqual([
      "-c:v", "av1_nvenc",
      "-preset", "p5",
      "-tune", "hq",
      "-rc", "vbr",
      "-cq", "33",
      "-b:v", "0",
    ]);
  });
});

describe("buildPlaceholderArgs", () => {
  it("generates a lavfi source with MISSING text for a given chunk_id", () => {
    const args = buildPlaceholderArgs({
      chunkId: "image_007",
      duration: 30,
      width: 1920,
      height: 1080,
      framerate: 30,
      outPath: "/tmp/render/placeholder_007.mp4",
    });
    // Entire filter chain is in the lavfi -i arg (no separate -vf)
    expect(args.indexOf("-vf")).toBe(-1);
    const iIdx = args.indexOf("-i");
    const lavfi = args[iIdx + 1];
    expect(lavfi).toContain("color=c=black:s=1920x1080:r=30:d=30");
    expect(lavfi).toContain("MISSING");
    expect(lavfi).toContain("image_007");
    expect(lavfi).toContain("format=yuv420p");
    // Output path
    expect(args[args.length - 1]).toBe("/tmp/render/placeholder_007.mp4");
  });

  it("uses -preset ultrafast -crf 18 (Stage B throwaway intermediate, ADR-0002)", () => {
    const args = buildPlaceholderArgs({
      chunkId: "image_007",
      duration: 30,
      width: 1920,
      height: 1080,
      framerate: 30,
      outPath: "/tmp/render/placeholder_007.mp4",
    });
    const presetIdx = args.indexOf("-preset");
    expect(presetIdx).toBeGreaterThan(-1);
    expect(args[presetIdx + 1]).toBe("ultrafast");
    const crfIdx = args.indexOf("-crf");
    expect(crfIdx).toBeGreaterThan(-1);
    expect(args[crfIdx + 1]).toBe("18");
  });
});

describe("render() orchestration", () => {
  function makeChunks(): Chunk[] {
    return [
      { id: "clip_01", kind: "clip", start: 0, end: 10, text: "a", prompt: "p" },
      { id: "clip_02", kind: "clip", start: 10, end: 20, text: "b", prompt: "p" },
      { id: "image_001", kind: "image", start: 20, end: 50, text: "c", prompt: "p" },
      { id: "image_002", kind: "image", start: 50, end: 75, text: "d", prompt: "p" },
    ];
  }

  function setupProject(projectsDir: string, videoId: string, chunks: Chunk[]) {
    const projDir = join(projectsDir, videoId);
    mkdirSync(join(projDir, "chunks"), { recursive: true });
    mkdirSync(join(projDir, "images"), { recursive: true });
    mkdirSync(join(projDir, "videos", "clip"), { recursive: true });
    mkdirSync(join(projDir, "audio"), { recursive: true });
    writeFileSync(
      join(projDir, "chunks", "chunks.json"),
      JSON.stringify(chunks)
    );
    // Create hook video files
    writeFileSync(join(projDir, "videos", "clip", "clip_01.mp4"), "");
    writeFileSync(join(projDir, "videos", "clip", "clip_02.mp4"), "");
    // Create main images — ComfyUI writes .png directly
    writeFileSync(join(projDir, "images", "image_001.png"), "");
    writeFileSync(join(projDir, "images", "image_002.png"), "");
    // Create audio
    writeFileSync(join(projDir, "audio", "narration.mp3"), "");
    return projDir;
  }

  it("deletes render/ directory before starting", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_render_cleanup";
    const projDir = setupProject(projectsDir, videoId, makeChunks());
    // Pre-create stale render dir
    const renderDir = join(projDir, "render");
    mkdirSync(renderDir, { recursive: true });
    writeFileSync(join(renderDir, "stale_segment.mp4"), "old");

    const exec = vi.fn();
    const probe = vi.fn().mockResolvedValue(20);
    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "libx264",
      exec,
      probe,
      log: () => {},
    });

    // The stale file should have been deleted before any exec call
    expect(existsSync(join(renderDir, "stale_segment.mp4"))).toBe(false);
  });

  it("calls ffmpeg for Stage A (hook), Stage B (segments), Stage CD (fused main+hook xfade), Stage E (mux)", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_render_stages";
    setupProject(projectsDir, videoId, makeChunks());

    const calls: string[][] = [];
    const exec = vi.fn().mockImplementation((args: string[]) => {
      calls.push(args);
    });
    // Per-clip probes (2 hook chunks) report V > A so no padding, plus
    // the final probe of clip_final.mp4 used by fused Stage CD.
    const probe = vi.fn().mockImplementation((path: string) => {
      if (path.endsWith("clip_final.mp4")) return Promise.resolve(15.5);
      return Promise.resolve(20);
    });

    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "libx264",
      exec,
      probe,
      log: () => {},
    });

    // Stage A per-chunk: 2 timed clips written before the concat
    const timedClips = calls.filter((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && /clip_\d+_timed\.mp4$/.test(last);
    });
    expect(timedClips.length).toBe(2);

    // Stage A: hook concat (has -f concat)
    const clipConcat = calls.find((c) => c.includes("concat") && c.some((a) => a.includes("clip_concat")));
    expect(clipConcat).toBeDefined();

    // Stage A tail: last-frame still
    const clipTail = calls.find((c) => c.some((a) => a.includes("clip_tail")));
    expect(clipTail).toBeDefined();

    // Stage A final: concat clip_concat + clip_tail
    const clipFinal = calls.find((c) => c.some((a) => a.includes("clip_final")));
    expect(clipFinal).toBeDefined();

    // Stage B: 2 main segments (output file is last arg matching segment_NNN.mp4)
    const segments = calls.filter((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && /segment_\d+\.mp4$/.test(last);
    });
    expect(segments.length).toBe(2);

    // Stage CD: ONE fused exec writes video_only.mp4 with hook norm,
    // main xfade chain, and hook→main xfade all in one filter_complex.
    const videoOnlyCalls = calls.filter((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && last.endsWith("video_only.mp4");
    });
    expect(videoOnlyCalls.length).toBe(1);
    const fused = videoOnlyCalls[0];
    const filterIdx = fused.indexOf("-filter_complex");
    expect(filterIdx).toBeGreaterThan(-1);
    const filterValue = fused[filterIdx + 1];
    // Hook normalization fragment on input [0:v]
    expect(filterValue).toContain("force_original_aspect_ratio=decrease");
    expect(filterValue).toContain("[vclip]");
    // Main xfade chain (inputOffset=1, outputLabel=[vimage]); offsets are
    // cumulative chunk durations (30 from image_001).
    expect(filterValue).toContain("offset=30");
    expect(filterValue).toContain("[vimage]");
    // Hook→main xfade with offset = hookDuration - CF
    expect(filterValue).toContain("offset=14.5");
    expect(filterValue).toContain("[vout]");

    // Stage CD output is encoded directly to video_only.mp4 at medium/crf 20
    const presetIdx = fused.indexOf("-preset");
    expect(fused[presetIdx + 1]).toBe("medium");
    const crfIdx = fused.indexOf("-crf");
    expect(fused[crfIdx + 1]).toBe("20");

    // The fused architecture eliminates image_concat.mp4 entirely.
    const imageConcatCalls = calls.filter((c) =>
      c.some((a) => typeof a === "string" && a.includes("image_concat"))
    );
    expect(imageConcatCalls.length).toBe(0);

    // Stage E: audio mux
    const mux = calls.find((c) => c.includes("-shortest"));
    expect(mux).toBeDefined();
    expect(mux).toContain("-c:v");
  });

  it("Stage CD hook→main offset = ffprobe(clip_final) - CROSSFADE_SECONDS, not chunk timestamps", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_render_probe_offset";
    // Chunk fixture has hook span 0-20 (chunk-derived hookDuration would be 20)
    setupProject(projectsDir, videoId, makeChunks());

    const calls: string[][] = [];
    const exec = vi.fn().mockImplementation((args: string[]) => calls.push(args));
    // Per-clip probes return V > A (no padding); clip_final probe returns 17.3.
    const probe = vi.fn().mockImplementation((path: string) => {
      if (path.endsWith("clip_final.mp4")) return Promise.resolve(17.3);
      return Promise.resolve(20);
    });

    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "libx264",
      exec,
      probe,
      log: () => {},
    });

    // probe is called once per hook chunk (2) plus once on clip_final.mp4
    expect(probe).toHaveBeenCalledTimes(3);
    expect(probe.mock.calls[2][0]).toMatch(/clip_final\.mp4$/);

    // The fused Stage CD exec writes video_only.mp4; its filter_complex
    // contains the hook→main xfade with offset = probe(clip_final) - CF.
    const fused = calls.find((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && last.endsWith("video_only.mp4");
    });
    expect(fused).toBeDefined();
    const filterIdx = fused!.indexOf("-filter_complex");
    const filterValue = fused![filterIdx + 1];
    expect(filterValue).toContain("offset=16.3");
    // Forbidden values: chunk-derived (20) and raw probe (17.3) — though
    // the main chain's cumulative offsets are also asserted to not happen
    // to collide with 17.3 / 20 in this fixture (main chunks: D=30, D=25).
    expect(filterValue).not.toContain("offset=20");
    expect(filterValue).not.toContain("offset=17.3");
  });

  it("uses placeholder for missing main images and logs it", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_render_placeholder";
    const chunks = makeChunks();
    const projDir = setupProject(projectsDir, videoId, chunks);

    // Delete image_002.png to trigger placeholder
    rmSync(join(projDir, "images", "image_002.png"));

    const logged: string[] = [];
    const exec = vi.fn();
    const probe = vi.fn().mockResolvedValue(20);

    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "libx264",
      exec,
      probe,
      log: (msg: string) => logged.push(msg),
    });

    // Should have logged the missing image
    expect(logged.some((m) => m.includes("image_002"))).toBe(true);

    // One of the exec calls should contain MISSING in the lavfi source
    const placeholderCall = exec.mock.calls.find((c: string[][]) =>
      c[0].some((a: string) => a.includes("MISSING") && a.includes("image_002"))
    );
    expect(placeholderCall).toBeDefined();
  });

  it("produces hook concat list pointing at per-chunk timed clips in order", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_render_hook_order";
    setupProject(projectsDir, videoId, makeChunks());

    const exec = vi.fn();
    const probe = vi.fn().mockResolvedValue(20);
    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "libx264",
      exec,
      probe,
      log: () => {},
    });

    // The concat list file should exist and reference per-chunk timed
    // intermediates (clip_<id>_timed.mp4) in chunk order, not the raw
    // source clip paths.
    const projDir = join(projectsDir, videoId);
    const listPath = join(projDir, "render", "clip_list.txt");
    expect(existsSync(listPath)).toBe(true);
    const content = readFileSync(listPath, "utf-8");
    const idx1 = content.indexOf("clip_01_timed.mp4");
    const idx2 = content.indexOf("clip_02_timed.mp4");
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
  });

  it("Stage A pads a hook clip when its source duration < chunk audio span", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_render_stage_a_pad";
    setupProject(projectsDir, videoId, makeChunks());

    const calls: string[][] = [];
    const exec = vi.fn().mockImplementation((args: string[]) => calls.push(args));
    // clip_01 audio span = 10s; source clip = 7.5s → pad 2.5s
    // clip_02 audio span = 10s; source clip = 12s → no pad
    const probe = vi.fn().mockImplementation((path: string) => {
      if (path.endsWith("clip_01.mp4")) return Promise.resolve(7.5);
      if (path.endsWith("clip_02.mp4")) return Promise.resolve(12);
      return Promise.resolve(20); // clip_final.mp4
    });

    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "libx264",
      exec,
      probe,
      log: () => {},
    });

    // clip_01 should have a tpad filter with stop_duration=2.5
    const clip01 = calls.find((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && last.endsWith("clip_01_timed.mp4");
    });
    expect(clip01).toBeDefined();
    const clip01Vf = clip01!.indexOf("-vf");
    expect(clip01Vf).toBeGreaterThan(-1);
    expect(clip01![clip01Vf + 1]).toBe(
      "tpad=stop_mode=clone:stop_duration=2.5"
    );

    // clip_02 should NOT have a tpad filter (V > A)
    const clip02 = calls.find((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && last.endsWith("clip_02_timed.mp4");
    });
    expect(clip02).toBeDefined();
    expect(clip02!.indexOf("-vf")).toBe(-1);
  });

  it("Stage A probes every hook source clip plus clip_final.mp4", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_render_probe_sites";
    setupProject(projectsDir, videoId, makeChunks());

    const exec = vi.fn();
    const probedPaths: string[] = [];
    const probe = vi.fn().mockImplementation((path: string) => {
      probedPaths.push(path);
      return Promise.resolve(8);
    });

    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "libx264",
      exec,
      probe,
      log: () => {},
    });

    expect(probedPaths.length).toBe(3);
    expect(probedPaths[0]).toMatch(/clip_01\.mp4$/);
    expect(probedPaths[1]).toMatch(/clip_02\.mp4$/);
    expect(probedPaths[2]).toMatch(/clip_final\.mp4$/);
  });

  it("Stage A logs per-chunk pad amounts only when padding is applied", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_render_pad_log";
    setupProject(projectsDir, videoId, makeChunks());

    const exec = vi.fn();
    const probe = vi.fn().mockImplementation((path: string) => {
      if (path.endsWith("clip_01.mp4")) return Promise.resolve(7);
      if (path.endsWith("clip_02.mp4")) return Promise.resolve(15);
      return Promise.resolve(20);
    });
    const logged: string[] = [];
    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "libx264",
      exec,
      probe,
      log: (msg: string) => logged.push(msg),
    });

    const padLogs = logged.filter((m) => m.startsWith("Padded "));
    expect(padLogs.length).toBe(1);
    expect(padLogs[0]).toContain("clip_01");
    expect(padLogs[0]).toContain("+3.000s");
  });

  it("throws when a hook video is missing", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_render_missing_hook";
    const projDir = setupProject(projectsDir, videoId, makeChunks());

    // Delete one hook video
    rmSync(join(projDir, "videos", "clip", "clip_02.mp4"));

    const exec = vi.fn();
    const probe = vi.fn().mockResolvedValue(20);
    await expect(
      render(videoId, {
        projectsDir,
        aspectRatio: "16:9",
        longEdgePx: 1920,
        framerate: 30,
        videoEncoder: "libx264",
        exec,
        probe,
        log: () => {},
      })
    ).rejects.toThrow("Missing clip video for clip_02");
  });

  it("Stage CD with no hooks: one fused exec writes video_only.mp4 with main xfade chain only", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_render_no_hooks";
    // Main-only chunks (no hooks)
    const chunks: Chunk[] = [
      { id: "image_001", kind: "image", start: 0, end: 30, text: "a", prompt: "p" },
      { id: "image_002", kind: "image", start: 30, end: 55, text: "b", prompt: "p" },
    ];
    const projDir = join(projectsDir, videoId);
    mkdirSync(join(projDir, "chunks"), { recursive: true });
    mkdirSync(join(projDir, "images"), { recursive: true });
    mkdirSync(join(projDir, "audio"), { recursive: true });
    writeFileSync(join(projDir, "chunks", "chunks.json"), JSON.stringify(chunks));
    writeFileSync(join(projDir, "images", "image_001.png"), "");
    writeFileSync(join(projDir, "images", "image_002.png"), "");
    writeFileSync(join(projDir, "audio", "narration.mp3"), "");

    const calls: string[][] = [];
    const exec = vi.fn().mockImplementation((args: string[]) => calls.push(args));
    const probe = vi.fn().mockResolvedValue(0);

    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "libx264",
      exec,
      probe,
      log: () => {},
    });

    // No hook chunks → ffprobe is not called (no hook duration to derive)
    expect(probe).not.toHaveBeenCalled();

    // No clip_concat or clip_list should exist
    expect(existsSync(join(projDir, "render", "clip_list.txt"))).toBe(false);
    // No hook-related exec calls
    const clipCalls = calls.filter((c) => c.some((a) => a.includes("clip_concat")));
    expect(clipCalls.length).toBe(0);

    // Stage CD: ONE fused exec writes video_only.mp4 with main xfade chain ONLY
    // (no hook normalization, no hook→main xfade).
    const videoOnlyCalls = calls.filter((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && last.endsWith("video_only.mp4");
    });
    expect(videoOnlyCalls.length).toBe(1);
    const fused = videoOnlyCalls[0];
    const filterIdx = fused.indexOf("-filter_complex");
    expect(filterIdx).toBeGreaterThan(-1);
    const filterValue = fused[filterIdx + 1];
    // Main xfade chain present (settb-normalized [seg0]/[seg1] entry → [vout])
    expect(filterValue).toContain("[0:v]settb=AVTB[seg0]");
    expect(filterValue).toContain("[seg0][seg1]xfade=");
    expect(filterValue).toContain("[vout]");
    expect(filterValue).toContain("offset=30");
    // No hook normalization or hook→main bits
    expect(filterValue).not.toContain("force_original_aspect_ratio");
    expect(filterValue).not.toContain("[vclip]");
    expect(filterValue).not.toContain("[vimage]");

    // Encoder settings preserved
    const presetIdx = fused.indexOf("-preset");
    expect(fused[presetIdx + 1]).toBe("medium");
    const crfIdx = fused.indexOf("-crf");
    expect(fused[crfIdx + 1]).toBe("20");

    // image_concat.mp4 must not appear anywhere — intermediate is removed.
    const imageConcatCalls = calls.filter((c) =>
      c.some((a) => typeof a === "string" && a.includes("image_concat"))
    );
    expect(imageConcatCalls.length).toBe(0);

    // Stage E (mux) should still happen
    const mux = calls.find((c) => c.includes("-shortest"));
    expect(mux).toBeDefined();
  });

  it("Stage CD with 1 main + ≥1 hook: fused exec hook-norms [0:v] and xfades against [1:v]", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_render_one_main_with_hook";
    const chunks: Chunk[] = [
      { id: "clip_01", kind: "clip", start: 0, end: 10, text: "a", prompt: "p" },
      { id: "image_001", kind: "image", start: 10, end: 70, text: "b", prompt: "p" },
    ];
    const projDir = join(projectsDir, videoId);
    mkdirSync(join(projDir, "chunks"), { recursive: true });
    mkdirSync(join(projDir, "images"), { recursive: true });
    mkdirSync(join(projDir, "videos", "clip"), { recursive: true });
    mkdirSync(join(projDir, "audio"), { recursive: true });
    writeFileSync(join(projDir, "chunks", "chunks.json"), JSON.stringify(chunks));
    writeFileSync(join(projDir, "videos", "clip", "clip_01.mp4"), "");
    writeFileSync(join(projDir, "images", "image_001.png"), "");
    writeFileSync(join(projDir, "audio", "narration.mp3"), "");

    const calls: string[][] = [];
    const exec = vi.fn().mockImplementation((args: string[]) => calls.push(args));
    // clip_01 source duration = 12 (V > A, no pad); clip_final duration = 11.2.
    // Expected hook→main xfade offset = 11.2 - 1.0 = 10.2.
    const probe = vi.fn().mockImplementation((path: string) => {
      if (path.endsWith("clip_final.mp4")) return Promise.resolve(11.2);
      return Promise.resolve(12);
    });

    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "libx264",
      exec,
      probe,
      log: () => {},
    });

    // ONE fused exec writes video_only.mp4
    const videoOnlyCalls = calls.filter((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && last.endsWith("video_only.mp4");
    });
    expect(videoOnlyCalls.length).toBe(1);
    const fused = videoOnlyCalls[0];

    // Inputs: clip_final at [0:v], segment_001 at [1:v]
    const inputIndices: number[] = [];
    for (let i = 0; i < fused.length; i++) {
      if (fused[i] === "-i") inputIndices.push(i + 1);
    }
    expect(fused[inputIndices[0]]).toMatch(/clip_final\.mp4$/);
    expect(fused[inputIndices[1]]).toMatch(/segment_001\.mp4$/);

    // filter_complex: hook norm on [0:v] → [vclip]; segment_001 at
    // [1:v] gets settb=AVTB-normalized to [vimage1] (timebase guard
    // against xfade reinit, matches the hookNorm tail); then
    // [vclip][vimage1]xfade=…[vout].
    const filterIdx = fused.indexOf("-filter_complex");
    const filterValue = fused[filterIdx + 1];
    expect(filterValue).toContain("force_original_aspect_ratio=decrease");
    expect(filterValue).toContain("settb=AVTB");
    expect(filterValue).toContain("[vclip]");
    expect(filterValue).toContain("[1:v]settb=AVTB[vimage1]");
    expect(filterValue).toContain("[vclip][vimage1]xfade=");
    expect(filterValue).toContain("offset=10.2");
    expect(filterValue).toContain("[vout]");
    // No main xfade chain — only one segment, so [vimage]/[v1] must be absent.
    // [vimage1] is the normalized single-segment label, not the chain label.
    expect(filterValue).not.toContain("[vimage]");
    expect(filterValue).not.toContain("[v1]");

    // image_concat.mp4 must not appear anywhere
    const imageConcatCalls = calls.filter((c) =>
      c.some((a) => typeof a === "string" && a.includes("image_concat"))
    );
    expect(imageConcatCalls.length).toBe(0);
  });

  it("Stage CD with 1 main + 0 hook: stream-copies segment_001.mp4 to video_only.mp4 with no filter graph", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_render_single";
    const chunks: Chunk[] = [
      { id: "image_001", kind: "image", start: 0, end: 60, text: "a", prompt: "p" },
    ];
    const projDir = join(projectsDir, videoId);
    mkdirSync(join(projDir, "chunks"), { recursive: true });
    mkdirSync(join(projDir, "images"), { recursive: true });
    mkdirSync(join(projDir, "audio"), { recursive: true });
    writeFileSync(join(projDir, "chunks", "chunks.json"), JSON.stringify(chunks));
    writeFileSync(join(projDir, "images", "image_001.png"), "");
    writeFileSync(join(projDir, "audio", "narration.mp3"), "");

    const calls: string[][] = [];
    const exec = vi.fn().mockImplementation((args: string[]) => calls.push(args));
    const probe = vi.fn().mockResolvedValue(0);

    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "libx264",
      exec,
      probe,
      log: () => {},
    });

    // Stage B: single segment rendered with exact duration (isLast=true)
    const segCall = calls.find((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && /segment_001\.mp4$/.test(last);
    });
    expect(segCall).toBeDefined();
    const tIdx = segCall!.indexOf("-t");
    expect(segCall![tIdx + 1]).toBe("60");

    // Stage CD: ONE stream copy from segment_001.mp4 to video_only.mp4 —
    // no filter graph, no re-encode.
    const videoOnlyCalls = calls.filter((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && last.endsWith("video_only.mp4");
    });
    expect(videoOnlyCalls.length).toBe(1);
    const stageCD = videoOnlyCalls[0];
    expect(stageCD).toContain("-c");
    expect(stageCD).toContain("copy");
    expect(stageCD.indexOf("-filter_complex")).toBe(-1);
    // Input is segment_001.mp4 (not image_concat.mp4)
    const iIdx = stageCD.indexOf("-i");
    expect(stageCD[iIdx + 1]).toMatch(/segment_001\.mp4$/);

    // image_concat.mp4 must not appear anywhere
    const imageConcatCalls = calls.filter((c) =>
      c.some((a) => typeof a === "string" && a.includes("image_concat"))
    );
    expect(imageConcatCalls.length).toBe(0);

    // No xfade in any filter_complex (there are no filter_complex calls at all)
    const xfadeCalls = calls.filter((c) =>
      c.includes("-filter_complex") &&
      c.some((a) => typeof a === "string" && a.includes("xfade"))
    );
    expect(xfadeCalls.length).toBe(0);
  });

  it("Stage B emits a single ceiling-clamp log line per chunk that trips the 12000 cap", async () => {
    // 60 s single-chunk render @ 30 fps: frames=round(60*30)=1800;
    // ceil(1800*9)=16200 > 12000, so the ceiling clamp engages.
    const projectsDir = tempDir("projects");
    const videoId = "v_render_buffer_clamp";
    const chunks: Chunk[] = [
      { id: "image_001", kind: "image", start: 0, end: 60, text: "a", prompt: "p" },
    ];
    const projDir = join(projectsDir, videoId);
    mkdirSync(join(projDir, "chunks"), { recursive: true });
    mkdirSync(join(projDir, "images"), { recursive: true });
    mkdirSync(join(projDir, "audio"), { recursive: true });
    writeFileSync(join(projDir, "chunks", "chunks.json"), JSON.stringify(chunks));
    writeFileSync(join(projDir, "images", "image_001.png"), "");
    writeFileSync(join(projDir, "audio", "narration.mp3"), "");

    const logged: string[] = [];
    const exec = vi.fn();
    const probe = vi.fn().mockResolvedValue(0);

    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "libx264",
      exec,
      probe,
      log: (m: string) => logged.push(m),
    });

    const clampLogs = logged.filter((m) =>
      m.startsWith("Stage B buffer capped at 12000")
    );
    expect(clampLogs.length).toBe(1);
    expect(clampLogs[0]).toContain("image_001");
    expect(clampLogs[0]).toContain("N_frames=1800");
    expect(clampLogs[0]).toContain("derived=16200");
  });
});

describe("render() Stage CD encoder branch (ADR-0004)", () => {
  function setupMainOnly(
    projectsDir: string,
    videoId: string,
    numChunks: number
  ): string {
    const projDir = join(projectsDir, videoId);
    mkdirSync(join(projDir, "chunks"), { recursive: true });
    mkdirSync(join(projDir, "images"), { recursive: true });
    mkdirSync(join(projDir, "audio"), { recursive: true });
    const chunks: Chunk[] = [];
    for (let i = 0; i < numChunks; i++) {
      const id = `image_${String(i + 1).padStart(3, "0")}`;
      chunks.push({
        id,
        kind: "image",
        start: i * 30,
        end: (i + 1) * 30,
        text: "x",
        prompt: "p",
      });
      writeFileSync(join(projDir, "images", `${id}.png`), "");
    }
    writeFileSync(
      join(projDir, "chunks", "chunks.json"),
      JSON.stringify(chunks)
    );
    writeFileSync(join(projDir, "audio", "narration.mp3"), "");
    return projDir;
  }

  function setupHookAndMain(projectsDir: string, videoId: string): string {
    const projDir = join(projectsDir, videoId);
    mkdirSync(join(projDir, "chunks"), { recursive: true });
    mkdirSync(join(projDir, "images"), { recursive: true });
    mkdirSync(join(projDir, "videos", "clip"), { recursive: true });
    mkdirSync(join(projDir, "audio"), { recursive: true });
    const chunks: Chunk[] = [
      { id: "clip_01", kind: "clip", start: 0, end: 10, text: "a", prompt: "p" },
      { id: "image_001", kind: "image", start: 10, end: 40, text: "b", prompt: "p" },
      { id: "image_002", kind: "image", start: 40, end: 65, text: "c", prompt: "p" },
    ];
    writeFileSync(join(projDir, "chunks", "chunks.json"), JSON.stringify(chunks));
    writeFileSync(join(projDir, "videos", "clip", "clip_01.mp4"), "");
    writeFileSync(join(projDir, "images", "image_001.png"), "");
    writeFileSync(join(projDir, "images", "image_002.png"), "");
    writeFileSync(join(projDir, "audio", "narration.mp3"), "");
    return projDir;
  }

  it("≥2 main + 0 hook: videoEncoder=h264_nvenc routes NVENC args (not libx264) into fused exec", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_cd_nvenc_main_only";
    setupMainOnly(projectsDir, videoId, 2);

    const calls: string[][] = [];
    const exec = vi.fn().mockImplementation((args: string[]) => calls.push(args));
    const probe = vi.fn().mockResolvedValue(0);

    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "h264_nvenc",
      exec,
      probe,
      log: () => {},
    });

    const fused = calls.find((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && last.endsWith("video_only.mp4");
    });
    expect(fused).toBeDefined();
    // NVENC bundle present; libx264 fragment absent.
    const cvIdx = fused!.indexOf("-c:v");
    expect(fused![cvIdx + 1]).toBe("h264_nvenc");
    expect(fused).toContain("-cq");
    expect(fused![fused!.indexOf("-cq") + 1]).toBe("21");
    expect(fused).not.toContain("libx264");
  });

  it("1 main + ≥1 hook: videoEncoder=h264_amf routes AMF args into fused exec", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_cd_amf_one_main_hook";
    const projDir = join(projectsDir, videoId);
    mkdirSync(join(projDir, "chunks"), { recursive: true });
    mkdirSync(join(projDir, "images"), { recursive: true });
    mkdirSync(join(projDir, "videos", "clip"), { recursive: true });
    mkdirSync(join(projDir, "audio"), { recursive: true });
    const chunks: Chunk[] = [
      { id: "clip_01", kind: "clip", start: 0, end: 10, text: "a", prompt: "p" },
      { id: "image_001", kind: "image", start: 10, end: 70, text: "b", prompt: "p" },
    ];
    writeFileSync(join(projDir, "chunks", "chunks.json"), JSON.stringify(chunks));
    writeFileSync(join(projDir, "videos", "clip", "clip_01.mp4"), "");
    writeFileSync(join(projDir, "images", "image_001.png"), "");
    writeFileSync(join(projDir, "audio", "narration.mp3"), "");

    const calls: string[][] = [];
    const exec = vi.fn().mockImplementation((args: string[]) => calls.push(args));
    const probe = vi.fn().mockImplementation((path: string) => {
      if (path.endsWith("clip_final.mp4")) return Promise.resolve(11);
      return Promise.resolve(12);
    });

    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "h264_amf",
      exec,
      probe,
      log: () => {},
    });

    const fused = calls.find((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && last.endsWith("video_only.mp4");
    });
    expect(fused).toBeDefined();
    const cvIdx = fused!.indexOf("-c:v");
    expect(fused![cvIdx + 1]).toBe("h264_amf");
    expect(fused).toContain("-qp_i");
    expect(fused![fused!.indexOf("-qp_i") + 1]).toBe("21");
    expect(fused).not.toContain("libx264");
  });

  it("≥2 main + ≥1 hook: videoEncoder=h264_nvenc routes NVENC args into fused exec", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_cd_nvenc_full";
    setupHookAndMain(projectsDir, videoId);

    const calls: string[][] = [];
    const exec = vi.fn().mockImplementation((args: string[]) => calls.push(args));
    const probe = vi.fn().mockImplementation((path: string) => {
      if (path.endsWith("clip_final.mp4")) return Promise.resolve(11);
      return Promise.resolve(12);
    });

    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "h264_nvenc",
      exec,
      probe,
      log: () => {},
    });

    const fused = calls.find((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && last.endsWith("video_only.mp4");
    });
    expect(fused).toBeDefined();
    const cvIdx = fused!.indexOf("-c:v");
    expect(fused![cvIdx + 1]).toBe("h264_nvenc");
    expect(fused).toContain("-cq");
    expect(fused![fused!.indexOf("-cq") + 1]).toBe("21");
    expect(fused).not.toContain("libx264");
  });

  it("≥2 main + ≥1 hook: videoEncoder=av1_nvenc routes AV1 NVENC args into fused exec", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_cd_av1nvenc_full";
    setupHookAndMain(projectsDir, videoId);

    const calls: string[][] = [];
    const exec = vi.fn().mockImplementation((args: string[]) => calls.push(args));
    const probe = vi.fn().mockImplementation((path: string) => {
      if (path.endsWith("clip_final.mp4")) return Promise.resolve(11);
      return Promise.resolve(12);
    });

    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "av1_nvenc",
      exec,
      probe,
      log: () => {},
    });

    const fused = calls.find((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && last.endsWith("video_only.mp4");
    });
    expect(fused).toBeDefined();
    const cvIdx = fused!.indexOf("-c:v");
    expect(fused![cvIdx + 1]).toBe("av1_nvenc");
    expect(fused).toContain("-cq");
    expect(fused![fused!.indexOf("-cq") + 1]).toBe("33");
    expect(fused).not.toContain("libx264");
  });

  it('emits a single "Encoder: <name>" log line at Stage CD entry', async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_cd_encoder_log";
    setupMainOnly(projectsDir, videoId, 2);

    const logged: string[] = [];
    const exec = vi.fn();
    const probe = vi.fn().mockResolvedValue(0);

    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "h264_nvenc",
      exec,
      probe,
      log: (m: string) => logged.push(m),
    });

    const encoderLogs = logged.filter((m) => m.startsWith("Encoder:"));
    expect(encoderLogs.length).toBe(1);
    expect(encoderLogs[0]).toBe("Encoder: h264_nvenc");
  });
});

describe("render() Stage B concurrency (Phase 2)", () => {
  function setupMainOnlyProject(
    projectsDir: string,
    videoId: string,
    numChunks: number
  ): string {
    const projDir = join(projectsDir, videoId);
    mkdirSync(join(projDir, "chunks"), { recursive: true });
    mkdirSync(join(projDir, "images"), { recursive: true });
    mkdirSync(join(projDir, "audio"), { recursive: true });
    const chunks: Chunk[] = [];
    for (let i = 0; i < numChunks; i++) {
      const id = `image_${String(i + 1).padStart(3, "0")}`;
      chunks.push({
        id,
        kind: "image",
        start: i * 30,
        end: (i + 1) * 30,
        text: "x",
        prompt: "p",
      });
      writeFileSync(join(projDir, "images", `${id}.png`), "");
    }
    writeFileSync(
      join(projDir, "chunks", "chunks.json"),
      JSON.stringify(chunks)
    );
    writeFileSync(join(projDir, "audio", "narration.mp3"), "");
    return projDir;
  }

  it("dispatches up to SEGMENT_CONCURRENCY segments concurrently, in chunk order regardless of completion order", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_stage_b_concurrent";
    const n = SEGMENT_CONCURRENCY + 2;
    setupMainOnlyProject(projectsDir, videoId, n);

    type Deferred = { resolve: () => void; reject: (e: unknown) => void };
    const stageBDeferreds: Deferred[] = [];
    const stageBOutPaths: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const exec = vi.fn().mockImplementation((args: string[]) => {
      const last = args[args.length - 1];
      if (typeof last === "string" && /segment_\d+\.mp4$/.test(last)) {
        stageBOutPaths.push(last);
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        return new Promise<void>((res, rej) => {
          stageBDeferreds.push({
            resolve: () => {
              inFlight--;
              res();
            },
            reject: (e: unknown) => {
              inFlight--;
              rej(e);
            },
          });
        });
      }
      return undefined;
    });
    const probe = vi.fn().mockResolvedValue(0);

    const renderPromise = render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "libx264",
      exec,
      probe,
      log: () => {},
    });

    // Initial batch should saturate the pool.
    await waitFor(
      () => stageBDeferreds.length >= SEGMENT_CONCURRENCY,
      "initial batch dispatched"
    );
    expect(stageBDeferreds.length).toBe(SEGMENT_CONCURRENCY);
    expect(inFlight).toBe(SEGMENT_CONCURRENCY);

    // Resolve the initial batch in REVERSE dispatch order — proving the pool
    // doesn't tie dispatch order to completion order.
    const firstBatch = stageBDeferreds.slice(0, SEGMENT_CONCURRENCY);
    for (let i = firstBatch.length - 1; i >= 0; i--) {
      firstBatch[i].resolve();
    }

    // Wait for the pool to refill its freed slots with the remaining chunks.
    await waitFor(
      () => stageBOutPaths.length === n,
      "all chunks dispatched"
    );

    // Drain any still-pending deferreds.
    for (let i = SEGMENT_CONCURRENCY; i < stageBDeferreds.length; i++) {
      stageBDeferreds[i].resolve();
    }

    await renderPromise;

    // (a) Concurrency never exceeded SEGMENT_CONCURRENCY at any moment.
    expect(maxInFlight).toBe(SEGMENT_CONCURRENCY);

    // (b) Dispatch order is chunk order regardless of completion order.
    expect(stageBOutPaths.length).toBe(n);
    for (let i = 0; i < n; i++) {
      const padded = String(i + 1).padStart(3, "0");
      expect(stageBOutPaths[i]).toMatch(new RegExp(`segment_${padded}\\.mp4$`));
    }
  });

  it("first Stage B error surfaces unchanged and Stage CD is not invoked", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_stage_b_first_error";
    const n = SEGMENT_CONCURRENCY + 2;
    setupMainOnlyProject(projectsDir, videoId, n);

    const ffmpegError = new Error("ffmpeg failed: bad codec");

    const exec = vi.fn().mockImplementation((args: string[]) => {
      const last = args[args.length - 1];
      if (typeof last === "string" && /segment_002\.mp4$/.test(last)) {
        return Promise.reject(ffmpegError);
      }
      if (typeof last === "string" && /segment_\d+\.mp4$/.test(last)) {
        // Other Stage B execs never resolve; pool must reject without waiting.
        return new Promise<void>(() => {});
      }
      return undefined;
    });
    const probe = vi.fn().mockResolvedValue(0);

    await expect(
      render(videoId, {
        projectsDir,
        aspectRatio: "16:9",
        longEdgePx: 1920,
        framerate: 30,
        videoEncoder: "libx264",
        exec,
        probe,
        log: () => {},
      })
    ).rejects.toBe(ffmpegError);

    // Stages CD/E must not have been invoked — only Stage B exec calls.
    const nonStageB = exec.mock.calls.filter((call) => {
      const args = call[0] as string[];
      return !args.some(
        (a) => typeof a === "string" && /segment_\d+\.mp4$/.test(a)
      );
    });
    expect(nonStageB).toHaveLength(0);
  });
});

describe("render() Stage A/B parallelism (Phase 3)", () => {
  function setupHookAndMainProject(
    projectsDir: string,
    videoId: string
  ): string {
    const projDir = join(projectsDir, videoId);
    mkdirSync(join(projDir, "chunks"), { recursive: true });
    mkdirSync(join(projDir, "images"), { recursive: true });
    mkdirSync(join(projDir, "videos", "clip"), { recursive: true });
    mkdirSync(join(projDir, "audio"), { recursive: true });
    const chunks: Chunk[] = [
      { id: "clip_01", kind: "clip", start: 0, end: 10, text: "a", prompt: "p" },
      { id: "clip_02", kind: "clip", start: 10, end: 20, text: "b", prompt: "p" },
      { id: "image_001", kind: "image", start: 20, end: 50, text: "c", prompt: "p" },
      { id: "image_002", kind: "image", start: 50, end: 75, text: "d", prompt: "p" },
    ];
    writeFileSync(join(projDir, "chunks", "chunks.json"), JSON.stringify(chunks));
    writeFileSync(join(projDir, "videos", "clip", "clip_01.mp4"), "");
    writeFileSync(join(projDir, "videos", "clip", "clip_02.mp4"), "");
    writeFileSync(join(projDir, "images", "image_001.png"), "");
    writeFileSync(join(projDir, "images", "image_002.png"), "");
    writeFileSync(join(projDir, "audio", "narration.mp3"), "");
    return projDir;
  }

  it("a Stage B segment dispatches before Stage A's clip_final exec resolves", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_stage_ab_interleave";
    setupHookAndMainProject(projectsDir, videoId);

    let clipFinalResolve: (() => void) | null = null;
    const stageBSeen: string[] = [];

    const exec = vi.fn().mockImplementation((args: string[]) => {
      const last = args[args.length - 1];
      // Hold Stage A's final exec in flight via a deferred — that exec's
      // output path is clip_final.mp4. Under sequential code, no segment
      // exec can fire until this resolves.
      if (typeof last === "string" && last.endsWith("clip_final.mp4")) {
        return new Promise<void>((res) => {
          clipFinalResolve = res;
        });
      }
      if (typeof last === "string" && /segment_\d+\.mp4$/.test(last)) {
        stageBSeen.push(last);
      }
      return undefined;
    });
    const probe = vi.fn().mockImplementation((path: string) => {
      if (path.endsWith("clip_final.mp4")) return Promise.resolve(15.5);
      return Promise.resolve(20);
    });

    const renderPromise = render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "libx264",
      exec,
      probe,
      log: () => {},
    });

    await waitFor(
      () => clipFinalResolve !== null && stageBSeen.length > 0,
      "stage A awaiting clip_final + stage B dispatched"
    );

    clipFinalResolve!();
    await renderPromise;
  });
});

describe("render() images-only topology (Phase 4)", () => {
  function setupImagesOnly(
    projectsDir: string,
    videoId: string,
    numChunks: number
  ): string {
    const projDir = join(projectsDir, videoId);
    mkdirSync(join(projDir, "chunks"), { recursive: true });
    mkdirSync(join(projDir, "images"), { recursive: true });
    mkdirSync(join(projDir, "audio"), { recursive: true });
    const chunks: Chunk[] = [];
    for (let i = 0; i < numChunks; i++) {
      const id = `image_${String(i + 1).padStart(3, "0")}`;
      chunks.push({
        id,
        kind: "image",
        start: i * 30,
        end: (i + 1) * 30,
        text: "x",
        prompt: "p",
      });
      writeFileSync(join(projDir, "images", `${id}.png`), "");
    }
    writeFileSync(
      join(projDir, "chunks", "chunks.json"),
      JSON.stringify(chunks)
    );
    writeFileSync(join(projDir, "audio", "narration.mp3"), "");
    return projDir;
  }

  it("≥2 image chunks: Stage A is fully skipped; Stage CD encodes the image xfade chain to video_only.mp4", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_images_only_multi";
    setupImagesOnly(projectsDir, videoId, 3);

    const calls: string[][] = [];
    const exec = vi
      .fn()
      .mockImplementation((args: string[]) => calls.push(args));
    const probe = vi.fn().mockResolvedValue(0);

    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "libx264",
      exec,
      probe,
      log: () => {},
    });

    // Stage A: no clip chunks ⇒ short-circuit at the top fires; nothing
    // probed, no clip_* intermediates touched.
    expect(probe).not.toHaveBeenCalled();
    const clipCalls = calls.filter((c) =>
      c.some(
        (a) =>
          typeof a === "string" &&
          (a.includes("clip_concat") ||
            a.includes("clip_final") ||
            a.includes("clip_tail"))
      )
    );
    expect(clipCalls.length).toBe(0);

    // Stage B: one segment per image chunk, in chunk order.
    const segments = calls.filter((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && /segment_\d+\.mp4$/.test(last);
    });
    expect(segments.length).toBe(3);

    // Stage CD: single fused exec emits the image xfade chain to
    // video_only.mp4. No clip normalization, no clip→image xfade.
    const videoOnlyCalls = calls.filter((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && last.endsWith("video_only.mp4");
    });
    expect(videoOnlyCalls.length).toBe(1);
    const fused = videoOnlyCalls[0];
    const filterIdx = fused.indexOf("-filter_complex");
    expect(filterIdx).toBeGreaterThan(-1);
    const filterValue = fused[filterIdx + 1];
    expect(filterValue).toContain("[0:v]settb=AVTB[seg0]");
    expect(filterValue).toContain("[seg0][seg1]xfade=");
    expect(filterValue).toContain("[vout]");
    expect(filterValue).not.toContain("[vclip]");
    expect(filterValue).not.toContain("force_original_aspect_ratio");

    // Stage E: audio mux runs.
    const mux = calls.find((c) => c.includes("-shortest"));
    expect(mux).toBeDefined();
  });

  it("1 image chunk: Stage A is fully skipped; segment_001 stream-copies to video_only.mp4", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_images_only_single";
    setupImagesOnly(projectsDir, videoId, 1);

    const calls: string[][] = [];
    const exec = vi
      .fn()
      .mockImplementation((args: string[]) => calls.push(args));
    const probe = vi.fn().mockResolvedValue(0);

    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "libx264",
      exec,
      probe,
      log: () => {},
    });

    // Stage A: skipped via the clipChunks.length === 0 short-circuit.
    expect(probe).not.toHaveBeenCalled();

    // Stage CD: stream-copy from segment_001.mp4 to video_only.mp4; no
    // filter graph, no re-encode.
    const videoOnlyCalls = calls.filter((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && last.endsWith("video_only.mp4");
    });
    expect(videoOnlyCalls.length).toBe(1);
    const stageCD = videoOnlyCalls[0];
    expect(stageCD).toContain("-c");
    expect(stageCD).toContain("copy");
    expect(stageCD.indexOf("-filter_complex")).toBe(-1);
    const iIdx = stageCD.indexOf("-i");
    expect(stageCD[iIdx + 1]).toMatch(/segment_001\.mp4$/);

    // Stage E: audio mux runs.
    const mux = calls.find((c) => c.includes("-shortest"));
    expect(mux).toBeDefined();
  });
});

describe("render() clips-only topology (Phase 4)", () => {
  function setupClipsOnly(
    projectsDir: string,
    videoId: string,
    numChunks: number
  ): string {
    const projDir = join(projectsDir, videoId);
    mkdirSync(join(projDir, "chunks"), { recursive: true });
    mkdirSync(join(projDir, "videos", "clip"), { recursive: true });
    mkdirSync(join(projDir, "audio"), { recursive: true });
    const chunks: Chunk[] = [];
    for (let i = 0; i < numChunks; i++) {
      const id = `clip_${String(i + 1).padStart(3, "0")}`;
      chunks.push({
        id,
        kind: "clip",
        start: i * 10,
        end: (i + 1) * 10,
        text: "x",
        prompt: "p",
      });
      writeFileSync(join(projDir, "videos", "clip", `${id}.mp4`), "");
    }
    writeFileSync(
      join(projDir, "chunks", "chunks.json"),
      JSON.stringify(chunks)
    );
    writeFileSync(join(projDir, "audio", "narration.mp3"), "");
    return projDir;
  }

  it("Stage CD stream-copies clip_final.mp4 to video_only.mp4 with no filter graph", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_clips_only_stage_cd";
    setupClipsOnly(projectsDir, videoId, 2);

    const calls: string[][] = [];
    const exec = vi
      .fn()
      .mockImplementation((args: string[]) => calls.push(args));
    // Per-clip probes (V ≥ A → no padding). Note: clip_final.mp4 should
    // NOT be probed in the clips-only case — the new sub-case bypasses
    // the xfade timing logic.
    const probe = vi.fn().mockResolvedValue(12);

    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "libx264",
      exec,
      probe,
      log: () => {},
    });

    // Stage CD: single exec writes video_only.mp4 via stream copy from
    // clip_final.mp4. No filter_complex, no encoder args.
    const videoOnlyCalls = calls.filter((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && last.endsWith("video_only.mp4");
    });
    expect(videoOnlyCalls.length).toBe(1);
    const stageCD = videoOnlyCalls[0];
    expect(stageCD).toContain("-c");
    expect(stageCD).toContain("copy");
    expect(stageCD.indexOf("-filter_complex")).toBe(-1);
    const iIdx = stageCD.indexOf("-i");
    expect(stageCD[iIdx + 1]).toMatch(/clip_final\.mp4$/);

    // clip_final.mp4 is not probed (no xfade offset to compute).
    const clipFinalProbes = probe.mock.calls.filter((call) => {
      const p = call[0] as string;
      return p.endsWith("clip_final.mp4");
    });
    expect(clipFinalProbes.length).toBe(0);
  });

  it("Stage B emits no segments when there are no image chunks", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_clips_only_stage_b";
    setupClipsOnly(projectsDir, videoId, 2);

    const calls: string[][] = [];
    const exec = vi
      .fn()
      .mockImplementation((args: string[]) => calls.push(args));
    const probe = vi.fn().mockResolvedValue(12);

    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "libx264",
      exec,
      probe,
      log: () => {},
    });

    const segments = calls.filter((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && /segment_\d+\.mp4$/.test(last);
    });
    expect(segments.length).toBe(0);
  });

  it("Stage A skips the held-frame tail and produces clip_final.mp4 directly when imageChunks is empty", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_clips_only_no_tail";
    setupClipsOnly(projectsDir, videoId, 2);

    const calls: string[][] = [];
    const exec = vi
      .fn()
      .mockImplementation((args: string[]) => calls.push(args));
    const probe = vi.fn().mockResolvedValue(12);

    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "libx264",
      exec,
      probe,
      log: () => {},
    });

    // The tail bridge is meaningless without a Stage CD xfade — these
    // intermediates should not be touched at all.
    const tailCalls = calls.filter((c) =>
      c.some(
        (a) =>
          typeof a === "string" &&
          (a.includes("clip_tail") || a.includes("clip_concat"))
      )
    );
    expect(tailCalls.length).toBe(0);

    // The concat-demuxer call (-f concat) writes clip_final.mp4 directly.
    const concatCalls = calls.filter((c) => {
      const fIdx = c.indexOf("-f");
      return fIdx > -1 && c[fIdx + 1] === "concat";
    });
    expect(concatCalls.length).toBe(1);
    const concat = concatCalls[0];
    expect(concat[concat.length - 1]).toMatch(/clip_final\.mp4$/);
  });

  it("clips-only end-to-end: Stage A → Stage CD stream-copy → Stage E mux", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_clips_only_end_to_end";
    setupClipsOnly(projectsDir, videoId, 3);

    const calls: string[][] = [];
    const exec = vi
      .fn()
      .mockImplementation((args: string[]) => calls.push(args));
    const probe = vi.fn().mockResolvedValue(12);

    await render(videoId, {
      projectsDir,
      aspectRatio: "16:9",
      longEdgePx: 1920,
      framerate: 30,
      videoEncoder: "libx264",
      exec,
      probe,
      log: () => {},
    });

    // Stage A timed-clip renders, one per chunk.
    const timedClips = calls.filter((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && /clip_\d+_timed\.mp4$/.test(last);
    });
    expect(timedClips.length).toBe(3);

    // Stage E: audio mux runs.
    const mux = calls.find((c) => c.includes("-shortest"));
    expect(mux).toBeDefined();
  });
});
