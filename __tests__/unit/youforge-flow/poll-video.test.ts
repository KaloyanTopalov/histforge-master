import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type PollVideo = {
  pollVideoUntilDone: (
    authToken: string,
    mediaIds: Array<{ name: string; projectId: string }>,
    taskId: string,
    tabId?: number,
    timings?: Record<string, unknown>,
    correlationId?: string,
  ) => Promise<string[]>;
};

type Status = { name: string; state: string; url?: string; error?: unknown };

function loadPollVideo(opts: {
  statusSequences?: Status[][];
  executeScriptResult?: unknown;
  checkVideoStatusThrows?: Error;
  stopAfterAttempts?: number;
  getFlowTabId?: () => Promise<number | null>;
  postProgressEvent?: ReturnType<typeof vi.fn>;
  videoPollBaseSec?: number;
  videoPollMaxSec?: number;
  videoPollMaxAttempts?: number;
  videoPollStepFactor?: number;
  videoPollJitterMs?: number;
  progressEventEveryN?: number;
  random?: () => number;
} = {}) {
  const errorSrc = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/flow-error.js"),
    "utf8",
  );
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/poll-video.js"),
    "utf8",
  );
  let callIdx = 0;
  const checkVideoStatus = vi.fn(async () => {
    if (opts.checkVideoStatusThrows && callIdx === 0) {
      callIdx += 1;
      throw opts.checkVideoStatusThrows;
    }
    const seq = opts.statusSequences?.[callIdx] ?? [];
    callIdx += 1;
    return seq;
  });
  let assertCalls = 0;
  const assertNotStopped = vi.fn(() => {
    assertCalls += 1;
    if (opts.stopAfterAttempts && assertCalls > opts.stopAfterAttempts) {
      throw new Error("STOP_REQUESTED");
    }
  });
  const getFlowTabId = vi.fn(
    opts.getFlowTabId ?? (async () => 99),
  );
  const executeScript = vi.fn(async () => [
    { result: opts.executeScriptResult ?? { url: "https://storage.googleapis.com/fallback", ok: true } },
  ]);
  const postProgressEvent = opts.postProgressEvent ?? vi.fn(async () => true);
  const setTimeoutDelays: number[] = [];
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    forTask: () => ({ safeLog: () => {} }),
    assertNotStopped,
    checkVideoStatus,
    getFlowTabId,
    postProgressEvent,
    getVideoPollBaseSec: () => opts.videoPollBaseSec ?? 3,
    getVideoPollMaxSec: () => opts.videoPollMaxSec ?? 10,
    getVideoPollMaxAttempts: () => opts.videoPollMaxAttempts ?? 120,
    getVideoPollStepFactor: () => opts.videoPollStepFactor ?? 0.05,
    getVideoPollJitterMs: () => opts.videoPollJitterMs ?? 500,
    getProgressEventEveryN: () => opts.progressEventEveryN ?? 6,
    chrome: { scripting: { executeScript } },
    setTimeout: (fn: () => void, ms?: number) => {
      if (typeof ms === "number") setTimeoutDelays.push(ms);
      fn();
      return 0;
    },
    Promise,
    JSON,
    Math: { ...Math, random: opts.random ?? Math.random.bind(Math), min: Math.min, max: Math.max, round: Math.round, floor: Math.floor },
  };
  vm.createContext(sandbox);
  vm.runInContext(errorSrc + "\n" + src, sandbox);
  return {
    mod: sandbox as unknown as PollVideo,
    checkVideoStatus,
    getFlowTabId,
    executeScript,
    postProgressEvent,
    setTimeoutDelays,
  };
}

