import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { BrowserContext } from "playwright";

const MANIFEST_PATH = resolvePath(
  process.cwd(),
  "extensions/magnific-ext/manifest.json",
);
const EXT_URL_RE = /^chrome-extension:\/\/([a-p]{32})\//;

export class ExtensionIdResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionIdResolutionError";
  }
}

// Raised by `configureAndStartExtension` when the magnific-ext SW reports
// `updateWebhooks` failure, or when the page.evaluate transport itself
// throws. Runtime.start surfaces this as `lastError` and tears down — there
// is no silent fallback to unconfigured polling.
export class ExtensionConfigurationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExtensionConfigurationError";
  }
}

// Exported so the manual probe (scripts/probe-extension-id.ts) can invoke
// the primary-path derivation directly without going through the
// SW-scan fallback in resolveExtensionId — a missing manifest key would
// otherwise produce a false MATCH against chrome.runtime.id via the
// fallback path and silently mask a broken manifest.
export function deriveIdFromKey(base64Key: string): string {
  const der = Buffer.from(base64Key, "base64");
  const digest = createHash("sha256").update(der).digest("hex");
  return digest
    .slice(0, 32)
    .split("")
    .map((ch) =>
      String.fromCharCode(parseInt(ch, 16) + "a".charCodeAt(0)),
    )
    .join("");
}

export async function resolveExtensionId(
  context: BrowserContext,
): Promise<string> {
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
    if (typeof manifest.key === "string" && manifest.key.length > 0) {
      return deriveIdFromKey(manifest.key);
    }
  } catch {
    // Fall through to SW scan
  }
  for (const sw of context.serviceWorkers()) {
    const match = EXT_URL_RE.exec(sw.url());
    if (match) return match[1];
  }
  throw new ExtensionIdResolutionError(
    'could not resolve extension ID: manifest has no "key" field and no chrome-extension:// service worker is registered',
  );
}

// Minimal `chrome` shape inside page.evaluate. Pages on the
// chrome-extension:// origin have direct access to the chrome.* APIs;
// declared here so TS accepts the eval body without pulling in @types/chrome.
type ChromeInPage = {
  runtime: {
    sendMessage: (m: unknown) => Promise<{ success: boolean; error?: string }>;
  };
};

interface UpdateWebhooksResponse {
  success: boolean;
  error?: string;
}

// Build the four extension-facing webhook URLs the popup also computes
// (popup.js:106-115). Token-keyed for next-task/submit-result/status;
// queue-summary is videoId-keyed and stored as the base prefix.
function deriveWebhookUrls(
  baseUrl: string,
  token: string,
): {
  nextTaskUrl: string;
  submitResultUrl: string;
  statusUrl: string;
  queueSummaryUrl: string;
} {
  return {
    nextTaskUrl: `${baseUrl}/api/magnific/next-task/${token}`,
    submitResultUrl: `${baseUrl}/api/magnific/submit-result/${token}`,
    statusUrl: `${baseUrl}/api/magnific/status/${token}`,
    queueSummaryUrl: `${baseUrl}/api/magnific/queue-summary`,
  };
}

// Open the extension's blank.html bridge page, post `updateWebhooks` then
// `startPolling` to the SW message router via chrome.runtime.sendMessage,
// throw ExtensionConfigurationError on updateWebhooks failure. Two
// page.evaluate calls (not one with both sends inline) so the configure-
// before-poll ordering pin is observable from outside the page boundary.
//
// startPolling's response is fire-and-confirm-only: messages.js:15-18
// returns {success:true} synchronously without awaiting runner.startPolling,
// so a startPolling failure cannot surface through the response. The
// ordering pin in tests + the manual end-to-end check ("popup shows Last
// poll: Ns ago") are the real verification that polling actually armed.
export async function configureAndStartExtension(
  context: BrowserContext,
  baseUrl: string,
  token: string,
): Promise<void> {
  const id = await resolveExtensionId(context);
  const bridgeUrl = `chrome-extension://${id}/blank.html`;
  const page = await context.newPage();
  try {
    await page.goto(bridgeUrl);

    const webhooks = deriveWebhookUrls(baseUrl, token);
    const updateMessage = {
      action: "updateWebhooks",
      magnificToken: token,
      histforgeDomain: baseUrl,
      ...webhooks,
    };

    const updateResp = (await page.evaluate(
      async (m: Record<string, unknown>) => {
        const c = (globalThis as unknown as { chrome: ChromeInPage }).chrome;
        return await c.runtime.sendMessage(m);
      },
      updateMessage,
    )) as UpdateWebhooksResponse;

    if (updateResp.success !== true) {
      throw new ExtensionConfigurationError(
        `updateWebhooks failed: ${updateResp.error ?? "unknown error"}`,
      );
    }

    await page.evaluate(
      async (m: Record<string, unknown>) => {
        const c = (globalThis as unknown as { chrome: ChromeInPage }).chrome;
        return await c.runtime.sendMessage(m);
      },
      { action: "startPolling" },
    );
  } catch (err) {
    if (err instanceof ExtensionConfigurationError) throw err;
    throw new ExtensionConfigurationError(
      `failed to configure magnific-ext extension at ${bridgeUrl}`,
      { cause: err },
    );
  } finally {
    await page.close();
  }
}

// Symmetric to `configureAndStartExtension`: open blank.html and post
// `stopPolling` to disarm the SW alarm before the browser teardown. All
// errors are swallowed — stop() is on the teardown path, and a failed
// stopPolling round-trip is a soft warning, not a hard failure (the next
// ctx.close() tears the browser down anyway). Callers must NOT rely on
// the return value or the absence of throws to mean "polling actually
// stopped" — the SW's alarm-cleared state is the real evidence.
export async function sendStopPolling(
  context: BrowserContext,
): Promise<void> {
  let page: Awaited<ReturnType<BrowserContext["newPage"]>> | null = null;
  try {
    const id = await resolveExtensionId(context);
    page = await context.newPage();
    await page.goto(`chrome-extension://${id}/blank.html`);
    await page.evaluate(
      async (m: Record<string, unknown>) => {
        const c = (globalThis as unknown as { chrome: ChromeInPage }).chrome;
        return await c.runtime.sendMessage(m);
      },
      { action: "stopPolling" },
    );
  } catch {
    // intentional swallow — see helper docstring
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // page may already be gone
      }
    }
  }
}

