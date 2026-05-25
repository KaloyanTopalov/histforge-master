import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Settings = {
  loadSettings: () => Promise<void>;
  updateWebhooks: (m: {
    pollUrl?: string;
    resultUrl?: string;
    statusUrl?: string;
    projectUrl?: string;
    operationStartedUrl?: string;
    accountToken?: unknown;
  }) => void;
  updateConcurrency: (bucket: string, n: unknown) => void;
  setMode: (mode: string) => void;
  setVerboseLogging: (v: boolean) => void;
  getPollUrl: () => string;
  getResultUrl: () => string;
  getStatusUrl: () => string;
  getProjectUrl: () => string;
  getOperationStartedUrl: () => string;
  getAccountToken: () => string;
  getMaxConcurrent: (bucket: string) => number;
  getCurrentMode: () => string;
  getVerboseLogging: () => boolean;
  getTaskPollIntervalSec: () => number;
  getWebhookMaxRetries: () => number;
  getUpscaleMaxAttempts: () => number;
  getUploadMaxRetries: () => number;
  getImageRequestTimeoutSec: () => number;
  getVideoRequestTimeoutSec: () => number;
  getUploadTimeoutSec: () => number;
  getMediaFetchTimeoutSec: () => number;
  getSessionReFetchRetries: () => number;
  getProgressEventEveryN: () => number;
  getNotificationsEnabled: () => boolean;
  reloadSettings: () => Promise<void>;
  getSetting: (key: string) => unknown;
};