describe("pollVideoUntilDone", () => {
  it("returns URLs straight from the status response when present", async () => {
    const ctx = loadPollVideo({
      statusSequences: [
        [
          { name: "m1", state: "MEDIA_GENERATION_STATUS_SUCCESSFUL", url: "u1" },
          { name: "m2", state: "MEDIA_GENERATION_STATUS_SUCCESSFUL", url: "u2" },
        ],
      ],
    });
    const out = await ctx.mod.pollVideoUntilDone(
      "bearer",
      [{ name: "m1", projectId: "p" }, { name: "m2", projectId: "p" }],
      "t1",
    );
    expect(out).toEqual(["u1", "u2"]);
    expect(ctx.executeScript).not.toHaveBeenCalled();
  });

  it("keeps polling while any status is still pending", async () => {
    const ctx = loadPollVideo({
      statusSequences: [
        [{ name: "m1", state: "MEDIA_GENERATION_STATUS_PENDING" }],
        [{ name: "m1", state: "MEDIA_GENERATION_STATUS_SUCCESSFUL", url: "u1" }],
      ],
    });
    const out = await ctx.mod.pollVideoUntilDone(
      "bearer",
      [{ name: "m1", projectId: "p" }],
      "t1",
    );
    expect(out).toEqual(["u1"]);
    expect(ctx.checkVideoStatus).toHaveBeenCalledTimes(2);
  });

  it("throws `isGenerationFailure` when all media fail with content-policy error", async () => {
    const ctx = loadPollVideo({
      statusSequences: [
        [
          {
            name: "m1",
            state: "MEDIA_GENERATION_STATUS_FAILED",
            error: { failureReasons: ["CHILD_DANGER"] },
          },
        ],
      ],
    });
    await expect(
      ctx.mod.pollVideoUntilDone("bearer", [{ name: "m1", projectId: "p" }], "t1"),
    ).rejects.toMatchObject({
      message: expect.stringContaining("CHILD_DANGER"),
      isGenerationFailure: true,
      isContentPolicy: true,
      contentPolicyTag: "CHILD_DANGER",
      category: "content_policy",
    });
  });

  it.each([
    "PERSON_GENERATION",
    "VIOLENCE",
    "ADULT",
    "PROFANITY",
    "CONTENT_POLICY_VIOLATION",
  ])("recognizes widened content-policy tag %s", async (tag) => {
    const ctx = loadPollVideo({
      statusSequences: [
        [
          {
            name: "m1",
            state: "MEDIA_GENERATION_STATUS_FAILED",
            error: { failureReasons: [tag] },
          },
        ],
      ],
    });
    await expect(
      ctx.mod.pollVideoUntilDone("bearer", [{ name: "m1", projectId: "p" }], "t1"),
    ).rejects.toMatchObject({
      isGenerationFailure: true,
      isContentPolicy: true,
      contentPolicyTag: tag,
      category: "content_policy",
    });
  });

  // Veo's newer filter variants surface the reason in `error.message`
  // (no `failureReasons[]`), so the message-fallback in poll-video.js
  // is what classifies them. Two suffix shapes are observed:
  //   _FILTER     — visual safety (e.g. PUBLIC_ERROR_DANGER_FILTER)
  //   _FILTERED   — Veo 3 audio safety (e.g. PUBLIC_ERROR_AUDIO_FILTERED)
  it.each([
    "PUBLIC_ERROR_DANGER_FILTER",
    "PUBLIC_ERROR_AUDIO_FILTERED",
  ])("recognizes %s embedded in error.message", async (tag) => {
    const ctx = loadPollVideo({
      statusSequences: [
        [
          {
            name: "m1",
            state: "MEDIA_GENERATION_STATUS_FAILED",
            error: { code: 3, message: tag },
          },
        ],
      ],
    });
    await expect(
      ctx.mod.pollVideoUntilDone("bearer", [{ name: "m1", projectId: "p" }], "t1"),
    ).rejects.toMatchObject({
      isGenerationFailure: true,
      isContentPolicy: true,
      contentPolicyTag: tag,
      category: "content_policy",
    });
  });

  it("propagates STOP_REQUESTED immediately", async () => {
    const ctx = loadPollVideo({
      stopAfterAttempts: 1,
      statusSequences: [
        [{ name: "m1", state: "MEDIA_GENERATION_STATUS_PENDING" }],
      ],
    });
    await expect(
      ctx.mod.pollVideoUntilDone("bearer", [{ name: "m1", projectId: "p" }], "t1"),
    ).rejects.toThrow("STOP_REQUESTED");
  });

  it("honors getProgressEventEveryN setting (fires on attempt 3 when N=3)", async () => {
    const pending: Status[] = [{ name: "m1", state: "MEDIA_GENERATION_STATUS_PENDING" }];
    const success: Status[] = [{ name: "m1", state: "MEDIA_GENERATION_STATUS_SUCCESSFUL", url: "u1" }];
    const ctx = loadPollVideo({
      progressEventEveryN: 3,
      statusSequences: [pending, pending, pending, success],
    });
    await ctx.mod.pollVideoUntilDone(
      "bearer",
      [{ name: "m1", projectId: "p" }],
      "t1",
      99,
      undefined,
      "cid-cfg",
    );
    expect(ctx.postProgressEvent).toHaveBeenCalledWith(
      expect.objectContaining({ pollAttempt: 3, correlationId: "cid-cfg" }),
    );
  });

  it("emits a progress event every 6 attempts with cid + estimatedPct", async () => {
    // Build a sequence that stays pending for 7 attempts, then completes.
    const pending: Status[] = [{ name: "m1", state: "MEDIA_GENERATION_STATUS_PENDING" }];
    const success: Status[] = [{ name: "m1", state: "MEDIA_GENERATION_STATUS_SUCCESSFUL", url: "u1" }];
    const ctx = loadPollVideo({
      statusSequences: [pending, pending, pending, pending, pending, pending, pending, success],
    });
    await ctx.mod.pollVideoUntilDone(
      "bearer",
      [{ name: "m1", projectId: "p" }],
      "t1",
      99,
      undefined,
      "cid-progress-test",
    );
    // First progress event fires after the 6th attempt
    expect(ctx.postProgressEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "t1",
        correlationId: "cid-progress-test",
        pollAttempt: 6,
        totalAttempts: 120,
      }),
    );
    const args = ctx.postProgressEvent.mock.calls[0]![0] as { estimatedPct: number };
    expect(args.estimatedPct).toBe(5); // round(6/120 * 100) = 5
  });

  it("caps estimatedPct at 95", async () => {
    // Force enough pending iterations to push estimatedPct past 95
    const pending: Status[] = [{ name: "m1", state: "MEDIA_GENERATION_STATUS_PENDING" }];
    const success: Status[] = [{ name: "m1", state: "MEDIA_GENERATION_STATUS_SUCCESSFUL", url: "u1" }];
    const sequences: Status[][] = [];
    for (let i = 0; i < 119; i++) sequences.push(pending);
    sequences.push(success);
    const ctx = loadPollVideo({ statusSequences: sequences });
    await ctx.mod.pollVideoUntilDone(
      "bearer",
      [{ name: "m1", projectId: "p" }],
      "t1",
      99,
      undefined,
      "cid-cap-test",
    );
    const lastCall = ctx.postProgressEvent.mock.calls.at(-1)![0] as { estimatedPct: number };
    expect(lastCall.estimatedPct).toBeLessThanOrEqual(95);
  });

  describe("media-URL resolution chain", () => {
    it("re-runs checkVideoStatus once when redirect returns a non-storage URL", async () => {
      // First status: pending → eventually succeeds without url.
      // After tRPC redirect returns non-storage URL, the helper re-runs
      // checkVideoStatus and the second response has a url field.
      const ctx = loadPollVideo({
        statusSequences: [
          [{ name: "m1", state: "MEDIA_GENERATION_STATUS_SUCCESSFUL" }],
          [{ name: "m1", state: "MEDIA_GENERATION_STATUS_SUCCESSFUL", url: "https://storage.googleapis.com/eventual.mp4" }],
        ],
        executeScriptResult: { url: "https://labs.google/some-non-storage", ok: true },
      });
      const out = await ctx.mod.pollVideoUntilDone(
        "bearer",
        [{ name: "m1", projectId: "p" }],
        "t1",
      );
      expect(out).toEqual(["https://storage.googleapis.com/eventual.mp4"]);
      // checkVideoStatus called once for the initial poll, once for the re-run.
      expect(ctx.checkVideoStatus).toHaveBeenCalledTimes(2);
    });

    it("throws makeFlowApiError({reason:'NO_URL'}) with isGenerationFailure when all fallbacks fail", async () => {
      const ctx = loadPollVideo({
        statusSequences: [
          [{ name: "m1", state: "MEDIA_GENERATION_STATUS_SUCCESSFUL" }],
          [{ name: "m1", state: "MEDIA_GENERATION_STATUS_SUCCESSFUL" }], // re-run still no url
        ],
        executeScriptResult: { url: "https://labs.google/non-storage", ok: true },
      });
      await expect(
        ctx.mod.pollVideoUntilDone("bearer", [{ name: "m1", projectId: "p" }], "t1"),
      ).rejects.toMatchObject({
        reason: "NO_URL",
        category: "not_found",
        isGenerationFailure: true,
      });
    });

    it("does not return bare redirect URL or media:<name> fallback strings", async () => {
      const ctx = loadPollVideo({
        statusSequences: [
          [{ name: "m1", state: "MEDIA_GENERATION_STATUS_SUCCESSFUL" }],
          [{ name: "m1", state: "MEDIA_GENERATION_STATUS_SUCCESSFUL" }],
        ],
        executeScriptResult: { error: "executeScript boom" }, // redirect path errors
      });
      await expect(
        ctx.mod.pollVideoUntilDone("bearer", [{ name: "m1", projectId: "p" }], "t1"),
      ).rejects.toMatchObject({ reason: "NO_URL" });
    });
  });

  describe("jittered progressive polling", () => {
    it("uses progressive interval that grows with attempt and caps at maxSec", async () => {
      const pending: Status[] = [{ name: "m1", state: "MEDIA_GENERATION_STATUS_PENDING" }];
      const success: Status[] = [{ name: "m1", state: "MEDIA_GENERATION_STATUS_SUCCESSFUL", url: "u1" }];
      const sequences: Status[][] = [];
      for (let i = 0; i < 5; i++) sequences.push(pending);
      sequences.push(success);
      const ctx = loadPollVideo({
        statusSequences: sequences,
        videoPollBaseSec: 3,
        videoPollMaxSec: 10,
        videoPollStepFactor: 0.05,
        videoPollJitterMs: 0, // disable jitter for deterministic asserts
        random: () => 0,
      });
      // Reset delays before the run; the helper accumulates them.
      ctx.setTimeoutDelays.length = 0;
      await ctx.mod.pollVideoUntilDone(
        "bearer",
        [{ name: "m1", projectId: "p" }],
        "t1",
      );
      // Sum all delays — total wait = sum of 6 per-attempt intervals.
      // Each interval = min(10000, 3000 * (1 + attempt * 0.05)).
      // attempt 1: 3150, attempt 2: 3300, attempt 3: 3450, attempt 4: 3600,
      // attempt 5: 3750, attempt 6: 3900 → total ≈ 21150ms.
      const total = ctx.setTimeoutDelays.reduce((a, b) => a + b, 0);
      // Each attempt sleeps at least baseIntervalMs (3000), so 6 attempts ≥ 18000.
      expect(total).toBeGreaterThanOrEqual(18_000);
      // Capped at maxIntervalMs (10000) per attempt; 6 × 10000 = 60000.
      expect(total).toBeLessThanOrEqual(60_000);
    });

    it("respects maxAttempts setting and times out", async () => {
      const pending: Status[] = [{ name: "m1", state: "MEDIA_GENERATION_STATUS_PENDING" }];
      const sequences: Status[][] = [];
      for (let i = 0; i < 5; i++) sequences.push(pending);
      const ctx = loadPollVideo({
        statusSequences: sequences,
        videoPollMaxAttempts: 3,
        videoPollBaseSec: 1,
        videoPollMaxSec: 1,
        videoPollJitterMs: 0,
      });
      await expect(
        ctx.mod.pollVideoUntilDone(
          "bearer",
          [{ name: "m1", projectId: "p" }],
          "t1",
        ),
      ).rejects.toThrow(/timed out/i);
      expect(ctx.checkVideoStatus).toHaveBeenCalledTimes(3);
    });
  });

  it("continues polling past a transient network error", async () => {
    const ctx = loadPollVideo({
      checkVideoStatusThrows: new Error("network flake"),
      statusSequences: [
        [], // thrown instead of this entry
        [{ name: "m1", state: "MEDIA_GENERATION_STATUS_SUCCESSFUL", url: "u1" }],
      ],
    });
    const out = await ctx.mod.pollVideoUntilDone(
      "bearer",
      [{ name: "m1", projectId: "p" }],
      "t1",
    );
    expect(out).toEqual(["u1"]);
  });

  describe("rate-limit propagation (Phase 3 fix #5)", () => {
    it("propagates a rate_limit error instead of swallowing it", async () => {
      const err = Object.assign(new Error("429"), {
        category: "rate_limit",
        retryable: true,
        httpStatus: 429,
      });
      const ctx = loadPollVideo({ checkVideoStatusThrows: err });
      await expect(
        ctx.mod.pollVideoUntilDone("bearer", [{ name: "m1", projectId: "p" }], "t1"),
      ).rejects.toMatchObject({ category: "rate_limit" });
    });

    it("still swallows transient errors and continues polling", async () => {
      const err = Object.assign(new Error("503"), {
        category: "transient",
        retryable: true,
      });
      const ctx = loadPollVideo({
        checkVideoStatusThrows: err,
        statusSequences: [
          [],
          [{ name: "m1", state: "MEDIA_GENERATION_STATUS_SUCCESSFUL", url: "u1" }],
        ],
      });
      const out = await ctx.mod.pollVideoUntilDone(
        "bearer",
        [{ name: "m1", projectId: "p" }],
        "t1",
      );
      expect(out).toEqual(["u1"]);
    });
  });
});
