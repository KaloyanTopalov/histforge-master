import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Shared = {
  toMediaIds: (
    result: { media?: Array<{ name?: string }> } | undefined,
    projectId: string,
  ) => Array<{ name: string; projectId: string }>;
  upscaleImages: (
    urls: string[],
    result: { media?: Array<{ name?: string; image?: unknown }> },
    ctx: Record<string, unknown>,
  ) => Promise<void>;
  upscaleVideos: (
    videoUrls: string[],
    startResult: { mediaIds?: Array<{ name: string; projectId: string }>; raw?: unknown },
    ctx: Record<string, unknown>,
  ) => Promise<void>;
  runVideoGeneration: (
    task: Record<string, unknown>,
    ctx: Record<string, unknown>,
    config: {
      endpoint: string;
      videoModelKey: string;
      perRequestExtras: Record<string, unknown>;
      mode: string;
    },
  ) => Promise<{ taskId: string; resultUrl: string; mode: string }>;
};

function loadShared(overrides: Record<string, unknown> = {}) {
  const files = [
    "extensions/youforge-flow/src/http.js",
    "extensions/youforge-flow/src/client-context.js",
    "extensions/youforge-flow/src/executors/upscale.js",
    "extensions/youforge-flow/src/executors/shared.js",
  ];
  const src = files
    .map((f) => readFileSync(path.resolve(process.cwd(), f), "utf8"))
    .join("\n");
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    assertNotStopped: () => {},
    // Runner-owned global; shared.js calls this once before the first
    // upscale attempt to free a slot for the next task.
    markVideoSlotFreedForUpscale: vi.fn(),
    getUpscaleMaxAttempts: () => 3,
    crypto: { randomUUID: () => "uuid-test" },
    AbortController,
    AbortSignal,
    clearTimeout: () => {},
    fetch: () => Promise.resolve({} as Response),
    Math,
    JSON,
    Promise,
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
    AISANDBOX_BASE: "https://aisandbox-pa.googleapis.com/v1",
    // Default fire-and-forget stub. Tests that exercise the
    // runVideoGeneration submit/resume paths inject their own spy.
    postOperationStarted: () => Promise.resolve(true),
    ...overrides,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox as unknown as Shared & Record<string, unknown>;
}

