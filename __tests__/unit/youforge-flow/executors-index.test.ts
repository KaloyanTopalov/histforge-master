import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Dispatcher = {
  executeTaskViaAPI: (
    task: Record<string, unknown>,
    tabId: number,
    correlationId?: string,
  ) => Promise<unknown>;
};

type ExecSpy = ReturnType<typeof vi.fn>;

function loadDispatcher(overrides: {
  storage?: Record<string, unknown>;
  accountTier?: string;
  modelKeys?: Record<string, unknown>;
  projectId?: string | null;
  sessionToken?: string | null;
  recaptcha?: (action: string) => string | null;
} = {}) {
  const src = readFileSync(
    path.resolve(
      process.cwd(),
      "extensions/youforge-flow/src/executors/index.js",
    ),
    "utf8",
  );
  const invocations: Array<{ which: string; task: unknown; ctx: unknown }> = [];
  const make = (which: string): ExecSpy =>
    vi.fn(async (task: unknown, ctx: unknown) => {
      invocations.push({ which, task, ctx });
      return { taskId: (task as { id: string }).id, resultUrl: `out-${which}`, mode: which };
    });
  const runImageGen = make("image");
  const runTextToVideo = make("text-to-video");
  const runImageToVideo = make("image-to-video");
  const runFramesToVideo = make("frames-to-video");

  const storage = overrides.storage ?? {
    outputCount: 1,
    aspectRatio: "landscape",
    imageModel: "NARWHAL",
    videoModel: "fast",
    imgUpscale: "none",
    vidUpscale: "none",
  };
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    forTask: () => ({ safeLog: () => {} }),
    assertNotStopped: () => {},
    getRecaptchaTokenFromPage: vi.fn(async (_tab: number, action: string) =>
      overrides.recaptcha ? overrides.recaptcha(action) : `rc-${action}`,
    ),
    getSessionTokenFromPage: vi.fn(async () =>
      overrides.sessionToken === undefined ? "bearer-abc" : overrides.sessionToken,
    ),
    getOrCreateProjectId: vi.fn(async () =>
      overrides.projectId === undefined ? "proj-xyz" : overrides.projectId,
    ),
    detectAccountTier: vi.fn(async () => overrides.accountTier ?? "ultra"),
    getVideoModelKeys: vi.fn(() =>
      overrides.modelKeys ?? {
        t2v: "veo_3_1_t2v_fast_ultra",
        r2v: "veo_3_1_r2v_fast_landscape_ultra",
        i2v: "veo_3_1_i2v_s_fast_ultra",
        i2v_fl: "veo_3_1_i2v_s_fast_ultra_fl",
        paygateTier: "PAYGATE_TIER_TWO",
        isLite: false,
      },
    ),
    imageModelDisplay: (key: string) => key,
    videoModelDisplay: (key: string) => key,
    apiCallViaPage: vi.fn(),
    uploadImageViaPage: vi.fn(),
    pollVideoUntilDone: vi.fn(),
    getStopFlag: () => false,
    getOutputCount: () => (storage.outputCount ?? 1),
    getAspectRatio: () => (storage.aspectRatio ?? "landscape"),
    getImageModel: () => (storage.imageModel ?? "NARWHAL"),
    getVideoModel: () => (storage.videoModel ?? "fast"),
    getImgUpscale: () => (storage.imgUpscale ?? "none"),
    getVidUpscale: () => (storage.vidUpscale ?? "none"),
    crypto: globalThis.crypto,
    runImageGen,
    runTextToVideo,
    runImageToVideo,
    runFramesToVideo,
    decrementActiveCount: (_bucket: string) => {},
    getActiveCount: (_bucket: string) => 0,
    getMaxConcurrent: (_bucket: string) => 4,
    pollForTasksFIFO: (_bucket: string) => {},
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
    Date: { now: () => 1000 },
    chrome: {
      storage: {
        local: {
          get: vi.fn(async () => storage),
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return {
    mod: sandbox as unknown as Dispatcher,
    invocations,
    runImageGen,
    runTextToVideo,
    runImageToVideo,
    runFramesToVideo,
    recaptchaSpy: sandbox.getRecaptchaTokenFromPage as ExecSpy,
  };
}

describe("executeTaskViaAPI dispatcher", () => {
  it("routes createimage mode to runImageGen", async () => {
    const ctx = loadDispatcher();
    await ctx.mod.executeTaskViaAPI(
      { id: "t1", mode: "createimage", imagePrompt: "p" },
      1,
    );
    expect(ctx.runImageGen).toHaveBeenCalledTimes(1);
    expect(ctx.runTextToVideo).not.toHaveBeenCalled();
  });

  it("routes imagegen mode to runImageGen", async () => {
    const ctx = loadDispatcher();
    await ctx.mod.executeTaskViaAPI(
      { id: "t1", mode: "imagegen", imagePrompt: "p" },
      1,
    );
    expect(ctx.runImageGen).toHaveBeenCalledTimes(1);
  });

  it("routes text mode to runTextToVideo", async () => {
    const ctx = loadDispatcher();
    await ctx.mod.executeTaskViaAPI(
      { id: "t1", mode: "text", prompt: "p" },
      1,
    );
    expect(ctx.runTextToVideo).toHaveBeenCalledTimes(1);
  });

  it("routes image mode with reference to runImageToVideo", async () => {
    const ctx = loadDispatcher();
    await ctx.mod.executeTaskViaAPI(
      { id: "t1", mode: "image", prompt: "p", referenceImage: "a.png" },
      1,
    );
    expect(ctx.runImageToVideo).toHaveBeenCalledTimes(1);
  });

  it("routes ingredients mode with reference to runImageToVideo", async () => {
    const ctx = loadDispatcher();
    await ctx.mod.executeTaskViaAPI(
      { id: "t1", mode: "ingredients", prompt: "p", referenceImage: "a.png" },
      1,
    );
    expect(ctx.runImageToVideo).toHaveBeenCalledTimes(1);
  });

  it("routes frames mode with startFrame to runFramesToVideo", async () => {
    const ctx = loadDispatcher();
    await ctx.mod.executeTaskViaAPI(
      { id: "t1", mode: "frames", prompt: "p", startFrame: "s.png" },
      1,
    );
    expect(ctx.runFramesToVideo).toHaveBeenCalledTimes(1);
  });

  it("falls back to runTextToVideo when image mode has no image fields", async () => {
    const ctx = loadDispatcher();
    await ctx.mod.executeTaskViaAPI(
      { id: "t1", mode: "image", prompt: "p" },
      1,
    );
    expect(ctx.runTextToVideo).toHaveBeenCalledTimes(1);
    expect(ctx.runImageToVideo).not.toHaveBeenCalled();
  });

  it("falls back to runTextToVideo when frames mode has no startFrame", async () => {
    const ctx = loadDispatcher();
    await ctx.mod.executeTaskViaAPI(
      { id: "t1", mode: "frames", prompt: "p" },
      1,
    );
    expect(ctx.runTextToVideo).toHaveBeenCalledTimes(1);
    expect(ctx.runFramesToVideo).not.toHaveBeenCalled();
  });

  it("falls back to runTextToVideo on unknown mode", async () => {
    const ctx = loadDispatcher();
    await ctx.mod.executeTaskViaAPI(
      { id: "t1", mode: "nosuch", prompt: "p" },
      1,
    );
    expect(ctx.runTextToVideo).toHaveBeenCalledTimes(1);
  });

  it("recognises `Start Frame` / `Image URL` task keys for image-presence check", async () => {
    const ctx = loadDispatcher();
    await ctx.mod.executeTaskViaAPI(
      { id: "t1", mode: "image", prompt: "p", "Image URL": "a.png" },
      1,
    );
    expect(ctx.runImageToVideo).toHaveBeenCalledTimes(1);
  });

  it("requests IMAGE_GENERATION reCAPTCHA for image-gen modes", async () => {
    const ctx = loadDispatcher();
    await ctx.mod.executeTaskViaAPI(
      { id: "t1", mode: "createimage", imagePrompt: "p" },
      1,
    );
    expect(ctx.recaptchaSpy).toHaveBeenCalledWith(1, "IMAGE_GENERATION");
  });

  it("requests VIDEO_GENERATION reCAPTCHA for non-image modes", async () => {
    const ctx = loadDispatcher();
    await ctx.mod.executeTaskViaAPI(
      { id: "t1", mode: "text", prompt: "p" },
      1,
    );
    expect(ctx.recaptchaSpy).toHaveBeenCalledWith(1, "VIDEO_GENERATION");
  });

  it("builds a ctx with recaptchaToken, projectId, sessionId, pageCall, uploadImage, getRecaptcha", async () => {
    const ctx = loadDispatcher();
    await ctx.mod.executeTaskViaAPI(
      { id: "t1", mode: "text", prompt: "p" },
      1,
    );
    const { ctx: passed } = ctx.invocations[0] as {
      ctx: {
        recaptchaToken: string;
        projectId: string;
        sessionId: string;
        authToken: string;
        modelKeys: unknown;
        settings: { imgUpscale: string };
        pageCall: unknown;
        uploadImage: unknown;
        getRecaptcha: unknown;
        pollVideo: unknown;
      };
    };
    expect(passed.recaptchaToken).toBe("rc-VIDEO_GENERATION");
    expect(passed.projectId).toBe("proj-xyz");
    expect(passed.authToken).toBe("bearer-abc");
    expect(passed.sessionId).toMatch(/^;/);
    expect(typeof passed.pageCall).toBe("function");
    expect(typeof passed.uploadImage).toBe("function");
    expect(typeof passed.getRecaptcha).toBe("function");
    expect(typeof passed.pollVideo).toBe("function");
    expect(passed.settings.imgUpscale).toBe("none");
  });

  it("throws when reCAPTCHA token cannot be fetched", async () => {
    const ctx = loadDispatcher({ recaptcha: () => null });
    await expect(
      ctx.mod.executeTaskViaAPI({ id: "t1", mode: "text", prompt: "p" }, 1),
    ).rejects.toThrow(/reCAPTCHA/);
  });

  it("throws when session token cannot be fetched", async () => {
    const ctx = loadDispatcher({ sessionToken: null });
    await expect(
      ctx.mod.executeTaskViaAPI({ id: "t1", mode: "text", prompt: "p" }, 1),
    ).rejects.toThrow(/session/);
  });

  it("throws when projectId cannot be resolved", async () => {
    const ctx = loadDispatcher({ projectId: null });
    await expect(
      ctx.mod.executeTaskViaAPI({ id: "t1", mode: "text", prompt: "p" }, 1),
    ).rejects.toThrow(/project/);
  });

  it("returns the executor's result with correlationId + timings attached", async () => {
    const ctx = loadDispatcher();
    const out = await ctx.mod.executeTaskViaAPI(
      { id: "t1", mode: "text", prompt: "p" },
      1,
      "cid-test-1234",
    );
    expect(out).toMatchObject({
      taskId: "t1",
      resultUrl: "out-text-to-video",
      mode: "text-to-video",
      correlationId: "cid-test-1234",
    });
    expect((out as { timings: Record<string, unknown> }).timings).toBeDefined();
  });

  it("attaches correlationId + timings to ctx passed into executors", async () => {
    const ctx = loadDispatcher();
    await ctx.mod.executeTaskViaAPI(
      { id: "t1", mode: "text", prompt: "p" },
      1,
      "cid-abcd-1234",
    );
    const { ctx: passed } = ctx.invocations[0] as {
      ctx: {
        correlationId: string;
        timings: {
          submitMs: number;
          uploadMs: number[];
          pollCount: number;
          pollMs: number;
          upscaleMs: number;
          fetchMediaMs: number;
        };
      };
    };
    expect(passed.correlationId).toBe("cid-abcd-1234");
    expect(passed.timings).toBeDefined();
    expect(passed.timings.uploadMs).toEqual([]);
    expect(passed.timings.submitMs).toBe(0);
    expect(passed.timings.pollCount).toBe(0);
    expect(passed.timings.pollMs).toBe(0);
    expect(passed.timings.upscaleMs).toBe(0);
    expect(passed.timings.fetchMediaMs).toBe(0);
  });
});
