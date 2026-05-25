import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import type { ImageProvider } from "@/lib/image";
import type { StepContext } from "@/worker/pipeline";
import {
  tempDir,
  seedChunks,
  cleanup,
} from "../../../helpers/step-fixtures";

afterEach(cleanup);

function buildCtx(
  projectsDir: string,
  imageProvider: ImageProvider,
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
    imageProvider,
    videoProvider: {} as never,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("step generate_main_images", () => {
  it("reads chunks.json, filters main chunks, dispatches to ctx.imageProvider with items + targetDir + full opts", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_01";
    seedChunks(projectsDir, videoId);

    const generateBatch = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn();
    const provider: ImageProvider = { generateBatch, cleanup };

    const chat = vi.fn().mockResolvedValue("ok");
    const ctx = buildCtx(projectsDir, provider, {
      promptsDir: "/prompts",
      chat,
    });

    const { step } = await import("@/worker/steps/generate-main-images");
    await step.run(videoId, ctx);

    expect(generateBatch).toHaveBeenCalledTimes(1);
    const [items, targetDir, opts] = generateBatch.mock.calls[0];
    expect(items).toEqual([
      { id: "main_001", prompt: "main visual prompt 1" },
      { id: "main_002", prompt: "main visual prompt 2" },
      { id: "main_003", prompt: "main visual prompt 3" },
    ]);
    expect(targetDir).toBe(join(projectsDir, videoId, "images", "main"));
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

    const defer = { deferred: true as const, retryAfter: 999 };
    const provider: ImageProvider = {
      generateBatch: vi.fn().mockResolvedValue(defer),
    };
    const ctx = buildCtx(projectsDir, provider);

    const { step } = await import("@/worker/steps/generate-main-images");
    const result = await step.run(videoId, ctx);

    expect(result).toEqual(defer);
  });

  it("step.cleanup delegates to ctx.imageProvider.cleanup with projectsDir", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_03";

    const cleanup = vi.fn().mockResolvedValue(undefined);
    const provider: ImageProvider = {
      generateBatch: vi.fn(),
      cleanup,
    };
    const ctx = buildCtx(projectsDir, provider);

    const { step } = await import("@/worker/steps/generate-main-images");
    await step.cleanup!(videoId, ctx);

    expect(cleanup).toHaveBeenCalledTimes(1);
    const [calledVideoId, opts] = cleanup.mock.calls[0];
    expect(calledVideoId).toBe(videoId);
    expect(opts.projectsDir).toBe(projectsDir);
    expect(opts.db).toBe(ctx.db);
  });

  it("step.cleanup is a no-op when the provider has no cleanup hook (e.g. google_flow)", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_04";

    const provider: ImageProvider = { generateBatch: vi.fn() };
    const ctx = buildCtx(projectsDir, provider);

    const { step } = await import("@/worker/steps/generate-main-images");
    await expect(step.cleanup!(videoId, ctx)).resolves.toBeUndefined();
  });

  it("exports step with the unified slug and outputs=[]", async () => {
    const { step } = await import("@/worker/steps/generate-main-images");
    expect(step.name).toBe("generate_main_images");
    expect(step.module).toBe("image");
    expect(step.for_each).toBe("chunks");
    expect(step.outputs).toEqual([]);
    expect(typeof step.run).toBe("function");
    expect(typeof step.cleanup).toBe("function");
  });
});
