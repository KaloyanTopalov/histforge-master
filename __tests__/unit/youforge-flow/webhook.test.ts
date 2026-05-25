import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Webhook = {
  postStatusEvent: (payload: Record<string, unknown>) => Promise<boolean>;
  postProgressEvent: (payload: {
    taskId?: string;
    correlationId?: string;
    pollAttempt: number;
    totalAttempts: number;
    estimatedPct: number;
  }) => Promise<boolean>;
  resetProgressGate: () => void;
  notifySessionExpired: (context?: string) => Promise<void>;
  clearSessionExpiredReport: () => void;
  isSessionExpiredReported: () => boolean;
  submitResult: (
    data: {
      taskId: string;
      resultUrl?: string;
      mode?: string;
      correlationId?: string;
      timings?: Record<string, unknown>;
    },
    mediaFiles?: Array<Record<string, unknown>>,
  ) => Promise<boolean>;
  submitFailure: (
    task: { id?: string; mode?: string } | undefined,
    errorOrMessage:
      | string
      | (Error & {
          reason?: string;
          category?: string;
          httpStatus?: number | null;
          retryable?: boolean | null;
          contentPolicyTag?: string | null;
        }),
  ) => Promise<void>;
  postProjectCreated: (payload: {
    videoId: string;
    projectId: string;
    projectTitle: string;
  }) => Promise<boolean>;
  postOperationStarted: (payload: {
    taskId: string;
    operationName: string;
    projectId: string;
  }) => Promise<boolean>;
};

function loadWebhook(opts: {
  STATUS_URL?: string;
  RESULT_URL?: string;
  PROJECT_URL?: string;
  OPERATION_STARTED_URL?: string;
  ACCOUNT_TOKEN?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  clearAuthCache?: ReturnType<typeof vi.fn>;
  scheduleAuthProbe?: ReturnType<typeof vi.fn>;
  webhookMaxRetries?: number;
  notificationsEnabled?: boolean;
  notificationsCreate?: ReturnType<typeof vi.fn>;
} = {}) {
  const httpSrc = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/http.js"),
    "utf8",
  );
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/webhook.js"),
    "utf8",
  );
  const fetchFn = vi.fn(
    opts.fetchImpl ?? (async () => ({
      ok: true,
      status: 200,
      text: async () => '{"success":true}',
    } as unknown as Response)),
  );
  const setStopFlag = vi.fn();
  const stopPolling = vi.fn(async () => {});
  const clearAuthCache = opts.clearAuthCache ?? vi.fn();
  const scheduleAuthProbe = opts.scheduleAuthProbe ?? vi.fn();
  const notificationsCreate = opts.notificationsCreate ?? vi.fn(async () => "notif-id");
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    verboseLog: () => {},
    fetch: fetchFn,
    // fetchWithTimeout / retryWithBackoff / computeBackoff come from the
    // real http.js source, concatenated below — same pattern as production
    // (importScripts in background.js).
    setStopFlag,
    stopPolling,
    clearAuthCache,
    scheduleAuthProbe,
    AbortController,
    AbortSignal,
    Math,
    clearTimeout: () => {},
    getResultUrl: () => opts.RESULT_URL ?? "https://histforge.example/result",
    getStatusUrl: () => opts.STATUS_URL ?? "https://histforge.example/status",
    getProjectUrl: () => opts.PROJECT_URL ?? "https://histforge.example/project",
    getOperationStartedUrl: () =>
      opts.OPERATION_STARTED_URL ?? "https://histforge.example/operation-started",
    getAccountToken: () => opts.ACCOUNT_TOKEN ?? "acct-token",
    getWebhookMaxRetries: () => opts.webhookMaxRetries ?? 3,
    getNotificationsEnabled: () => opts.notificationsEnabled ?? true,
    chrome: {
      storage: {
        local: {
          set: vi.fn(async () => {}),
        },
      },
      notifications: {
        create: notificationsCreate,
      },
    },
    Date,
    JSON,
    Promise,
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(httpSrc + "\n" + src, sandbox);
  return {
    mod: sandbox as unknown as Webhook,
    fetchFn,
    setStopFlag,
    stopPolling,
    clearAuthCache,
    scheduleAuthProbe,
    notificationsCreate,
    storageSet: (sandbox.chrome as { storage: { local: { set: ReturnType<typeof vi.fn> } } }).storage.local.set,
  };
}