function buildSandbox(
  getImpl: (keys: string[]) => Promise<Record<string, unknown>>,
): Settings {
  // Settings depends on src/constants.js (MAX_CONCURRENT_MAX),
  // src/settings-schema.js (SETTINGS_SCHEMA), and a global safeLog/chrome
  // shim. Compose a sandbox that has all three available.
  const constantsSrc = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/constants.js"),
    "utf8",
  );
  const schemaSrc = readFileSync(
    path.resolve(
      process.cwd(),
      "extensions/youforge-flow/src/settings-schema.js",
    ),
    "utf8",
  );
  const settingsSrc = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/settings.js"),
    "utf8",
  );
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    chrome: {
      storage: {
        local: {
          get: getImpl,
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    constantsSrc + "\n" + schemaSrc + "\n" + settingsSrc,
    sandbox,
  );
  return sandbox as unknown as Settings;
}

function loadSettingsModule(
  storageValues: Record<string, unknown> = {},
): Settings {
  return buildSandbox(async () => storageValues);
}

describe("settings", () => {
  let s: Settings;
  beforeEach(() => {
    s = loadSettingsModule();
  });

  it("returns defaults before loadSettings runs", () => {
    expect(s.getPollUrl()).toBe("");
    expect(s.getResultUrl()).toBe("");
    expect(s.getStatusUrl()).toBe("");
    expect(s.getProjectUrl()).toBe("");
    expect(s.getOperationStartedUrl()).toBe("");
    expect(s.getAccountToken()).toBe("");
    expect(s.getMaxConcurrent("image")).toBe(5);
    expect(s.getMaxConcurrent("video")).toBe(3);
    expect(s.getCurrentMode()).toBe("image");
  });

  it("updateWebhooks sets all six fields when provided", () => {
    s.updateWebhooks({
      pollUrl: "https://p",
      resultUrl: "https://r",
      statusUrl: "https://st",
      projectUrl: "https://pr",
      operationStartedUrl: "https://op",
      accountToken: "tok",
    });
    expect(s.getPollUrl()).toBe("https://p");
    expect(s.getResultUrl()).toBe("https://r");
    expect(s.getStatusUrl()).toBe("https://st");
    expect(s.getProjectUrl()).toBe("https://pr");
    expect(s.getOperationStartedUrl()).toBe("https://op");
    expect(s.getAccountToken()).toBe("tok");
  });

  it("updateWebhooks only applies accountToken when it is a string", () => {
    s.updateWebhooks({ accountToken: "first" });
    expect(s.getAccountToken()).toBe("first");
    s.updateWebhooks({ accountToken: undefined });
    expect(s.getAccountToken()).toBe("first");
    s.updateWebhooks({ accountToken: 123 });
    expect(s.getAccountToken()).toBe("first");
  });

  it("updateWebhooks coalesces missing URLs to empty string", () => {
    s.updateWebhooks({
      pollUrl: "https://p",
      projectUrl: "https://pr",
      operationStartedUrl: "https://op",
    });
    s.updateWebhooks({});
    expect(s.getPollUrl()).toBe("");
    expect(s.getResultUrl()).toBe("");
    expect(s.getStatusUrl()).toBe("");
    expect(s.getProjectUrl()).toBe("");
    expect(s.getOperationStartedUrl()).toBe("");
  });

  it("loadSettings hydrates projectUrl from chrome.storage.local", async () => {
    const s2 = loadSettingsModule({ projectUrl: "https://stored-project" });
    await s2.loadSettings();
    expect(s2.getProjectUrl()).toBe("https://stored-project");
  });

  it("loadSettings hydrates operationStartedUrl from chrome.storage.local", async () => {
    const s2 = loadSettingsModule({
      operationStartedUrl: "https://stored-op-started",
    });
    await s2.loadSettings();
    expect(s2.getOperationStartedUrl()).toBe("https://stored-op-started");
  });

  it("updateConcurrency treats falsy values (0, '') as bucket-default", () => {
    // Number(value) || default — 0 and NaN both fall through to the
    // bucket-specific default (5 for image, 3 for video).
    s.updateConcurrency("image", 0);
    expect(s.getMaxConcurrent("image")).toBe(5);
    s.updateConcurrency("video", 0);
    expect(s.getMaxConcurrent("video")).toBe(3);
  });

  it("setMode updates currentMode", () => {
    s.setMode("text");
    expect(s.getCurrentMode()).toBe("text");
  });

  it("loadSettings applies values from chrome.storage.local", async () => {
    const s2 = loadSettingsModule({
      pollUrl: "https://p",
      resultUrl: "https://r",
      statusUrl: "https://st",
      accountToken: "tok",
      generationMode: "text",
      imageConcurrency: 8,
      videoConcurrency: 2,
    });
    await s2.loadSettings();
    expect(s2.getPollUrl()).toBe("https://p");
    expect(s2.getResultUrl()).toBe("https://r");
    expect(s2.getStatusUrl()).toBe("https://st");
    expect(s2.getAccountToken()).toBe("tok");
    expect(s2.getCurrentMode()).toBe("text");
    expect(s2.getMaxConcurrent("image")).toBe(8);
    expect(s2.getMaxConcurrent("video")).toBe(2);
  });

  it("loadSettings leaves defaults when storage is empty", async () => {
    await s.loadSettings();
    expect(s.getPollUrl()).toBe("");
    expect(s.getMaxConcurrent("image")).toBe(5);
    expect(s.getMaxConcurrent("video")).toBe(3);
    expect(s.getCurrentMode()).toBe("image");
  });

  describe("bucket-aware concurrency accessors", () => {
    it("getMaxConcurrent('image') returns the imageConcurrency value", () => {
      expect(s.getMaxConcurrent("image")).toBe(5);
    });

    it("getMaxConcurrent('video') returns the videoConcurrency value", () => {
      expect(s.getMaxConcurrent("video")).toBe(3);
    });

    it("getMaxConcurrent throws on unknown bucket discriminant", () => {
      expect(() => s.getMaxConcurrent("audio")).toThrow();
    });

    it("updateConcurrency('image', n) routes to imageConcurrency", () => {
      s.updateConcurrency("image", 7);
      expect(s.getMaxConcurrent("image")).toBe(7);
      // The other bucket stays at its default.
      expect(s.getMaxConcurrent("video")).toBe(3);
    });

    it("updateConcurrency('video', n) routes to videoConcurrency", () => {
      s.updateConcurrency("video", 8);
      expect(s.getMaxConcurrent("video")).toBe(8);
      expect(s.getMaxConcurrent("image")).toBe(5);
    });

    it("updateConcurrency clamps and floors per bucket via the schema normalize hook", () => {
      s.updateConcurrency("image", 20);
      expect(s.getMaxConcurrent("image")).toBe(10);
      s.updateConcurrency("video", 3.9);
      expect(s.getMaxConcurrent("video")).toBe(3);
    });

    it("updateConcurrency falls back to bucket-specific defaults on invalid input", () => {
      // Image default 5; video default 3. Number(garbage) || default
      // mirrors the legacy single-pool fallback path.
      s.updateConcurrency("image", "garbage");
      expect(s.getMaxConcurrent("image")).toBe(5);
      s.updateConcurrency("video", "garbage");
      expect(s.getMaxConcurrent("video")).toBe(3);
    });

    it("updateConcurrency throws on unknown bucket discriminant", () => {
      expect(() => s.updateConcurrency("audio", 5)).toThrow();
    });
  });

  describe("bucket-aware concurrency schema", () => {
    it("exposes imageConcurrency default 5 and videoConcurrency default 3", () => {
      expect(s.getSetting("imageConcurrency")).toBe(5);
      expect(s.getSetting("videoConcurrency")).toBe(3);
    });

    it("removes the single-pool concurrency key from the schema", () => {
      // Old `concurrency` entry is gone — getSetting on an unknown key
      // returns undefined (schema-driven cache never seeded it).
      expect(s.getSetting("concurrency")).toBeUndefined();
    });

    it("loadSettings hydrates both bucket keys from chrome.storage.local", async () => {
      const s2 = loadSettingsModule({
        imageConcurrency: 8,
        videoConcurrency: 2,
      });
      await s2.loadSettings();
      expect(s2.getSetting("imageConcurrency")).toBe(8);
      expect(s2.getSetting("videoConcurrency")).toBe(2);
    });

    it("clamps both bucket keys to [1, MAX_CONCURRENT_MAX] and floors fractions", async () => {
      const s2 = loadSettingsModule({
        imageConcurrency: 99,
        videoConcurrency: 3.9,
      });
      await s2.loadSettings();
      expect(s2.getSetting("imageConcurrency")).toBe(10);
      expect(s2.getSetting("videoConcurrency")).toBe(3);
    });
  });

  describe("verboseLogging", () => {
    it("defaults to false", () => {
      expect(s.getVerboseLogging()).toBe(false);
    });

    it("loadSettings reads verboseLogging from storage", async () => {
      const s2 = loadSettingsModule({ verboseLogging: true });
      await s2.loadSettings();
      expect(s2.getVerboseLogging()).toBe(true);
    });

    it("setVerboseLogging toggles the cached value", () => {
      s.setVerboseLogging(true);
      expect(s.getVerboseLogging()).toBe(true);
      s.setVerboseLogging(false);
      expect(s.getVerboseLogging()).toBe(false);
    });
  });

  describe("Phase 4 task 4.1 tunables", () => {
    it("exposes the documented defaults before loadSettings runs", () => {
      expect(s.getTaskPollIntervalSec()).toBe(10);
      expect(s.getWebhookMaxRetries()).toBe(3);
      expect(s.getUpscaleMaxAttempts()).toBe(3);
      expect(s.getUploadMaxRetries()).toBe(2);
      expect(s.getImageRequestTimeoutSec()).toBe(30);
      expect(s.getVideoRequestTimeoutSec()).toBe(60);
      expect(s.getUploadTimeoutSec()).toBe(60);
      expect(s.getMediaFetchTimeoutSec()).toBe(45);
      expect(s.getSessionReFetchRetries()).toBe(2);
      expect(s.getProgressEventEveryN()).toBe(6);
      expect(s.getNotificationsEnabled()).toBe(true);
    });

    it("loadSettings hydrates each tunable from chrome.storage.local", async () => {
      const s2 = loadSettingsModule({
        taskPollIntervalSec: 20,
        webhookMaxRetries: 5,
        upscaleMaxAttempts: 6,
        uploadMaxRetries: 4,
        imageRequestTimeoutSec: 45,
        videoRequestTimeoutSec: 90,
        uploadTimeoutSec: 75,
        mediaFetchTimeoutSec: 60,
        sessionReFetchRetries: 3,
        progressEventEveryN: 12,
        notificationsEnabled: false,
      });
      await s2.loadSettings();
      expect(s2.getTaskPollIntervalSec()).toBe(20);
      expect(s2.getWebhookMaxRetries()).toBe(5);
      expect(s2.getUpscaleMaxAttempts()).toBe(6);
      expect(s2.getUploadMaxRetries()).toBe(4);
      expect(s2.getImageRequestTimeoutSec()).toBe(45);
      expect(s2.getVideoRequestTimeoutSec()).toBe(90);
      expect(s2.getUploadTimeoutSec()).toBe(75);
      expect(s2.getMediaFetchTimeoutSec()).toBe(60);
      expect(s2.getSessionReFetchRetries()).toBe(3);
      expect(s2.getProgressEventEveryN()).toBe(12);
      expect(s2.getNotificationsEnabled()).toBe(false);
    });

    it("ignores non-finite numeric values and keeps defaults", async () => {
      const s2 = loadSettingsModule({
        taskPollIntervalSec: "garbage",
        webhookMaxRetries: null,
      });
      await s2.loadSettings();
      expect(s2.getTaskPollIntervalSec()).toBe(10);
      expect(s2.getWebhookMaxRetries()).toBe(3);
    });
  });

  describe("reloadSettings", () => {
    it("re-reads chrome.storage.local on every call", async () => {
      const storage: Record<string, unknown> = { webhookMaxRetries: 3 };
      // Build a sandbox that returns the live storage object on each get.
      const mod = buildSandbox(async () => ({ ...storage }));
      await mod.loadSettings();
      expect(mod.getWebhookMaxRetries()).toBe(3);

      // Update storage out-of-band, then reload.
      storage.webhookMaxRetries = 8;
      await mod.reloadSettings();
      expect(mod.getWebhookMaxRetries()).toBe(8);
    });
  });

  describe("getSetting", () => {
    it("returns undefined for unknown keys", () => {
      expect(s.getSetting("not_a_real_key")).toBeUndefined();
    });

    it("returns the schema default before loadSettings runs", () => {
      // Spot-check a few known keys against their declared defaults.
      expect(s.getSetting("taskPollIntervalSec")).toBe(10);
      expect(s.getSetting("notificationsEnabled")).toBe(true);
      expect(s.getSetting("pollUrl")).toBe("");
      expect(s.getSetting("generationMode")).toBe("image");
    });

    it("reflects values loaded from storage", async () => {
      const s2 = loadSettingsModule({ taskPollIntervalSec: 42 });
      await s2.loadSettings();
      expect(s2.getSetting("taskPollIntervalSec")).toBe(42);
    });
  });
});
