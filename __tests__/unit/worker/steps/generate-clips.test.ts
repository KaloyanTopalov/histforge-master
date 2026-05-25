import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import type { VideoProvider } from "@/lib/video";
import {
  tempDir,
  seedChunks,
  makeStepContext,
  cleanup,
} from "../../../helpers/step-fixtures";

afterEach(cleanup);

describe("step generate_clips", () => {
  it("reads chunks.json, filters clip chunks, dispatches to ctx.videoProvider with items + targetDir + full opts", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_01";
    seedChunks(projectsDir, videoId);

    const generateBatch = vi.fn().mockResolvedValue(undefined);
    const provider: VideoProvider = { generateBatch };

    const visualPromptChat = vi.fn().mockResolvedValue("ok");
    const ctx = makeStepContext({
      projectsDir,
      videoProvider: provider,
      promptsDir: "/prompts",
      visualPromptChat,
    });

    const { step } = await import("@/worker/steps/generate-clips");
    await step.run(videoId, ctx);

    expect(generateBatch).toHaveBeenCalledTimes(1);
    const [items, targetDir, opts] = generateBatch.mock.calls[0];
    expect(items).toEqual([
      { id: "clip_01", prompt: "clip visual prompt 1" },
      { id: "clip_02", prompt: "clip visual prompt 2" },
    ]);
    expect(targetDir).toBe(join(projectsDir, videoId, "videos", "clip"));
    expect(opts).toMatchObject({
      videoId,
      projectsDir,
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
    const ctx = makeStepContext({ projectsDir, videoProvider: provider });

    const { step } = await import("@/worker/steps/generate-clips");
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
    const ctx = makeStepContext({ projectsDir, videoProvider: provider });

    const { step } = await import("@/worker/steps/generate-clips");
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
    const ctx = makeStepContext({ projectsDir, videoProvider: provider });

    const { step } = await import("@/worker/steps/generate-clips");
    await expect(step.cleanup!(videoId, ctx)).resolves.toBeUndefined();
  });

  it("exports step with the unified slug and outputs=[]", async () => {
    const { step } = await import("@/worker/steps/generate-clips");
    expect(step.name).toBe("generate_clips");
    expect(step.module).toBe("video");
    expect(step.for_each).toBe("chunks");
    expect(step.outputs).toEqual([]);
    expect(typeof step.run).toBe("function");
    expect(typeof step.cleanup).toBe("function");
  });
});
