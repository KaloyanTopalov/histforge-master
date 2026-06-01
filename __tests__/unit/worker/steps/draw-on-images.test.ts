import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  tempDir,
  freshDb,
  seedChunks,
  makeStepContext,
  cleanup,
} from "../../../helpers/step-fixtures";

afterEach(cleanup);

// Mock runDrawOnCli so we can assert on its calls without actually
// spawning Python. resolveDrawOnPythonPath stays real — that path is
// covered by draw-on-python.test.ts; here we just want the integration
// hand-off.
vi.mock("@/lib/draw-on-python", async () => {
  const actual = await vi.importActual<typeof import("@/lib/draw-on-python")>(
    "@/lib/draw-on-python"
  );
  return {
    ...actual,
    runDrawOnCli: vi.fn(),
  };
});

import { runDrawOnCli } from "@/lib/draw-on-python";

beforeEach(() => {
  vi.mocked(runDrawOnCli).mockReset();
});

describe("step draw_on_images", () => {
  it("reads chunks.json, filters image chunks, spawns the CLI per chunk into clips_drawn/<id>.mp4", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_01";
    seedChunks(projectsDir, videoId);
    vi.mocked(runDrawOnCli).mockResolvedValue(undefined);

    const db = freshDb();
    const ctx = makeStepContext({ projectsDir, db });

    const { step } = await import("@/worker/steps/draw-on-images");
    await step.run(videoId, ctx);

    expect(runDrawOnCli).toHaveBeenCalledTimes(3); // 3 image chunks in seedChunks

    const calls = vi.mocked(runDrawOnCli).mock.calls.map((c) => c[0]);
    expect(calls[0]).toMatchObject({
      imagePath: join(projectsDir, videoId, "images", "image_001.png"),
      durationSec: 30,
      outputPath: join(projectsDir, videoId, "clips_drawn", "image_001.mp4"),
    });
    expect(calls[1].imagePath).toContain("image_002.png");
    expect(calls[2].imagePath).toContain("image_003.png");
    // pythonPath is whatever the resolver returns on this machine —
    // could be the .venv path or "python" — but must be a non-empty string.
    expect(typeof calls[0].pythonPath).toBe("string");
    expect(calls[0].pythonPath.length).toBeGreaterThan(0);
  });

  it("skips chunks whose clip already exists (resume-safe)", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_02";
    seedChunks(projectsDir, videoId);
    vi.mocked(runDrawOnCli).mockResolvedValue(undefined);

    // Pre-seed clips_drawn/image_002.mp4 so the loop should skip it.
    const clipsDir = join(projectsDir, videoId, "clips_drawn");
    mkdirSync(clipsDir, { recursive: true });
    writeFileSync(join(clipsDir, "image_002.mp4"), Buffer.from("FAKEMP4"));

    const db = freshDb();
    const ctx = makeStepContext({ projectsDir, db });
    const { step } = await import("@/worker/steps/draw-on-images");
    await step.run(videoId, ctx);

    expect(runDrawOnCli).toHaveBeenCalledTimes(2); // 001 + 003, skipping 002
    const ids = vi.mocked(runDrawOnCli).mock.calls.map((c) =>
      c[0].imagePath.split(/[\\/]/).pop()
    );
    expect(ids).toEqual(["image_001.png", "image_003.png"]);
  });

  it("threads ctx.signal into runDrawOnCli so an in-flight render can be killed", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_03";
    seedChunks(projectsDir, videoId);
    vi.mocked(runDrawOnCli).mockResolvedValue(undefined);

    const db = freshDb();
    const controller = new AbortController();
    const ctx = makeStepContext({
      projectsDir,
      db,
      signal: controller.signal,
    });

    const { step } = await import("@/worker/steps/draw-on-images");
    await step.run(videoId, ctx);

    for (const [opts] of vi.mocked(runDrawOnCli).mock.calls) {
      expect(opts.signal).toBe(controller.signal);
    }
  });

  it("bails between chunks when signal aborts — does not invoke the runner for remaining chunks", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_04";
    seedChunks(projectsDir, videoId);

    const controller = new AbortController();
    vi.mocked(runDrawOnCli).mockImplementation(async () => {
      // Abort right after the first chunk's render returns. The loop's
      // between-iteration signal.aborted check should bail before chunk 2.
      controller.abort();
    });

    const db = freshDb();
    const ctx = makeStepContext({
      projectsDir,
      db,
      signal: controller.signal,
    });
    const { step } = await import("@/worker/steps/draw-on-images");

    await expect(step.run(videoId, ctx)).rejects.toThrow(/aborted/i);
    expect(runDrawOnCli).toHaveBeenCalledTimes(1);
  });

  it("propagates a runner rejection (e.g. python -m draw_on exited non-zero)", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_05";
    seedChunks(projectsDir, videoId);
    vi.mocked(runDrawOnCli).mockRejectedValue(
      new Error("draw-on (python) exited with code 1: FileNotFoundError")
    );

    const db = freshDb();
    const ctx = makeStepContext({ projectsDir, db });
    const { step } = await import("@/worker/steps/draw-on-images");

    await expect(step.run(videoId, ctx)).rejects.toThrow(/exited with code 1/);
    expect(runDrawOnCli).toHaveBeenCalledTimes(1); // bails on first failure
  });

  it("exports step with slug 'draw_on_images' and the expected I/O metadata", async () => {
    const { step } = await import("@/worker/steps/draw-on-images");
    expect(step.name).toBe("draw_on_images");
    expect(step.module).toBe("glue");
    expect(step.for_each).toBe("chunks");
    expect(step.inputs).toEqual(["chunks/chunks.json", "images"]);
    expect(step.outputs).toEqual(["clips_drawn"]);
    expect(step.produces).toEqual(["clips_drawn/*.mp4"]);
  });
});

describe("step registration", () => {
  it("draw_on_images is in REAL_STEPS", async () => {
    const { REAL_STEPS } = await import("@/worker/steps");
    const names = REAL_STEPS.map((s) => s.name);
    expect(names).toContain("draw_on_images");
  });
});
