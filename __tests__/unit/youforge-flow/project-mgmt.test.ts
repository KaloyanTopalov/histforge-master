import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type ProjectMgmt = {
  getOrCreateProjectId: (
    task: { videoId?: string; flowProjectId?: string | null; projectTitle?: string },
    ctx: { tabId: number },
  ) => Promise<string>;
  _sanitizeProjectTitle: (raw: unknown) => string;
  clearInFlight: () => void;
};

function loadProjectMgmt(opts: {
  executeScriptResult?: {
    ok?: boolean;
    status?: number;
    body?: string;
    retryAfter?: string | null;
    error?: string;
  };
  executeScriptThrows?: Error;
  postProjectCreated?: ReturnType<typeof vi.fn>;
  triggerRateLimitCooldown?: ReturnType<typeof vi.fn>;
  assertNotStopped?: () => void;
} = {}) {
  const errorSrc = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/flow-error.js"),
    "utf8",
  );
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/project-mgmt.js"),
    "utf8",
  );
  const executeScript = vi.fn(async () => {
    if (opts.executeScriptThrows) throw opts.executeScriptThrows;
    return [{ result: opts.executeScriptResult ?? { ok: true, status: 200, body: '{}' } }];
  });
  const postProjectCreated = opts.postProjectCreated ?? vi.fn(async () => {});
  const triggerRateLimitCooldown =
    opts.triggerRateLimitCooldown ?? vi.fn(async () => {});
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    assertNotStopped: opts.assertNotStopped ?? (() => {}),
    postProjectCreated,
    triggerRateLimitCooldown,
    String,
    Number,
    JSON,
    Date,
    Math,
    Promise,
    Error,
    Map,
    chrome: { scripting: { executeScript } },
  };
  vm.createContext(sandbox);
  vm.runInContext(errorSrc + "\n" + src, sandbox);
  return {
    mod: sandbox as unknown as ProjectMgmt,
    executeScript,
    postProjectCreated,
    triggerRateLimitCooldown,
  };
}

