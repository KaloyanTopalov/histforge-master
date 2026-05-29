import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Registry = {
  executeTaskViaExtension: (
    task: Record<string, unknown>
  ) => Promise<unknown>;
  EXECUTORS: Record<string, { run: (task: unknown) => Promise<unknown> }>;
};

function loadRegistry(deps: Record<string, unknown> = {}) {
  const src = readFileSync(
    path.resolve(
      process.cwd(),
      "extensions/magnific-ext/src/executors/index.js"
    ),
    "utf8"
  );
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    ...deps,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox as unknown as Registry;
}

describe("magnific-ext executor registry", () => {
  it("dispatches mode='image-hitl' to runImageHitl", async () => {
    const runImageHitl = vi.fn(async (_task: unknown) => ({ ok: true }));
    const reg = loadRegistry({ runImageHitl });
    const task = { id: "x_1", mode: "image-hitl", prompt: "alpine peak" };
    await reg.executeTaskViaExtension(task);
    expect(runImageHitl).toHaveBeenCalledWith(task);
  });

  it("logs and returns {unknownMode:true} when task.mode is not registered", async () => {
    const runImageHitl = vi.fn();
    const reg = loadRegistry({ runImageHitl });
    const result = (await reg.executeTaskViaExtension({
      id: "x_2",
      mode: "frobnicate",
    })) as { unknownMode?: boolean };
    expect(runImageHitl).not.toHaveBeenCalled();
    expect(result.unknownMode).toBe(true);
  });

  it("rethrows errors from the executor so the caller can record failure", async () => {
    const runImageHitl = vi.fn(async () => {
      throw new Error("boom");
    });
    const reg = loadRegistry({ runImageHitl });
    await expect(
      reg.executeTaskViaExtension({ id: "x_3", mode: "image-hitl" })
    ).rejects.toThrow(/boom/);
  });

  it("dispatches mode='image-to-video' to runImageToVideo", async () => {
    const runImageHitl = vi.fn();
    const runImageToVideo = vi.fn(async (_task: unknown) => ({ ok: true }));
    const reg = loadRegistry({ runImageHitl, runImageToVideo });
    const task = {
      id: "x_4",
      mode: "image-to-video",
      prompt: "slow zoom",
      reference_image_url: "https://hf.example/img",
    };
    await reg.executeTaskViaExtension(task);
    expect(runImageToVideo).toHaveBeenCalledWith(task);
    expect(runImageHitl).not.toHaveBeenCalled();
  });

  it("dispatches mode='image-batch' to runImageBatch", async () => {
    const runImageHitl = vi.fn();
    const runImageToVideo = vi.fn();
    const runImageBatch = vi.fn(async (_task: unknown) => ({ ok: true }));
    const reg = loadRegistry({ runImageHitl, runImageToVideo, runImageBatch });
    const task = {
      id: "x_5",
      mode: "image-batch",
      prompt: "a senator in the forum",
      video_title: "The Fall of Rome",
      magnific_project_id: null,
    };
    await reg.executeTaskViaExtension(task);
    expect(runImageBatch).toHaveBeenCalledWith(task);
    expect(runImageHitl).not.toHaveBeenCalled();
    expect(runImageToVideo).not.toHaveBeenCalled();
  });
});
