import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type ImageExec = {
  runImageGen: (
    task: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => Promise<{ taskId: string; resultUrl: string; mode: string; isGeneratedImage: boolean }>;
};

function loadExec() {
  const files = [
    "extensions/youforge-flow/src/client-context.js",
    "extensions/youforge-flow/src/executors/upscale.js",
    "extensions/youforge-flow/src/executors/shared.js",
    "extensions/youforge-flow/src/executors/image.js",
  ];
  const src = files
    .map((f) => readFileSync(path.resolve(process.cwd(), f), "utf8"))
    .join("\n");
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    assertNotStopped: () => {},
    crypto: { randomUUID: () => "uuid-batch" },
    Math,
    JSON,
    Promise,
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
    AISANDBOX_BASE: "https://aisandbox-pa.googleapis.com/v1",
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox as unknown as ImageExec;
}

function baseCtx(overrides: Record<string, unknown> = {}) {
  return {
    tabId: 1,
    authToken: "bearer",
    projectId: "p",
    sessionId: ";1",
    recaptchaToken: "rc-main",
    modelKeys: { paygateTier: "PAYGATE_TIER_TWO" },
    settings: {
      outputCount: 1,
      aspectRatioSetting: "landscape",
      imageModelSetting: "NARWHAL",
      imgUpscale: "none",
    },
    pageCall: vi.fn().mockResolvedValue({
      media: [{ name: "m1", image: { generatedImage: { fifeUrl: "gen-url-1" } } }],
    }),
    uploadImage: vi.fn(async (url: string) => `mid-${url}`),
    getRecaptcha: vi.fn().mockResolvedValue("rc-refresh"),
    pollVideo: vi.fn(),
    ...overrides,
  };
}

describe("runImageGen", () => {
  it("posts to batchGenerateImages with the image model and aspect", async () => {
    const mod = loadExec();
    const ctx = baseCtx();
    await mod.runImageGen(
      { id: "task-1", mode: "createimage", imagePrompt: "a cat" },
      ctx,
    );
    const pageCall = ctx.pageCall as ReturnType<typeof vi.fn>;
    const [url, body] = pageCall.mock.calls[0];
    expect(url).toContain("flowMedia:batchGenerateImages");
    expect(body.requests[0].imageModelName).toBe("NARWHAL");
    expect(body.requests[0].imageAspectRatio).toBe("IMAGE_ASPECT_RATIO_LANDSCAPE");
    expect(body.requests[0].structuredPrompt).toEqual({ parts: [{ text: "a cat" }] });
  });

  it("builds N requests equal to settings.outputCount", async () => {
    const mod = loadExec();
    const ctx = baseCtx({
      settings: {
        outputCount: 3,
        aspectRatioSetting: "portrait",
        imageModelSetting: "NARWHAL",
        imgUpscale: "none",
      },
    });
    await mod.runImageGen(
      { id: "task-1", mode: "imagegen", imagePrompt: "p" },
      ctx,
    );
    const pageCall = ctx.pageCall as ReturnType<typeof vi.fn>;
    const [, body] = pageCall.mock.calls[0];
    expect(body.requests).toHaveLength(3);
    expect(body.requests[0].imageAspectRatio).toBe("IMAGE_ASPECT_RATIO_PORTRAIT");
  });

  it("uploads comma-separated reference images and includes them in each request", async () => {
    const mod = loadExec();
    const ctx = baseCtx();
    await mod.runImageGen(
      { id: "t", mode: "createimage", imagePrompt: "p", imagegenReference: "a.png, b.png" },
      ctx,
    );
    const uploadImage = ctx.uploadImage as ReturnType<typeof vi.fn>;
    expect(uploadImage).toHaveBeenCalledTimes(2);
    expect(uploadImage).toHaveBeenNthCalledWith(1, "a.png", "reference_1.png");
    const pageCall = ctx.pageCall as ReturnType<typeof vi.fn>;
    const [, body] = pageCall.mock.calls[0];
    expect(body.requests[0].imageInputs).toEqual([
      { imageInputType: "IMAGE_INPUT_TYPE_REFERENCE", name: "mid-a.png" },
      { imageInputType: "IMAGE_INPUT_TYPE_REFERENCE", name: "mid-b.png" },
    ]);
  });

  it("returns {taskId, resultUrl, mode:'createImage', isGeneratedImage:true}", async () => {
    const mod = loadExec();
    const ctx = baseCtx({
      pageCall: vi.fn().mockResolvedValue({
        media: [
          { name: "m1", image: { generatedImage: { fifeUrl: "u1" } } },
          { name: "m2", image: { generatedImage: { fifeUrl: "u2" } } },
        ],
      }),
    });
    const out = await mod.runImageGen(
      { id: "task-1", mode: "createimage", imagePrompt: "p" },
      ctx,
    );
    expect(out).toEqual({
      taskId: "task-1",
      resultUrl: "u1,u2",
      mode: "createImage",
      isGeneratedImage: true,
    });
  });

  it("throws when the API returns no URLs", async () => {
    const mod = loadExec();
    const ctx = baseCtx({
      pageCall: vi.fn().mockResolvedValue({ media: [] }),
    });
    await expect(
      mod.runImageGen({ id: "t", mode: "createimage", imagePrompt: "p" }, ctx),
    ).rejects.toThrow(/no results/);
  });

  it("prefers task.imageModel over settings.imageModelSetting", async () => {
    const mod = loadExec();
    const ctx = baseCtx({
      settings: {
        outputCount: 1,
        aspectRatioSetting: "landscape",
        imageModelSetting: "NARWHAL",
        imgUpscale: "none",
      },
    });
    await mod.runImageGen(
      { id: "t", mode: "createimage", imagePrompt: "p", imageModel: "GEM_PIX_2" },
      ctx,
    );
    const pageCall = ctx.pageCall as ReturnType<typeof vi.fn>;
    const [, body] = pageCall.mock.calls[0];
    expect(body.requests[0].imageModelName).toBe("GEM_PIX_2");
  });

  it("falls back to settings.imageModelSetting when task.imageModel is absent", async () => {
    const mod = loadExec();
    const ctx = baseCtx({
      settings: {
        outputCount: 1,
        aspectRatioSetting: "landscape",
        imageModelSetting: "IMAGEN_3_5",
        imgUpscale: "none",
      },
    });
    await mod.runImageGen(
      { id: "t", mode: "createimage", imagePrompt: "p" },
      ctx,
    );
    const pageCall = ctx.pageCall as ReturnType<typeof vi.fn>;
    const [, body] = pageCall.mock.calls[0];
    expect(body.requests[0].imageModelName).toBe("IMAGEN_3_5");
  });
});