describe("webhook", () => {
  describe("postStatusEvent", () => {
    it("returns false when STATUS_URL is empty", async () => {
      const ctx = loadWebhook({ STATUS_URL: "" });
      const ok = await ctx.mod.postStatusEvent({ type: "StatusEvent" });
      expect(ok).toBe(false);
      expect(ctx.fetchFn).not.toHaveBeenCalled();
    });

    it("POSTs JSON with accountToken + timestamp and returns true on ok", async () => {
      const ctx = loadWebhook();
      const ok = await ctx.mod.postStatusEvent({ type: "StatusEvent", event: "x" });
      expect(ok).toBe(true);
      const [url, init] = ctx.fetchFn.mock.calls[0];
      expect(url).toBe("https://histforge.example/status");
      const body = JSON.parse(init!.body as string);
      expect(body.type).toBe("StatusEvent");
      expect(body.event).toBe("x");
      expect(body.accountToken).toBe("acct-token");
      expect(body.at).toBeDefined();
    });

    it("returns false when fetch throws", async () => {
      const ctx = loadWebhook({
        fetchImpl: async () => {
          throw new Error("network flake");
        },
      });
      expect(await ctx.mod.postStatusEvent({ type: "StatusEvent" })).toBe(false);
    });
  });

  describe("postProgressEvent", () => {
    it("posts a 'progress' StatusEvent with the supplied fields", async () => {
      const ctx = loadWebhook();
      const ok = await ctx.mod.postProgressEvent({
        taskId: "t1",
        correlationId: "cid-abc",
        pollAttempt: 6,
        totalAttempts: 120,
        estimatedPct: 5,
      });
      expect(ok).toBe(true);
      const [url, init] = ctx.fetchFn.mock.calls[0];
      expect(url).toBe("https://histforge.example/status");
      const body = JSON.parse(init!.body as string);
      expect(body.type).toBe("StatusEvent");
      expect(body.event).toBe("progress");
      expect(body.taskId).toBe("t1");
      expect(body.correlationId).toBe("cid-abc");
      expect(body.pollAttempt).toBe(6);
      expect(body.totalAttempts).toBe(120);
      expect(body.estimatedPct).toBe(5);
    });

    it("returns false without posting when STATUS_URL is empty", async () => {
      const ctx = loadWebhook({ STATUS_URL: "" });
      const ok = await ctx.mod.postProgressEvent({
        pollAttempt: 1,
        totalAttempts: 120,
        estimatedPct: 1,
      });
      expect(ok).toBe(false);
      expect(ctx.fetchFn).not.toHaveBeenCalled();
    });

    it("stops firing after a previous post failed (anti-spam gate)", async () => {
      let calls = 0;
      const ctx = loadWebhook({
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) throw new Error("network flake");
          return {
            ok: true,
            status: 200,
            text: async () => '{"success":true}',
          } as unknown as Response;
        },
      });
      const a = await ctx.mod.postProgressEvent({
        pollAttempt: 1,
        totalAttempts: 120,
        estimatedPct: 1,
      });
      expect(a).toBe(false);
      const b = await ctx.mod.postProgressEvent({
        pollAttempt: 7,
        totalAttempts: 120,
        estimatedPct: 6,
      });
      expect(b).toBe(false);
      // Second call short-circuited — no fetch issued
      expect(calls).toBe(1);
    });

    it("resetProgressGate re-enables firing after a failure", async () => {
      let calls = 0;
      const ctx = loadWebhook({
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) throw new Error("network flake");
          return {
            ok: true,
            status: 200,
            text: async () => '{"success":true}',
          } as unknown as Response;
        },
      });
      await ctx.mod.postProgressEvent({
        pollAttempt: 1,
        totalAttempts: 120,
        estimatedPct: 1,
      });
      ctx.mod.resetProgressGate();
      const ok = await ctx.mod.postProgressEvent({
        pollAttempt: 7,
        totalAttempts: 120,
        estimatedPct: 6,
      });
      expect(ok).toBe(true);
    });
  });

  describe("notifySessionExpired", () => {
    it("sets the stop flag, stops polling, and posts a session_expired event", async () => {
      const ctx = loadWebhook();
      await ctx.mod.notifySessionExpired("auth-failure");
      expect(ctx.setStopFlag).toHaveBeenCalledTimes(1);
      expect(ctx.stopPolling).toHaveBeenCalledTimes(1);
      expect(ctx.fetchFn).toHaveBeenCalledTimes(1);
    });

    it("de-dups: the second call short-circuits until clearSessionExpiredReport", async () => {
      const ctx = loadWebhook();
      await ctx.mod.notifySessionExpired("first");
      await ctx.mod.notifySessionExpired("second");
      expect(ctx.setStopFlag).toHaveBeenCalledTimes(1);
      ctx.mod.clearSessionExpiredReport();
      await ctx.mod.notifySessionExpired("third");
      expect(ctx.setStopFlag).toHaveBeenCalledTimes(2);
    });

    it("isSessionExpiredReported exposes the flag state", async () => {
      const ctx = loadWebhook();
      expect(ctx.mod.isSessionExpiredReported()).toBe(false);
      await ctx.mod.notifySessionExpired("x");
      expect(ctx.mod.isSessionExpiredReported()).toBe(true);
      ctx.mod.clearSessionExpiredReport();
      expect(ctx.mod.isSessionExpiredReported()).toBe(false);
    });

    it("invokes clearAuthCache so the auth cache drops the stale token", async () => {
      const ctx = loadWebhook();
      await ctx.mod.notifySessionExpired("api-401");
      expect(ctx.clearAuthCache).toHaveBeenCalledTimes(1);
    });

    it("fires a Chrome notification when notificationsEnabled is true", async () => {
      const ctx = loadWebhook({ notificationsEnabled: true });
      await ctx.mod.notifySessionExpired("api-401");
      expect(ctx.notificationsCreate).toHaveBeenCalledTimes(1);
      const [, options] = ctx.notificationsCreate.mock.calls[0];
      expect(options).toMatchObject({
        type: "basic",
        title: expect.any(String),
        message: expect.stringMatching(/labs\.google/i),
      });
    });

    it("arms the auth probe via the scheduleAuthProbe forward-ref (auth-probe.js)", async () => {
      // The probe itself lives in src/auth-probe.js; webhook.js only
      // forward-refs `scheduleAuthProbe`. This pins the contract so the
      // probe arms on every expiry transition (the de-dup guard means
      // it's still called once per expiry, not once per call).
      const ctx = loadWebhook();
      await ctx.mod.notifySessionExpired("api-401");
      expect(ctx.scheduleAuthProbe).toHaveBeenCalledTimes(1);
    });

    it("skips the Chrome notification when notificationsEnabled is false", async () => {
      const ctx = loadWebhook({ notificationsEnabled: false });
      await ctx.mod.notifySessionExpired("api-401");
      expect(ctx.notificationsCreate).not.toHaveBeenCalled();
      // Still posts the StatusEvent so HistForge gets notified.
      expect(ctx.fetchFn).toHaveBeenCalled();
    });
  });

  describe("submitResult", () => {
    it("posts once on success and returns true", async () => {
      const ctx = loadWebhook();
      const ok = await ctx.mod.submitResult(
        { taskId: "t1", resultUrl: "u", mode: "text" },
        [{ base64: "x" }],
      );
      expect(ok).toBe(true);
      expect(ctx.fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = ctx.fetchFn.mock.calls[0];
      expect(url).toBe("https://histforge.example/result");
      const body = JSON.parse(init!.body as string);
      expect(body.type).toBe("ResultSubmission");
      expect(body.taskId).toBe("t1");
      expect(body.mode).toBe("text");
      expect(body.mediaFiles).toEqual([{ base64: "x" }]);
    });

    it("retries up to 3 times on HTTP failure and returns false", async () => {
      const ctx = loadWebhook({
        fetchImpl: async () => ({
          ok: false,
          status: 500,
          text: async () => "server error",
        } as unknown as Response),
      });
      const ok = await ctx.mod.submitResult({ taskId: "t1" });
      expect(ok).toBe(false);
      // retries: 3 → initial + 3 retries = 4 attempts.
      expect(ctx.fetchFn).toHaveBeenCalledTimes(4);
    });

    it("honors getWebhookMaxRetries setting (1 retry → 2 attempts)", async () => {
      const ctx = loadWebhook({
        webhookMaxRetries: 1,
        fetchImpl: async () => ({
          ok: false,
          status: 500,
          text: async () => "server error",
        } as unknown as Response),
      });
      const ok = await ctx.mod.submitResult({ taskId: "t1" });
      expect(ok).toBe(false);
      expect(ctx.fetchFn).toHaveBeenCalledTimes(2);
    });

    it("treats success:false as a non-retryable failure (returns false)", async () => {
      const ctx = loadWebhook({
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          text: async () => '{"success":false}',
        } as unknown as Response),
      });
      const ok = await ctx.mod.submitResult({ taskId: "t1" });
      expect(ok).toBe(false);
      // shouldRetry only matches TIMEOUT / HTTP 5xx / 429 — success:false
      // does not retry, so a single attempt is made.
      expect(ctx.fetchFn).toHaveBeenCalledTimes(1);
    });

    it("omits mediaFiles when none provided", async () => {
      const ctx = loadWebhook();
      await ctx.mod.submitResult({ taskId: "t1" });
      const [, init] = ctx.fetchFn.mock.calls[0];
      const body = JSON.parse(init!.body as string);
      expect(body.mediaFiles).toBeNull();
    });

    it("includes correlationId and timings when provided", async () => {
      const ctx = loadWebhook();
      const timings = {
        submitMs: 412,
        uploadMs: [33, 44],
        pollCount: 12,
        pollMs: 2300,
        upscaleMs: 0,
        fetchMediaMs: 110,
      };
      await ctx.mod.submitResult({
        taskId: "t1",
        correlationId: "abcdef12-3456-7890-abcd-ef1234567890",
        timings,
      });
      const [, init] = ctx.fetchFn.mock.calls[0];
      const body = JSON.parse(init!.body as string);
      expect(body.correlationId).toBe("abcdef12-3456-7890-abcd-ef1234567890");
      expect(body.timings).toEqual(timings);
    });
  });

  describe("postProjectCreated", () => {
    it("POSTs ProjectCreated payload with accountToken + at and returns true on ok", async () => {
      const ctx = loadWebhook();
      const ok = await ctx.mod.postProjectCreated({
        videoId: "v1",
        projectId: "proj-1",
        projectTitle: "Greek Fire",
      });
      expect(ok).toBe(true);
      const [url, init] = ctx.fetchFn.mock.calls[0];
      expect(url).toBe("https://histforge.example/project");
      const body = JSON.parse(init!.body as string);
      expect(body.type).toBe("ProjectCreated");
      expect(body.videoId).toBe("v1");
      expect(body.projectId).toBe("proj-1");
      expect(body.projectTitle).toBe("Greek Fire");
      expect(body.accountToken).toBe("acct-token");
      expect(body.at).toBeDefined();
    });

    it("returns false without posting when projectUrl is empty", async () => {
      const ctx = loadWebhook({ PROJECT_URL: "" });
      const ok = await ctx.mod.postProjectCreated({
        videoId: "v1",
        projectId: "p1",
        projectTitle: "t",
      });
      expect(ok).toBe(false);
      expect(ctx.fetchFn).not.toHaveBeenCalled();
    });

    it("returns false on fetch failure (no retry)", async () => {
      const ctx = loadWebhook({
        fetchImpl: async () => {
          throw new Error("network flake");
        },
      });
      const ok = await ctx.mod.postProjectCreated({
        videoId: "v1",
        projectId: "p1",
        projectTitle: "t",
      });
      expect(ok).toBe(false);
      // Single attempt, no retry
      expect(ctx.fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("postOperationStarted", () => {
    it("returns false without posting when operationStartedUrl is empty", async () => {
      const ctx = loadWebhook({ OPERATION_STARTED_URL: "" });
      const ok = await ctx.mod.postOperationStarted({
        taskId: "t1",
        operationName: "operations/abc",
        projectId: "proj-1",
      });
      expect(ok).toBe(false);
      expect(ctx.fetchFn).not.toHaveBeenCalled();
    });

    it("POSTs an OperationStarted payload with accountToken + at and returns true on ok", async () => {
      const ctx = loadWebhook();
      const ok = await ctx.mod.postOperationStarted({
        taskId: "t1",
        operationName: "operations/abc",
        projectId: "proj-1",
      });
      expect(ok).toBe(true);
      const [url, init] = ctx.fetchFn.mock.calls[0];
      expect(url).toBe("https://histforge.example/operation-started");
      const body = JSON.parse(init!.body as string);
      expect(body.type).toBe("OperationStarted");
      expect(body.taskId).toBe("t1");
      expect(body.operationName).toBe("operations/abc");
      expect(body.projectId).toBe("proj-1");
      expect(body.accountToken).toBe("acct-token");
      expect(body.at).toBeDefined();
    });

    it("returns false on fetch failure with no retry", async () => {
      const ctx = loadWebhook({
        fetchImpl: async () => {
          throw new Error("network flake");
        },
      });
      const ok = await ctx.mod.postOperationStarted({
        taskId: "t1",
        operationName: "operations/abc",
        projectId: "proj-1",
      });
      expect(ok).toBe(false);
      expect(ctx.fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("submitFailure", () => {
    it("POSTs a ResultSubmission with the error string and task mode (legacy)", async () => {
      const ctx = loadWebhook();
      await ctx.mod.submitFailure({ id: "t1", mode: "frames" }, "boom");
      expect(ctx.fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = ctx.fetchFn.mock.calls[0];
      expect(url).toBe("https://histforge.example/result");
      const body = JSON.parse(init!.body as string);
      expect(body.taskId).toBe("t1");
      expect(body.mode).toBe("frames");
      expect(body.error).toBe("boom");
      expect(body.schemaVersion).toBe(2);
      expect(body.errorCode).toBeNull();
      expect(body.errorCategory).toBeNull();
      expect(body.httpStatus).toBeNull();
      expect(body.retryable).toBeNull();
      expect(body.contentPolicyTag).toBeNull();
    });

    it("populates structured fields when given an Error object", async () => {
      const ctx = loadWebhook();
      const err = Object.assign(new Error("Quota exceeded"), {
        reason: "RESOURCE_EXHAUSTED",
        category: "rate_limit",
        httpStatus: 429,
        retryable: true,
        contentPolicyTag: null,
      });
      await ctx.mod.submitFailure({ id: "t1", mode: "video" }, err);
      const [, init] = ctx.fetchFn.mock.calls[0];
      const body = JSON.parse(init!.body as string);
      expect(body.error).toBe("Quota exceeded");
      expect(body.errorCode).toBe("RESOURCE_EXHAUSTED");
      expect(body.errorCategory).toBe("rate_limit");
      expect(body.httpStatus).toBe(429);
      expect(body.retryable).toBe(true);
      expect(body.contentPolicyTag).toBeNull();
      expect(body.schemaVersion).toBe(2);
    });

    it("forwards contentPolicyTag for content-policy errors", async () => {
      const ctx = loadWebhook();
      const err = Object.assign(new Error("blocked: PERSON_GENERATION"), {
        reason: "PERSON_GENERATION",
        category: "content_policy",
        httpStatus: 400,
        retryable: false,
        contentPolicyTag: "PERSON_GENERATION",
      });
      await ctx.mod.submitFailure({ id: "t1" }, err);
      const [, init] = ctx.fetchFn.mock.calls[0];
      const body = JSON.parse(init!.body as string);
      expect(body.errorCategory).toBe("content_policy");
      expect(body.contentPolicyTag).toBe("PERSON_GENERATION");
      expect(body.retryable).toBe(false);
    });

    it("defaults mode to 'image' when task.mode is missing", async () => {
      const ctx = loadWebhook();
      await ctx.mod.submitFailure({ id: "t1" }, "boom");
      const [, init] = ctx.fetchFn.mock.calls[0];
      expect(JSON.parse(init!.body as string).mode).toBe("image");
    });

    it("swallows fetch failures silently (caller doesn't need to catch)", async () => {
      const ctx = loadWebhook({
        fetchImpl: async () => {
          throw new Error("network flake");
        },
      });
      await expect(
        ctx.mod.submitFailure({ id: "t1" }, "boom"),
      ).resolves.toBeUndefined();
    });

    it("includes correlationId and timings from the Error object", async () => {
      const ctx = loadWebhook();
      const timings = {
        submitMs: 200,
        uploadMs: [],
        pollCount: 5,
        pollMs: 800,
        upscaleMs: 0,
        fetchMediaMs: 0,
      };
      const err = Object.assign(new Error("boom"), {
        reason: "GENERATION_FAILED",
        category: "unknown",
        correlationId: "deadbeef-1234-5678-9abc-deadbeef1234",
        timings,
      });
      await ctx.mod.submitFailure({ id: "t1" }, err);
      const [, init] = ctx.fetchFn.mock.calls[0];
      const body = JSON.parse(init!.body as string);
      expect(body.correlationId).toBe("deadbeef-1234-5678-9abc-deadbeef1234");
      expect(body.timings).toEqual(timings);
    });
  });
});
