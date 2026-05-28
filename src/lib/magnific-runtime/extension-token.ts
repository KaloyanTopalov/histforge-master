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

export class TokenInjectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TokenInjectionError";
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

export async function injectToken(
  context: BrowserContext,
  token: string,
): Promise<void> {
  const id = await resolveExtensionId(context);
  const url = `chrome-extension://${id}/blank.html`;
  const page = await context.newPage();
  try {
    await page.goto(url);
    await page.evaluate(
      (t: string) => {
        // Pages on the chrome-extension:// origin have direct access to
        // the chrome.* APIs; declare the minimal shape here so TS accepts
        // the eval body without pulling in @types/chrome.
        (
          globalThis as unknown as {
            chrome: {
              storage: {
                local: {
                  set: (v: Record<string, string>) => Promise<void>;
                };
              };
            };
          }
        ).chrome.storage.local.set({ magnific_token: t });
      },
      token,
    );
  } catch (err) {
    throw new TokenInjectionError(
      `failed to inject magnific token into extension at ${url}`,
      { cause: err },
    );
  } finally {
    await page.close();
  }
}
