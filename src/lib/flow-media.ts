import {
  createWriteStream,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Hosts we accept as Google Flow result URLs. This is an SSRF defense —
 * anything off this list is rejected before we fetch, so a compromised or
 * confused extension can't steer HistForge at internal hosts. Enforced
 * here as a helper and again in the submit-result route as a second
 * line of defense.
 */
const ALLOWED_SUFFIXES = [".googleusercontent.com"] as const;
const ALLOWED_EXACT = [
  "storage.googleapis.com",
  "flow-content.google",
] as const;

function isAllowedHttpHost(host: string): boolean {
  for (const exact of ALLOWED_EXACT) {
    if (host === exact) return true;
  }
  for (const suffix of ALLOWED_SUFFIXES) {
    if (host.endsWith(suffix) && host.length > suffix.length) return true;
  }
  // fife.*.googleapis.com — non-empty middle component required.
  if (host.startsWith("fife.") && host.endsWith(".googleapis.com")) {
    const middle = host.slice("fife.".length, -".googleapis.com".length);
    if (middle.length > 0) return true;
  }
  return false;
}

export function isAllowedResultHost(url: string): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  if (url.startsWith("data:")) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return isAllowedHttpHost(parsed.hostname);
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function decodeDataUrl(url: string): Buffer {
  // data:[<mediatype>][;base64],<data>
  const comma = url.indexOf(",");
  if (comma === -1) throw new Error("Malformed data: URL");
  const header = url.slice("data:".length, comma);
  const payload = url.slice(comma + 1);
  if (header.endsWith(";base64")) {
    return Buffer.from(payload, "base64");
  }
  return Buffer.from(decodeURIComponent(payload), "utf8");
}

/**
 * Fetch `sourceUrl` and write it to `<projectsDir>/<videoId>/<relativePath>`.
 * Writes to a sibling `.tmp` first and renames atomically so a partial
 * download can never be mistaken for a finished artifact. Rejects any
 * URL that fails the injected `isAllowedHost` allowlist before issuing
 * a request. The predicate is injected so providers (Google Flow,
 * Magnific, future) can each ship their own host allowlist while the
 * streaming/atomic-rename plumbing stays shared.
 */
export async function downloadToProjectPath(
  videoId: string,
  relativePath: string,
  sourceUrl: string,
  projectsDir: string,
  isAllowedHost: (url: string) => boolean
): Promise<void> {
  if (!isAllowedHost(sourceUrl)) {
    throw new Error(
      `Refusing to download from disallowed host: ${sourceUrl}`
    );
  }

  const finalPath = join(projectsDir, videoId, relativePath);
  const tmpPath = `${finalPath}.tmp`;
  mkdirSync(dirname(finalPath), { recursive: true });

  try {
    if (sourceUrl.startsWith("data:")) {
      // data: URLs are inline base64; buffering the decoded payload
      // is the right call (no network stream to drain, the payload
      // is already in memory as the URL string).
      writeFileSync(tmpPath, decodeDataUrl(sourceUrl));
    } else {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        DEFAULT_TIMEOUT_MS
      );
      try {
        const response = await fetch(sourceUrl, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            `Download failed with status ${response.status}: ${sourceUrl}`
          );
        }
        if (!response.body) {
          throw new Error(`Download response had no body: ${sourceUrl}`);
        }
        // Stream the response directly to disk — keeps memory flat
        // regardless of payload size (hook videos can be tens of MB).
        // pipeline() handles cleanup: it destroys both streams on
        // error, including AbortError from timer expiry.
        await pipeline(
          Readable.fromWeb(response.body as import("stream/web").ReadableStream<Uint8Array>),
          createWriteStream(tmpPath)
        );
      } finally {
        clearTimeout(timer);
      }
    }
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* .tmp may not exist */
    }
    throw err;
  }
}
