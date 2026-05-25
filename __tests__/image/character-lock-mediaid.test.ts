import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

// extensions/youforge-flow/src/executors/image.js is a classic-script
// loaded via importScripts in the SW. Tests load flow-error.js first
// (defines makeBadCharacterLockError on the sandbox) and then image.js
// (uses that ref). pageCall / uploadImage come from the ctx the executor
// receives, so they are mockable per-test without touching the sandbox.
//
// Wire-format note: the character lock goes in
// `request.referenceEntities[].entityId`, NOT `request.imageInputs[]`.
// Recon: flowMedia:batchGenerateImages payload from Flow's own UI sends
// `referenceEntities: [{ entityId: <UUID> }]` for saved Characters, and
// `imageInputs` is reserved for uploaded reference images (addressed by
// media `name`). These two paths are independent at the API.

type RunImageGenCtx = {
  projectId: string;
  sessionId: string;
  recaptchaToken: string;
  settings: {
    outputCount?: number;
    aspectRatioSetting?: string;
    imageModelSetting?: string;
    imgUpscale?: string;
    characterLockReference?: string;
  };
  pageCall: ReturnType<typeof vi.fn>;
  uploadImage: ReturnType<typeof vi.fn>;
  log?: { safeLog: (...args: unknown[]) => void };
};

type RunImageGen = (
  task: Record<string, unknown>,
  ctx: RunImageGenCtx,
) => Promise<unknown>;

function loadExecutor(): RunImageGen {
  const errSrc = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/flow-error.js"),
    "utf8",
  );
  const imgSrc = readFileSync(
    path.resolve(
      process.cwd(),
      "extensions/youforge-flow/src/executors/image.js",
    ),
    "utf8",
  );
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    AISANDBOX_BASE: "https://aisandbox-pa.googleapis.com/v1",
    buildClientContext: () => ({}),
    upscaleImages: async () => {},
    crypto: { randomUUID: () => "batch-id" },
    JSON,
    Math,
    Promise,
    Object,
  };
  vm.createContext(sandbox);
  vm.runInContext(errSrc, sandbox);
  vm.runInContext(imgSrc, sandbox);
  const fn = (sandbox as { runImageGen?: RunImageGen }).runImageGen;
  if (typeof fn !== "function") {
    throw new Error("runImageGen did not load into the sandbox");
  }
  return fn;
}

function successfulPageCall() {
  return vi.fn(async () => ({
    media: [
      {
        image: {
          generatedImage: { fifeUrl: "https://example.invalid/result.png" },
        },
      },
    ],
  }));
}

function baseCtx(
  overrides: Partial<RunImageGenCtx> & {
    settings?: Partial<RunImageGenCtx["settings"]>;
  } = {},
): RunImageGenCtx {
  const { settings, ...rest } = overrides;
  return {
    projectId: "proj-1",
    sessionId: ";0",
    recaptchaToken: "captcha",
    pageCall: successfulPageCall(),
    uploadImage: vi.fn(),
    log: { safeLog: () => {} },
    settings: {
      outputCount: 1,
      aspectRatioSetting: "landscape",
      imageModelSetting: "NARWHAL",
      imgUpscale: "none",
      characterLockReference: "",
      ...(settings || {}),
    },
    ...rest,
  };
}

type CapturedRequest = {
  imageInputs: unknown[];
  referenceEntities?: Array<{ entityId: string }>;
};

const VALID_LOCK = "622f1a75-b4f1-45a8-9d77-948e0e93c8f7";

describe("image executor — character lock entity ID", () => {
  it("attaches the lock as referenceEntities[].entityId without calling uploadImage", async () => {
    const runImageGen = loadExecutor();
    const ctx = baseCtx({ settings: { characterLockReference: VALID_LOCK } });

    await runImageGen({ id: "task-1", prompt: "a scene" }, ctx);

    expect(ctx.pageCall).toHaveBeenCalledTimes(1);
    expect(ctx.uploadImage).not.toHaveBeenCalled();
    const [, body] = ctx.pageCall.mock.calls[0] as [string, { requests: CapturedRequest[] }];
    expect(body.requests[0].referenceEntities).toEqual([{ entityId: VALID_LOCK }]);
    // imageInputs is reserved for uploaded reference images — the lock
    // must not appear there.
    expect(body.requests[0].imageInputs).toEqual([]);
  });

  it("keeps lock (referenceEntities) and uploaded refs (imageInputs) independent", async () => {
    const runImageGen = loadExecutor();
    const ctx = baseCtx({
      settings: { characterLockReference: VALID_LOCK },
      uploadImage: vi.fn(async () => "task-ref-media-id"),
    });

    await runImageGen(
      {
        id: "task-2",
        prompt: "a scene",
        referenceImage: "https://example.invalid/ref.png",
      },
      ctx,
    );

    expect(ctx.uploadImage).toHaveBeenCalledTimes(1);
    const [, body] = ctx.pageCall.mock.calls[0] as [string, { requests: CapturedRequest[] }];
    expect(body.requests[0].referenceEntities).toEqual([{ entityId: VALID_LOCK }]);
    expect(body.requests[0].imageInputs).toEqual([
      { imageInputType: "IMAGE_INPUT_TYPE_REFERENCE", name: "task-ref-media-id" },
    ]);
  });

  it("throws BadCharacterLockError before any Flow API call when the lock is malformed", async () => {
    const runImageGen = loadExecutor();
    const ctx = baseCtx({ settings: { characterLockReference: "not-a-uuid" } });

    await expect(
      runImageGen({ id: "task-3", prompt: "a scene" }, ctx),
    ).rejects.toMatchObject({ code: "BAD_CHARACTER_LOCK" });

    expect(ctx.pageCall).not.toHaveBeenCalled();
    expect(ctx.uploadImage).not.toHaveBeenCalled();
  });

  it("omits referenceEntities when the setting is empty (pre-feature behavior preserved)", async () => {
    const runImageGen = loadExecutor();
    const ctx = baseCtx({ settings: { characterLockReference: "" } });

    await runImageGen({ id: "task-4", prompt: "a scene" }, ctx);

    expect(ctx.pageCall).toHaveBeenCalledTimes(1);
    const [, body] = ctx.pageCall.mock.calls[0] as [string, { requests: CapturedRequest[] }];
    // Field absent (not an empty array) when no lock — matches what
    // Flow's UI sends for unlocked image gens.
    expect(body.requests[0].referenceEntities).toBeUndefined();
    expect(body.requests[0].imageInputs).toEqual([]);
  });
});
