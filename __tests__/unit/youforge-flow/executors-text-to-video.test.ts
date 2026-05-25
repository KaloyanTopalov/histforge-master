import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type TextToVideo = {
  runTextToVideo: (
    task: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => Promise<{ taskId: string; resultUrl: string; mode: string }>;
};

function loadExec() {
  const files = [
    "extensions/youforge-flow/src/client-context.js",
    "extensions/youforge-flow/src/executors/upscale.js",
    "extensions/youforge-flow/src/executors/shared.js",
    "extensions/youforge-flow/src/executors/text-to-video.js",
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
  return sandbox as unknown as TextToVideo;
}

function baseCtx(overrides: Record<string, unknown> = {}) {
  return {
    tabId: 1,
    authToken: "bearer",
    projectId: "p",
    sessionId: ";1",
    recaptchaToken: "rc-main",
    modelKeys: {
      t2v: "veo_3_1_t2v_fast_ultra",
      paygateTier: "PAYGATE_TIER_TWO",
    },
    settings: {
      aspectRatioSetting: "landscape",
      vidUpscale: "none",
    },
    pageCall: vi.fn().mockResolvedValue({ media: [{ name: "m1" }] }),
    uploadImage: vi.fn(),
    getRecaptcha: vi.fn().mockResolvedValue("rc-refresh"),
    pollVideo: vi.fn().mockResolvedValue(["vid-url"]),
    ...overrides,
  };
}

describe("runTextToVideo", () => {
  it("posts to the text-to-video endpoint with the t2v model key", async () => {
    const mod = loadExec();
    const ctx = baseCtx();
    const out = await mod.runTextToVideo(
      { id: "task-1", mode: "text", prompt: "a windmill" },
      ctx,
    );
    const pageCall = ctx.pageCall as ReturnType<typeof vi.fn>;
    expect(pageCall).toHaveBeenCalledWith(
      expect.stringContaining("video:batchAsyncGenerateVideoText"),
      expect.objectContaining({
        requests: expect.arrayContaining([
          expect.objectContaining({
            videoModelKey: "veo_3_1_t2v_fast_ultra",
            textInput: { structuredPrompt: { parts: [{ text: "a windmill" }] } },
          }),
        ]),
      }),
    );
    expect(out.taskId).toBe("task-1");
    expect(out.resultUrl).toBe("vid-url");
    expect(out.mode).toBe("text");
  });

  it("includes paygateTier in the clientContext", async () => {
    const mod = loadExec();
    const ctx = baseCtx();
    await mod.runTextToVideo({ id: "t", mode: "text", prompt: "p" }, ctx);
    const pageCall = ctx.pageCall as ReturnType<typeof vi.fn>;
    const [, body] = pageCall.mock.calls[0];
    expect(body.clientContext.userPaygateTier).toBe("PAYGATE_TIER_TWO");
  });

  it("throws when the API returns no media IDs", async () => {
    const mod = loadExec();
    const ctx = baseCtx({
      pageCall: vi.fn().mockResolvedValue({ media: [] }),
    });
    await expect(
      mod.runTextToVideo({ id: "t", mode: "text", prompt: "p" }, ctx),
    ).rejects.toThrow(/no media IDs/);
  });

  it("throws when polling returns no URLs", async () => {
    const mod = loadExec();
    const ctx = baseCtx({
      pollVideo: vi.fn().mockResolvedValue([]),
    });
    await expect(
      mod.runTextToVideo({ id: "t", mode: "text", prompt: "p" }, ctx),
    ).rejects.toThrow(/no results/);
  });

  it("prefers task.videoModel over ctx.modelKeys.t2v", async () => {
    const mod = loadExec();
    const ctx = baseCtx({
      modelKeys: { t2v: "veo_3_1_t2v_lite", paygateTier: "PAYGATE_TIER_TWO" },
    });
    await mod.runTextToVideo(
      { id: "t", mode: "text", prompt: "p", videoModel: "veo_3_1_t2v_fast_ultra" },
      ctx,
    );
    const pageCall = ctx.pageCall as ReturnType<typeof vi.fn>;
    const [, body] = pageCall.mock.calls[0];
    expect(body.requests[0].videoModelKey).toBe("veo_3_1_t2v_fast_ultra");
  });

  it("falls back to ctx.modelKeys.t2v when task.videoModel is absent", async () => {
    const mod = loadExec();
    const ctx = baseCtx({
      modelKeys: { t2v: "veo_3_1_t2v_lite_low_priority", paygateTier: "PAYGATE_TIER_TWO" },
    });
    await mod.runTextToVideo({ id: "t", mode: "text", prompt: "p" }, ctx);
    const pageCall = ctx.pageCall as ReturnType<typeof vi.fn>;
    const [, body] = pageCall.mock.calls[0];
    expect(body.requests[0].videoModelKey).toBe("veo_3_1_t2v_lite_low_priority");
  });
});
