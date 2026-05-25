import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import type { VideoProvider } from "@/lib/video";
import type { StepContext } from "@/worker/pipeline";
import {
  tempDir,
  seedChunks,
  cleanup,
} from "../../../helpers/step-fixtures";

afterEach(cleanup);

function buildCtx(
  projectsDir: string,
  videoProvider: VideoProvider,
  overrides: Partial<StepContext> = {}
): StepContext {
  return {
    db: {} as DatabaseType,
    projectsDir,
    promptsDir: "/dev/null/prompts",
    log: () => {},
    chat: vi.fn(),
    enrichChat: vi.fn(),
    ttsProvider: {} as never,
    imageProvider: {} as never,
    videoProvider,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("step generate_hook_video", () => {
  it("reads chunks.json, filters hook chunks, dispatches to ctx.videoProvider with items + targetDir + full opts", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_01";
    seedChunks(projectsDir, videoId);

    const generateBatch = vi.fn().mockResolvedValue(undefined);
    const provider: VideoProvider = { generateBatch };

    const chat = vi.fn().mockResolvedValue("ok");
    const ctx = buildCtx(projectsDir, provider, {
      promptsDir: "/prompts",
      chat,
    });

    const { step } = await import("@/worker/steps/generate-hook-video");
    await step.run(videoId, ctx);

    expect(generateBatch).toHaveBeenCalledTimes(1);
    const [items, targetDir, opts] = generateBatch.mock.calls[0];
    expect(items).toEqual([
      { id: "hook_01", prompt: "hook visual prompt 1" },
      { id: "hook_02", prompt: "hook visual prompt 2" },
    ]);
    expect(targetDir).toBe(join(projectsDir, videoId, "videos", "hook"));
    expect(opts).toMatchObject({
      videoId,
      projectsDir,
      promptsDir: "/prompts",
      chat,
    });
    expect(opts.log).toBeDefined();
    expect(opts.db).toBe(ctx.db);
  });

  it("propagates a DeferSignal returned by the provider", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_02";
    seedChunks(projectsDir, videoId);

    const defer = { deferred: true as const, retryAfter: 1234 };
    const provider: VideoProvider = {
      generateBatch: vi.fn().mockResolvedValue(defer),
    };
    const ctx = buildCtx(projectsDir, provider);

    const { step } = await import("@/worker/steps/generate-hook-video");
    const result = await step.run(videoId, ctx);

    expect(result).toEqual(defer);
  });

  it("step.cleanup delegates to ctx.videoProvider.cleanup with projectsDir", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_03";

    const cleanup = vi.fn().mockResolvedValue(undefined);
    const provider: VideoProvider = {
      generateBatch: vi.fn(),
      cleanup,
    };
    const ctx = buildCtx(projectsDir, provider);

    const { step } = await import("@/worker/steps/generate-hook-video");
    await step.cleanup!(videoId, ctx);

    expect(cleanup).toHaveBeenCalledTimes(1);
    const [calledVideoId, opts] = cleanup.mock.calls[0];
    expect(calledVideoId).toBe(videoId);
    expect(opts.projectsDir).toBe(projectsDir);
    expect(opts.db).toBe(ctx.db);
  });

  it("step.cleanup is a no-op when the provider has no cleanup hook", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_04";

    const provider: VideoProvider = { generateBatch: vi.fn() };
    const ctx = buildCtx(projectsDir, provider);

    const { step } = await import("@/worker/steps/generate-hook-video");
    await expect(step.cleanup!(videoId, ctx)).resolves.toBeUndefined();
  });

  it("exports step with the unified slug and outputs=[]", async () => {
    const { step } = await import("@/worker/steps/generate-hook-video");
    expect(step.name).toBe("generate_hook_video");
    expect(step.module).toBe("video");
    expect(step.for_each).toBe("chunks");
    expect(step.outputs).toEqual([]);
    expect(typeof step.run).toBe("function");
    expect(typeof step.cleanup).toBe("function");
  });
});