describe("executors/shared", () => {
  describe("toMediaIds", () => {
    it("maps result.media entries to {name, projectId} pairs", () => {
      const mod = loadShared();
      const out = mod.toMediaIds(
        { media: [{ name: "m1" }, { name: "m2" }] },
        "proj-1",
      );
      expect(out).toEqual([
        { name: "m1", projectId: "proj-1" },
        { name: "m2", projectId: "proj-1" },
      ]);
    });

    it("returns [] when result.media is missing", () => {
      const mod = loadShared();
      expect(mod.toMediaIds({}, "proj-1")).toEqual([]);
      expect(mod.toMediaIds(undefined, "proj-1")).toEqual([]);
    });
  });

  describe("upscaleImages", () => {
    it("no-ops when imgUpscale is 'none'", async () => {
      const pageCall = vi.fn();
      const mod = loadShared();
      const urls = ["original-url"];
      await mod.upscaleImages(
        urls,
        { media: [{ name: "m1" }] },
        {
          pageCall,
          getRecaptcha: vi.fn(),
          projectId: "p",
          sessionId: "s",
          modelKeys: { paygateTier: "PAYGATE_TIER_TWO" },
          settings: { imgUpscale: "none" },
          sleep: vi.fn(),
        },
      );
      expect(pageCall).not.toHaveBeenCalled();
      expect(urls).toEqual(["original-url"]);
    });

    it("replaces url with upscaled fifeUrl on success", async () => {
      const pageCall = vi.fn().mockResolvedValue({
        media: { image: { generatedImage: { fifeUrl: "upscaled-url" } } },
      });
      const mod = loadShared();
      const urls = ["original-url"];
      await mod.upscaleImages(
        urls,
        { media: [{ name: "m1", image: { generatedImage: { fifeUrl: "original-url" } } }] },
        {
          pageCall,
          getRecaptcha: vi.fn().mockResolvedValue("rc-x"),
          projectId: "p",
          sessionId: "s",
          modelKeys: { paygateTier: "PAYGATE_TIER_TWO" },
          settings: { imgUpscale: "2k" },
          sleep: vi.fn(),
        },
      );
      expect(urls).toEqual(["upscaled-url"]);
      expect(pageCall).toHaveBeenCalledWith(
        expect.stringContaining("upsampleImage"),
        expect.objectContaining({ targetResolution: "UPSAMPLE_IMAGE_RESOLUTION_2K" }),
      );
    });

    it("falls back 4K→2K on 403 and retries without consuming an attempt", async () => {
      let call = 0;
      const pageCall = vi.fn(async (_url, body: { targetResolution: string }) => {
        call += 1;
        if (call === 1) {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw new Error("HTTP 403 forbidden");
        }
        return {
          media: { image: { generatedImage: { fifeUrl: `up-${body.targetResolution}` } } },
        };
      });
      const mod = loadShared();
      const urls = ["original-url"];
      await mod.upscaleImages(
        urls,
        { media: [{ name: "m1", image: { generatedImage: { fifeUrl: "original-url" } } }] },
        {
          pageCall,
          getRecaptcha: vi.fn().mockResolvedValue("rc-x"),
          projectId: "p",
          sessionId: "s",
          modelKeys: { paygateTier: "PAYGATE_TIER_TWO" },
          settings: { imgUpscale: "4k" },
          sleep: vi.fn(),
        },
      );
      expect(urls[0]).toBe("up-UPSAMPLE_IMAGE_RESOLUTION_2K");
      expect(pageCall).toHaveBeenCalledTimes(2);
    });
  });

  describe("upscaleVideos", () => {
    it("no-ops when vidUpscale is 'none'", async () => {
      const pageCall = vi.fn();
      const pollVideo = vi.fn();
      const mod = loadShared();
      const videoUrls = ["orig"];
      await mod.upscaleVideos(
        videoUrls,
        { mediaIds: [{ name: "m1", projectId: "p" }], raw: {} },
        {
          pageCall,
          pollVideo,
          getRecaptcha: vi.fn(),
          authToken: "bearer",
          projectId: "p",
          sessionId: "s",
          modelKeys: { paygateTier: "PAYGATE_TIER_TWO" },
          settings: { vidUpscale: "none", aspectRatioSetting: "landscape" },
          sleep: vi.fn(),
        },
      );
      expect(pageCall).not.toHaveBeenCalled();
      expect(pollVideo).not.toHaveBeenCalled();
      expect(videoUrls).toEqual(["orig"]);
    });

    it("calls markVideoSlotFreedForUpscale before the first upscale attempt", async () => {
      const pageCall = vi.fn().mockResolvedValue({ media: [{ name: "m1-up" }] });
      const pollVideo = vi.fn().mockResolvedValue(["up-url"]);
      const markVideoSlotFreedForUpscale = vi.fn();
      const mod = loadShared({ markVideoSlotFreedForUpscale });
      const videoUrls = ["orig"];
      await mod.upscaleVideos(
        videoUrls,
        { mediaIds: [{ name: "m1", projectId: "p" }], raw: { workflows: [{ name: "wf" }] } },
        {
          pageCall,
          pollVideo,
          getRecaptcha: vi.fn().mockResolvedValue("rc"),
          authToken: "bearer",
          projectId: "p",
          sessionId: "s",
          taskId: "t1",
          modelKeys: { paygateTier: "PAYGATE_TIER_TWO" },
          settings: { vidUpscale: "1080p", aspectRatioSetting: "landscape" },
          sleep: vi.fn(),
        },
      );
      expect(markVideoSlotFreedForUpscale).toHaveBeenCalledTimes(1);
      expect(videoUrls).toEqual(["up-url"]);
    });

    it("falls back 4K→1080p and swaps upscaler model on 403", async () => {
      let call = 0;
      const bodies: Array<{ resolution: string; videoModelKey: string }> = [];
      const pageCall = vi.fn(async (_url, body: { requests: Array<{ resolution: string; videoModelKey: string }> }) => {
        bodies.push(body.requests[0]);
        call += 1;
        if (call === 1) {
          throw new Error("HTTP 403 forbidden");
        }
        return { media: [{ name: "m1-up" }] };
      });
      const pollVideo = vi.fn().mockResolvedValue(["up-url-1080"]);
      const mod = loadShared();
      const videoUrls = ["orig"];
      await mod.upscaleVideos(
        videoUrls,
        { mediaIds: [{ name: "m1", projectId: "p" }], raw: {} },
        {
          pageCall,
          pollVideo,
          getRecaptcha: vi.fn().mockResolvedValue("rc"),
          authToken: "bearer",
          projectId: "p",
          sessionId: "s",
          taskId: "t1",
          modelKeys: { paygateTier: "PAYGATE_TIER_TWO" },
          settings: { vidUpscale: "4k", aspectRatioSetting: "landscape" },
          sleep: vi.fn(),
        },
      );
      expect(videoUrls).toEqual(["up-url-1080"]);
      expect(bodies[0].resolution).toBe("VIDEO_RESOLUTION_4K");
      expect(bodies[0].videoModelKey).toBe("veo_3_1_upsampler_4k");
      expect(bodies[1].resolution).toBe("VIDEO_RESOLUTION_1080P");
      expect(bodies[1].videoModelKey).toBe("veo_3_1_upsampler_1080p");
    });
  });

  describe("runVideoGeneration", () => {
    function makeCtx(overrides: Record<string, unknown> = {}) {
      return {
        projectId: "proj-1",
        sessionId: ";1",
        recaptchaToken: "rc",
        modelKeys: { paygateTier: "PAYGATE_TIER_TWO" },
        settings: { aspectRatioSetting: "landscape", vidUpscale: "none" },
        authToken: "bearer",
        timings: {},
        log: { safeLog: () => {} },
        ...overrides,
      };
    }

    it("fires postOperationStarted with the first mediaId after submit", async () => {
      const postOperationStarted = vi.fn(() => Promise.resolve(true));
      const pageCall = vi.fn().mockResolvedValue({
        media: [{ name: "op-name-1" }, { name: "op-name-2" }],
      });
      const pollVideo = vi.fn().mockResolvedValue(["video-url"]);
      const mod = loadShared({ postOperationStarted });
      const result = await mod.runVideoGeneration(
        { id: "task-1", prompt: "hello" },
        makeCtx({ pageCall, pollVideo }),
        { endpoint: "https://example/submit", videoModelKey: "veo-key", perRequestExtras: {}, mode: "text" },
      );
      expect(postOperationStarted).toHaveBeenCalledTimes(1);
      expect(postOperationStarted).toHaveBeenCalledWith({
        taskId: "task-1",
        operationName: "op-name-1",
        projectId: "proj-1",
      });
      expect(result.resultUrl).toBe("video-url");
    });

    it("skips submit and polls the stored operation when task.googleOperationId is set", async () => {
      const postOperationStarted = vi.fn();
      const pageCall = vi.fn();
      const pollVideo = vi.fn().mockResolvedValue(["resumed-url"]);
      const mod = loadShared({ postOperationStarted });
      const result = await mod.runVideoGeneration(
        {
          id: "task-1",
          prompt: "hello",
          googleOperationId: "stored-op",
          googleOperationProjectId: "stored-proj",
        },
        makeCtx({ pageCall, pollVideo }),
        { endpoint: "https://example/submit", videoModelKey: "veo-key", perRequestExtras: {}, mode: "text" },
      );
      expect(pageCall).not.toHaveBeenCalled();
      expect(postOperationStarted).not.toHaveBeenCalled();
      expect(pollVideo).toHaveBeenCalledTimes(1);
      expect(pollVideo).toHaveBeenCalledWith(
        "bearer",
        [{ name: "stored-op", projectId: "stored-proj" }],
        "task-1",
      );
      expect(result.resultUrl).toBe("resumed-url");
    });

    it("falls back to fresh submit when stored-operation poll throws NOT_FOUND", async () => {
      const postOperationStarted = vi.fn(() => Promise.resolve(true));
      const pageCall = vi.fn().mockResolvedValue({ media: [{ name: "fresh-op" }] });
      const pollVideo = vi.fn(async (_at, mediaIds: Array<{ name: string }>) => {
        if (mediaIds[0].name === "stored-op") {
          const e: Error & { category?: string } = new Error("not found");
          e.category = "not_found";
          throw e;
        }
        return ["fresh-url"];
      });
      const mod = loadShared({ postOperationStarted });
      const task: Record<string, unknown> = {
        id: "task-1",
        prompt: "hello",
        googleOperationId: "stored-op",
        googleOperationProjectId: "stored-proj",
      };
      const result = await mod.runVideoGeneration(
        task,
        makeCtx({ pageCall, pollVideo }),
        { endpoint: "https://example/submit", videoModelKey: "veo-key", perRequestExtras: {}, mode: "text" },
      );
      expect(pageCall).toHaveBeenCalledTimes(1);
      expect(pollVideo).toHaveBeenCalledTimes(2);
      expect(postOperationStarted).toHaveBeenCalledWith({
        taskId: "task-1",
        operationName: "fresh-op",
        projectId: "proj-1",
      });
      expect(task.googleOperationId).toBeNull();
      expect(result.resultUrl).toBe("fresh-url");
    });

    it("propagates non-NOT_FOUND errors from the resume poll without falling back", async () => {
      const postOperationStarted = vi.fn();
      const pageCall = vi.fn();
      const pollVideo = vi.fn(async () => {
        const e: Error & { category?: string } = new Error("rate limited");
        e.category = "rate_limit";
        throw e;
      });
      const mod = loadShared({ postOperationStarted });
      await expect(
        mod.runVideoGeneration(
          {
            id: "task-1",
            prompt: "hello",
            googleOperationId: "stored-op",
            googleOperationProjectId: "stored-proj",
          },
          makeCtx({ pageCall, pollVideo }),
          { endpoint: "https://example/submit", videoModelKey: "veo-key", perRequestExtras: {}, mode: "text" },
        ),
      ).rejects.toThrow("rate limited");
      expect(pageCall).not.toHaveBeenCalled();
      expect(postOperationStarted).not.toHaveBeenCalled();
    });
  });
});