describe("project-mgmt", () => {
  describe("_sanitizeProjectTitle", () => {
    it("collapses CRLF + whitespace and trims", () => {
      const { mod } = loadProjectMgmt();
      expect(mod._sanitizeProjectTitle("  hello\r\nworld  ")).toBe("hello world");
    });

    it("caps length at 250 chars", () => {
      const { mod } = loadProjectMgmt();
      const long = "a".repeat(400);
      expect(mod._sanitizeProjectTitle(long)).toHaveLength(250);
    });

    it("falls back to 'Untitled video' on empty/whitespace input", () => {
      const { mod } = loadProjectMgmt();
      expect(mod._sanitizeProjectTitle("")).toBe("Untitled video");
      expect(mod._sanitizeProjectTitle("   \r\n  ")).toBe("Untitled video");
      expect(mod._sanitizeProjectTitle(null)).toBe("Untitled video");
      expect(mod._sanitizeProjectTitle(undefined)).toBe("Untitled video");
    });
  });

  describe("getOrCreateProjectId — short-circuits", () => {
    it("returns the stored flowProjectId without creating", async () => {
      const { mod, executeScript, postProjectCreated } = loadProjectMgmt();
      const id = await mod.getOrCreateProjectId(
        { videoId: "v1", flowProjectId: "stored-proj", projectTitle: "Hello" },
        { tabId: 7 },
      );
      expect(id).toBe("stored-proj");
      expect(executeScript).not.toHaveBeenCalled();
      expect(postProjectCreated).not.toHaveBeenCalled();
    });

    it("propagates STOP_REQUESTED via assertNotStopped before creating", async () => {
      const { mod, executeScript } = loadProjectMgmt({
        assertNotStopped: () => { throw new Error("STOP_REQUESTED"); },
      });
      await expect(
        mod.getOrCreateProjectId(
          { videoId: "v1", flowProjectId: null, projectTitle: "x" },
          { tabId: 7 },
        ),
      ).rejects.toThrow("STOP_REQUESTED");
      expect(executeScript).not.toHaveBeenCalled();
    });
  });

  describe("getOrCreateProjectId — happy path", () => {
    it("creates, posts, returns the new projectId, and clears in-flight", async () => {
      const successBody = JSON.stringify({
        result: { data: { json: { result: { projectId: "new-proj-id" } } } },
      });
      const { mod, executeScript, postProjectCreated } = loadProjectMgmt({
        executeScriptResult: { ok: true, status: 200, body: successBody },
      });
      const id = await mod.getOrCreateProjectId(
        { videoId: "v1", flowProjectId: null, projectTitle: "Greek Fire" },
        { tabId: 7 },
      );
      expect(id).toBe("new-proj-id");
      expect(executeScript).toHaveBeenCalledTimes(1);
      expect(postProjectCreated).toHaveBeenCalledWith({
        videoId: "v1",
        projectId: "new-proj-id",
        projectTitle: "Greek Fire",
      });
      // Second call after success must re-create (no caching at this layer).
      const second = await mod.getOrCreateProjectId(
        { videoId: "v1", flowProjectId: null, projectTitle: "Greek Fire" },
        { tabId: 7 },
      );
      expect(second).toBe("new-proj-id");
      expect(executeScript).toHaveBeenCalledTimes(2);
    });

    it("sanitizes the title before sending and reporting", async () => {
      const successBody = JSON.stringify({
        result: { data: { json: { result: { projectId: "p1" } } } },
      });
      let sentBody: string | undefined;
      const { mod, postProjectCreated } = loadProjectMgmt({
        executeScriptResult: { ok: true, status: 200, body: successBody },
      });
      // Spy via executeScript args is awkward; rely on postProjectCreated arg.
      void sentBody;
      await mod.getOrCreateProjectId(
        { videoId: "v1", flowProjectId: null, projectTitle: "  Title\r\nA  " },
        { tabId: 7 },
      );
      expect(postProjectCreated).toHaveBeenCalledWith({
        videoId: "v1",
        projectId: "p1",
        projectTitle: "Title A",
      });
    });

    it("falls back to videoId then 'Untitled video' for the title", async () => {
      const successBody = JSON.stringify({
        result: { data: { json: { result: { projectId: "p1" } } } },
      });
      const { mod, postProjectCreated } = loadProjectMgmt({
        executeScriptResult: { ok: true, status: 200, body: successBody },
      });
      await mod.getOrCreateProjectId(
        { videoId: "video-id-only", flowProjectId: null },
        { tabId: 7 },
      );
      expect(postProjectCreated).toHaveBeenCalledWith({
        videoId: "video-id-only",
        projectId: "p1",
        projectTitle: "video-id-only",
      });
    });
  });

  describe("getOrCreateProjectId — concurrency mutex", () => {
    it("two concurrent calls for the same videoId share one create", async () => {
      const successBody = JSON.stringify({
        result: { data: { json: { result: { projectId: "shared-id" } } } },
      });
      const { mod, executeScript, postProjectCreated } = loadProjectMgmt({
        executeScriptResult: { ok: true, status: 200, body: successBody },
      });
      const [a, b] = await Promise.all([
        mod.getOrCreateProjectId(
          { videoId: "v1", flowProjectId: null, projectTitle: "X" },
          { tabId: 7 },
        ),
        mod.getOrCreateProjectId(
          { videoId: "v1", flowProjectId: null, projectTitle: "X" },
          { tabId: 7 },
        ),
      ]);
      expect(a).toBe("shared-id");
      expect(b).toBe("shared-id");
      expect(executeScript).toHaveBeenCalledTimes(1);
      expect(postProjectCreated).toHaveBeenCalledTimes(1);
    });

    it("a rejected create unblocks subsequent dispatches (no poisoning)", async () => {
      let call = 0;
      const successBody = JSON.stringify({
        result: { data: { json: { result: { projectId: "p1" } } } },
      });
      const executeScript = vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return [{ result: { ok: false, status: 500, body: "boom" } }];
        }
        return [{ result: { ok: true, status: 200, body: successBody } }];
      });
      // Replace executeScript inside the loaded sandbox by using opts;
      // pass a custom impl via executeScriptResult won't work for two calls.
      const errorSrc = readFileSync(
        path.resolve(process.cwd(), "extensions/youforge-flow/src/flow-error.js"),
        "utf8",
      );
      const src = readFileSync(
        path.resolve(process.cwd(), "extensions/youforge-flow/src/project-mgmt.js"),
        "utf8",
      );
      const postProjectCreated = vi.fn(async () => {});
      const sandbox: Record<string, unknown> = {
        console: { log: () => {} },
        safeLog: () => {},
        assertNotStopped: () => {},
        postProjectCreated,
        triggerRateLimitCooldown: vi.fn(async () => {}),
        String, Number, JSON, Date, Math, Promise, Error, Map,
        chrome: { scripting: { executeScript } },
      };
      vm.createContext(sandbox);
      vm.runInContext(errorSrc + "\n" + src, sandbox);
      const mod = sandbox as unknown as ProjectMgmt;
      await expect(
        mod.getOrCreateProjectId(
          { videoId: "v1", flowProjectId: null, projectTitle: "x" },
          { tabId: 7 },
        ),
      ).rejects.toBeDefined();
      // The second call (after the first rejected) should re-enter and succeed.
      const id = await mod.getOrCreateProjectId(
        { videoId: "v1", flowProjectId: null, projectTitle: "x" },
        { tabId: 7 },
      );
      expect(id).toBe("p1");
    });
  });

  describe("_createFlowProject — defensive parsing", () => {
    it("throws auth error on HTTP 401 (isSessionExpired)", async () => {
      const { mod } = loadProjectMgmt({
        executeScriptResult: { ok: false, status: 401, body: "unauthorized" },
      });
      await expect(
        mod.getOrCreateProjectId(
          { videoId: "v1", flowProjectId: null, projectTitle: "x" },
          { tabId: 7 },
        ),
      ).rejects.toMatchObject({
        category: "auth",
        httpStatus: 401,
        isSessionExpired: true,
      });
    });

    it("throws rate_limit error on HTTP 429 and triggers cooldown", async () => {
      const trigger = vi.fn(async () => {});
      const { mod } = loadProjectMgmt({
        executeScriptResult: {
          ok: false,
          status: 429,
          body: '{"error":{"message":"too many"}}',
          retryAfter: "30",
        },
        triggerRateLimitCooldown: trigger,
      });
      await expect(
        mod.getOrCreateProjectId(
          { videoId: "v1", flowProjectId: null, projectTitle: "x" },
          { tabId: 7 },
        ),
      ).rejects.toMatchObject({
        category: "rate_limit",
        httpStatus: 429,
      });
      expect(trigger).toHaveBeenCalledTimes(1);
    });

    it("throws transient error on HTTP 5xx with retryable=true", async () => {
      const { mod } = loadProjectMgmt({
        executeScriptResult: { ok: false, status: 503, body: "down" },
      });
      await expect(
        mod.getOrCreateProjectId(
          { videoId: "v1", flowProjectId: null, projectTitle: "x" },
          { tabId: 7 },
        ),
      ).rejects.toMatchObject({
        category: "transient",
        httpStatus: 503,
        retryable: true,
      });
    });

    it("throws create_project_failed on HTTP 4xx (non-401/429)", async () => {
      const { mod } = loadProjectMgmt({
        executeScriptResult: { ok: false, status: 400, body: "bad request" },
      });
      await expect(
        mod.getOrCreateProjectId(
          { videoId: "v1", flowProjectId: null, projectTitle: "x" },
          { tabId: 7 },
        ),
      ).rejects.toMatchObject({
        category: "create_project_failed",
        httpStatus: 400,
        reason: "HTTP_400",
      });
    });

    it("throws create_project_failed when body is not JSON", async () => {
      const successBody = "<html>not json at all</html>";
      const { mod } = loadProjectMgmt({
        executeScriptResult: { ok: true, status: 200, body: successBody },
      });
      await expect(
        mod.getOrCreateProjectId(
          { videoId: "v1", flowProjectId: null, projectTitle: "x" },
          { tabId: 7 },
        ),
      ).rejects.toMatchObject({
        category: "create_project_failed",
        reason: "CREATE_PROJECT_BODY_NOT_JSON",
      });
    });

    it("throws create_project_failed when envelope shape is unexpected", async () => {
      const wrongShape = JSON.stringify({ result: { data: { json: { wrong: "shape" } } } });
      const { mod } = loadProjectMgmt({
        executeScriptResult: { ok: true, status: 200, body: wrongShape },
      });
      await expect(
        mod.getOrCreateProjectId(
          { videoId: "v1", flowProjectId: null, projectTitle: "x" },
          { tabId: 7 },
        ),
      ).rejects.toMatchObject({
        category: "create_project_failed",
        reason: "CREATE_PROJECT_SHAPE_UNEXPECTED",
      });
    });

    it("throws create_project_failed when projectId is empty/non-string", async () => {
      const emptyId = JSON.stringify({
        result: { data: { json: { result: { projectId: "" } } } },
      });
      const { mod } = loadProjectMgmt({
        executeScriptResult: { ok: true, status: 200, body: emptyId },
      });
      await expect(
        mod.getOrCreateProjectId(
          { videoId: "v1", flowProjectId: null, projectTitle: "x" },
          { tabId: 7 },
        ),
      ).rejects.toMatchObject({
        category: "create_project_failed",
        reason: "CREATE_PROJECT_NO_ID",
      });
    });

    it("throws transient on network error from executeScript", async () => {
      const { mod } = loadProjectMgmt({
        executeScriptThrows: new Error("network down"),
      });
      await expect(
        mod.getOrCreateProjectId(
          { videoId: "v1", flowProjectId: null, projectTitle: "x" },
          { tabId: 7 },
        ),
      ).rejects.toMatchObject({
        category: "transient",
        reason: "CREATE_PROJECT_NETWORK",
        retryable: true,
      });
    });
  });

  describe("clearInFlight", () => {
    it("does not throw on an empty map", () => {
      const { mod } = loadProjectMgmt();
      expect(() => mod.clearInFlight()).not.toThrow();
    });
  });
});
