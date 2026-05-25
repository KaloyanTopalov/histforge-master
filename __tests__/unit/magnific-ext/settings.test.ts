import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Settings = {
  loadSettings: () => Promise<void>;
  updateWebhooks: (m: {
    nextTaskUrl?: string;
    submitResultUrl?: string;
    statusUrl?: string;
    queueSummaryUrl?: string;
    magnificToken?: unknown;
  }) => void;
  setVerboseLogging: (v: boolean) => void;
  getNextTaskUrl: () => string;
  getSubmitResultUrl: () => string;
  getStatusUrl: () => string;
  getQueueSummaryUrl: () => string;
  getHistforgeDomain: () => string;
  getMagnificToken: () => string;
  getPollIntervalSec: () => number;
  getVerboseLogging: () => boolean;
  getSetting: (key: string) => unknown;
  reloadSettings: () => Promise<void>;
};

function loadSettingsModule(
  storage: Record<string, unknown> = {},
): Settings {
  const constants = readFileSync(
    path.resolve(process.cwd(), "extensions/magnific-ext/src/constants.js"),
    "utf8",
  );
  const schema = readFileSync(
    path.resolve(
      process.cwd(),
      "extensions/magnific-ext/src/settings-schema.js",
    ),
    "utf8",
  );
  const settings = readFileSync(
    path.resolve(process.cwd(), "extensions/magnific-ext/src/settings.js"),
    "utf8",
  );
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    chrome: {
      storage: {
        local: {
          get: async () => storage,
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(constants + "\n" + schema + "\n" + settings, sandbox);
  return sandbox as unknown as Settings;
}

describe("magnific-ext settings", () => {
  it("returns defaults before loadSettings runs", () => {
    const s = loadSettingsModule();
    expect(s.getNextTaskUrl()).toBe("");
    expect(s.getSubmitResultUrl()).toBe("");
    expect(s.getStatusUrl()).toBe("");
    expect(s.getQueueSummaryUrl()).toBe("");
    expect(s.getHistforgeDomain()).toBe("");
    expect(s.getMagnificToken()).toBe("");
    // pollIntervalSec defaults to DEFAULT_POLL_INTERVAL_SEC (10)
    expect(s.getPollIntervalSec()).toBe(10);
    expect(s.getVerboseLogging()).toBe(false);
  });

  it("loadSettings populates cache from chrome.storage.local with kind coercion", async () => {
    const s = loadSettingsModule({
      histforgeDomain: "http://localhost:3000",
      magnificToken: "mtoken",
      nextTaskUrl: "http://localhost:3000/api/magnific/next-task/mtoken",
      submitResultUrl: "http://localhost:3000/api/magnific/submit-result/mtoken",
      statusUrl: "http://localhost:3000/api/magnific/status/mtoken",
      queueSummaryUrl: "http://localhost:3000/api/magnific/queue-summary/123",
      pollIntervalSec: 20,
      verboseLogging: true,
    });
    await s.loadSettings();
    expect(s.getHistforgeDomain()).toBe("http://localhost:3000");
    expect(s.getMagnificToken()).toBe("mtoken");
    expect(s.getNextTaskUrl()).toBe(
      "http://localhost:3000/api/magnific/next-task/mtoken",
    );
    expect(s.getPollIntervalSec()).toBe(20);
    expect(s.getVerboseLogging()).toBe(true);
  });

  it("updateWebhooks writes all four URL keys + token without going through coercion", () => {
    const s = loadSettingsModule();
    s.updateWebhooks({
      nextTaskUrl: "http://h/api/magnific/next-task/T",
      submitResultUrl: "http://h/api/magnific/submit-result/T",
      statusUrl: "http://h/api/magnific/status/T",
      queueSummaryUrl: "http://h/api/magnific/queue-summary/V",
      magnificToken: "T",
    });
    expect(s.getNextTaskUrl()).toBe("http://h/api/magnific/next-task/T");
    expect(s.getSubmitResultUrl()).toBe("http://h/api/magnific/submit-result/T");
    expect(s.getStatusUrl()).toBe("http://h/api/magnific/status/T");
    expect(s.getQueueSummaryUrl()).toBe("http://h/api/magnific/queue-summary/V");
    expect(s.getMagnificToken()).toBe("T");
  });

  it("updateWebhooks accepts empty strings to clear URLs (coercion would reject these)", () => {
    const s = loadSettingsModule();
    s.updateWebhooks({
      nextTaskUrl: "http://h/api/magnific/next-task/T",
      submitResultUrl: "",
      statusUrl: "",
      queueSummaryUrl: "",
    });
    expect(s.getNextTaskUrl()).toBe("http://h/api/magnific/next-task/T");
    expect(s.getSubmitResultUrl()).toBe("");
  });

  it("setVerboseLogging coerces truthy/falsy to boolean", () => {
    const s = loadSettingsModule();
    s.setVerboseLogging(true);
    expect(s.getVerboseLogging()).toBe(true);
    s.setVerboseLogging(false);
    expect(s.getVerboseLogging()).toBe(false);
  });
});
