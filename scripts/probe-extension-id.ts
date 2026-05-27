import { chromium } from "playwright";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  deriveIdFromKey,
  resolveExtensionId,
} from "../src/lib/magnific-runtime/extension-token";

async function main() {
  const extPath = resolve(process.cwd(), "extensions/magnific-ext");
  const manifestPath = join(extPath, "manifest.json");
  const userDir = mkdtempSync(join(tmpdir(), "magnific-probe-"));
  console.log(`[probe] userDataDir = ${userDir}`);
  console.log(`[probe] extensionPath = ${extPath}`);

  // Read the manifest key explicitly — fail loud if the primary input is
  // missing rather than letting resolveExtensionId silently fall back to
  // the SW URL scan (which would return the same id as chrome.runtime.id
  // and produce a false MATCH that masks a broken manifest).
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (typeof manifest.key !== "string" || manifest.key.length === 0) {
    throw new Error(
      '[probe] manifest.json has no "key" field — primary path is broken at the source',
    );
  }
  const manifestDerivedId = deriveIdFromKey(manifest.key);

  const context = await chromium.launchPersistentContext(userDir, {
    headless: false,
    args: [
      `--load-extension=${extPath}`,
      `--disable-extensions-except=${extPath}`,
      "--window-position=4000,4000",
    ],
    viewport: { width: 800, height: 600 },
  });

  try {
    const start = Date.now();
    let sw = context
      .serviceWorkers()
      .find((w) => w.url().startsWith("chrome-extension://"));
    while (!sw && Date.now() - start < 10_000) {
      await new Promise((r) => setTimeout(r, 200));
      sw = context
        .serviceWorkers()
        .find((w) => w.url().startsWith("chrome-extension://"));
    }
    if (!sw) {
      throw new Error("[probe] service worker never appeared within 10s");
    }
    const runtimeId = await sw.evaluate(
      () =>
        (
          globalThis as unknown as {
            chrome: { runtime: { id: string } };
          }
        ).chrome.runtime.id,
    );
    const resolvedId = await resolveExtensionId(context);

    console.log(`[probe] chrome.runtime.id         = ${runtimeId}`);
    console.log(`[probe] deriveIdFromKey(manifest) = ${manifestDerivedId}`);
    console.log(`[probe] resolveExtensionId(ctx)   = ${resolvedId}`);

    const allMatch =
      runtimeId === manifestDerivedId && manifestDerivedId === resolvedId;
    console.log(`[probe] MATCH = ${allMatch}`);
    if (!allMatch) {
      console.error("[probe] MISMATCH — at least one pair disagrees:");
      if (runtimeId !== manifestDerivedId) {
        console.error(
          `  chrome.runtime.id (${runtimeId}) !== deriveIdFromKey (${manifestDerivedId})`,
        );
      }
      if (manifestDerivedId !== resolvedId) {
        console.error(
          `  deriveIdFromKey (${manifestDerivedId}) !== resolveExtensionId (${resolvedId})`,
        );
      }
      process.exitCode = 1;
    }
  } finally {
    await context.close();
    // Windows: Chromium can hold a userDataDir lock for ~1-2s after
    // context.close() resolves. Node's rmSync supports retries since 18.
    rmSync(userDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 500,
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
