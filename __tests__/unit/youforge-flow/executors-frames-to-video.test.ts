import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type FramesToVideo = {
  runFramesToVideo: (
    task: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => Promise<{ taskId: string; resultUrl: string; mode: string }>;
};

function loadExec() {
  const files = [
    "extensions/youforge-flow/src/client-context.js",
    "extensions/youforge-flow/src/executors/upscale.js",
    "extensions/youforge-flow/src/executors/shared.js",
    "extensions/youforge-flow/src/executors/frames-to-video.js",
  ];
  const src = files
    .map((f) => readFileSync(path.resolve(process.cwd(), f), "utf8"))
    .join("\n");
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    assertNotStopped: () => {},
    crypto: { randomUUID: () => "uuid-1" },
    Math,
    JSON,
    Promise,
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
    AISANDBOX_BASE: "https://aisandbox-pa.googleapis.com/v1",
    postOperationStarted: () => Promise.resolve(true),
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox as unknown as FramesToVideo;
}

function baseCtx(overrides: Record<string, unknown> = {}) {
  return {
    tabId: 1,
    authToken: "bearer",
    projectId: "p",
    sessionId: ";1",
    recaptchaToken: "rc-main",
    modelKeys: {
      t2v: "veo_3_1_t2v",
      r2v: "veo_3_1_r2v_fast_landscape_ultra",
      i2v: "veo_3_1_i2v_s_fast_ultra",
      i2v_fl: "veo_3_1_i2v_s_fast_ultra_fl",
      isLite: false,
      paygateTier: "PAYGATE_TIER_TWO",
    },
    settings: {
      aspectRatioSetting: "landscape",
      vidUpscale: "none",
    },
    pageCall: vi.fn().mockResolvedValue({ media: [{ name: "m1" }] }),
    uploadImage: vi.fn(async (url: string, name: string) => `mid-${name}`),
    getRecaptcha: vi.fn().mockResolvedValue("rc-refresh"),
    pollVideo: vi.fn().mockResolvedValue(["vid-url"]),
    ...overrides,
  };
}

describe("runFramesToVideo", () => {
  it("with start+end frames uses StartAndEndImage endpoint + i2v_fl model", async () => {
    const mod = loadExec();
    const ctx = baseCtx();
    await mod.runFramesToVideo(
      {
        id: "t", mode: "frames", prompt: "p",
        startFrame: "start.png", endFrame: "end.png",
      },
      ctx,
    );
    const pageCall = ctx.pageCall as ReturnType<typeof vi.fn>;
    const [url, body] = pageCall.mock.calls[0];
    expect(url).toContain("batchAsyncGenerateVideoStartAndEndImage");
    expect(body.requests[0].videoModelKey).toBe("veo_3_1_i2v_s_fast_ultra_fl");
    expect(body.requests[0].startImage.mediaId).toBe("mid-start_frame.png");
    expect(body.requests[0].endImage.mediaId).toBe("mid-end_frame.png");
  });

  it("accepts `Start Frame` / `End Frame` task keys as fallbacks", async () => {
    const mod = loadExec();
    const ctx = baseCtx();
    await mod.runFramesToVideo(
      {
        id: "t", mode: "frames", prompt: "p",
        "Start Frame": "s.png", "End Frame": "e.png",
      },
      ctx,
    );
    const uploadImage = ctx.uploadImage as ReturnType<typeof vi.fn>;
    expect(uploadImage).toHaveBeenCalledWith("s.png", "start_frame.png");
    expect(uploadImage).toHaveBeenCalledWith("e.png", "end_frame.png");
  });

  it("Lite + start-only uses StartImage endpoint with i2v model", async () => {
    const mod = loadExec();
    const ctx = baseCtx({
      modelKeys: {
        t2v: "veo_3_1_t2v_lite",
        r2v: "veo_3_1_i2v_lite",
        i2v: "veo_3_1_i2v_lite",
        i2v_fl: "veo_3_1_i2v_lite",
        isLite: true,
        paygateTier: "PAYGATE_TIER_TWO",
      },
    });
    await mod.runFramesToVideo(
      { id: "t", mode: "frames", prompt: "p", startFrame: "s.png" },
      ctx,
    );
    const pageCall = ctx.pageCall as ReturnType<typeof vi.fn>;
    const [url, body] = pageCall.mock.calls[0];
    expect(url).toContain("batchAsyncGenerateVideoStartImage");
    expect(body.requests[0].videoModelKey).toBe("veo_3_1_i2v_lite");
    expect(body.requests[0].startImage.mediaId).toBe("mid-start_frame.png");
  });

  it("non-Lite + start-only uses ReferenceImages endpoint with r2v model", async () => {
    const mod = loadExec();
    const ctx = baseCtx();
    await mod.runFramesToVideo(
      { id: "t", mode: "frames", prompt: "p", startFrame: "s.png" },
      ctx,
    );
    const pageCall = ctx.pageCall as ReturnType<typeof vi.fn>;
    const [url, body] = pageCall.mock.calls[0];
    expect(url).toContain("batchAsyncGenerateVideoReferenceImages");
    expect(body.requests[0].videoModelKey).toBe("veo_3_1_r2v_fast_landscape_ultra");
    expect(body.requests[0].referenceImages).toEqual([
      { mediaId: "mid-start_frame.png", imageUsageType: "IMAGE_USAGE_TYPE_ASSET" },
    ]);
  });
});
