import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadToProjectPath,
  isAllowedResultHost,
} from "@/lib/flow-media";

const tmpDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "histforge-flow-media-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
  vi.unstubAllGlobals();
});

describe("isAllowedResultHost", () => {
  it("accepts the documented Google result hosts", () => {
    expect(
      isAllowedResultHost(
        "https://storage.googleapis.com/bucket/file.png"
      )
    ).toBe(true);
    expect(
      isAllowedResultHost("https://lh3.googleusercontent.com/abc")
    ).toBe(true);
    expect(
      isAllowedResultHost("https://foo.googleusercontent.com/abc")
    ).toBe(true);
    expect(
      isAllowedResultHost("https://fife.usercontent.googleapis.com/xyz")
    ).toBe(true);
    expect(
      isAllowedResultHost(
        "https://flow-content.google/image/abc-123?Expires=1776965701&KeyName=labs-flow-prod-cdn-key&Signature=sig"
      )
    ).toBe(true);
  });

  it("accepts data: URLs (upsample base64 path)", () => {
    expect(isAllowedResultHost("data:image/png;base64,iVBORw=")).toBe(true);
  });

  it("rejects anything outside the allowlist", () => {
    expect(isAllowedResultHost("http://127.0.0.1/x")).toBe(false);
    expect(isAllowedResultHost("http://localhost:8080/x")).toBe(false);
    expect(isAllowedResultHost("https://evil.example.com/x")).toBe(false);
    expect(isAllowedResultHost("file:///etc/passwd")).toBe(false);
    // Attacker-controlled subdomain tricks must not bypass suffix match.
    expect(
      isAllowedResultHost("https://googleapis.com.evil.com/x")
    ).toBe(false);
    expect(isAllowedResultHost("not a url")).toBe(false);
  });
});

describe("downloadToProjectPath", () => {
  it("writes decoded bytes for a data: URL and leaves no .tmp behind", async () => {
    const projects = tempDir();
    const videoId = "v_01";
    const relative = "images/chunk_01.png";
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const dataUrl = `data:image/png;base64,${payload.toString("base64")}`;

    await downloadToProjectPath(
      videoId,
      relative,
      dataUrl,
      projects,
      isAllowedResultHost
    );

    const finalPath = join(projects, videoId, relative);
    expect(existsSync(finalPath)).toBe(true);
    expect(readFileSync(finalPath).equals(payload)).toBe(true);
    const parent = join(projects, videoId, "images");
    expect(readdirSync(parent)).toEqual(["chunk_01.png"]);
  });

  it("streams an allowlisted URL and atomically renames into place", async () => {
    const projects = tempDir();
    const videoId = "v_02";
    const relative = "videos/clip/chunk_02.mp4";
    const bodyBytes = new Uint8Array([1, 2, 3, 4, 5]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(bodyBytes, {
          status: 200,
          headers: { "content-type": "video/mp4" },
        })
      )
    );

    await downloadToProjectPath(
      videoId,
      relative,
      "https://storage.googleapis.com/bucket/file.mp4",
      projects,
      isAllowedResultHost
    );

    const finalPath = join(projects, videoId, relative);
    expect(existsSync(finalPath)).toBe(true);
    expect(Array.from(readFileSync(finalPath))).toEqual(Array.from(bodyBytes));
    const parent = join(projects, videoId, "videos/clip");
    expect(readdirSync(parent)).toEqual(["chunk_02.mp4"]);
  });

  it("rejects a disallowed URL without writing anything", async () => {
    const projects = tempDir();
    const videoId = "v_03";
    const relative = "images/chunk_03.png";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      downloadToProjectPath(
        videoId,
        relative,
        "http://127.0.0.1/leak",
        projects,
        isAllowedResultHost
      )
    ).rejects.toThrow(/disallowed|allowlist|host/i);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(join(projects, videoId))).toBe(false);
  });

  it("throws and cleans up .tmp when the HTTP response is not ok", async () => {
    const projects = tempDir();
    const videoId = "v_04";
    const relative = "images/chunk_04.png";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 }))
    );

    await expect(
      downloadToProjectPath(
        videoId,
        relative,
        "https://storage.googleapis.com/bucket/x.png",
        projects,
        isAllowedResultHost
      )
    ).rejects.toThrow(/500|failed|status/i);

    const parent = join(projects, videoId, "images");
    if (existsSync(parent)) {
      expect(readdirSync(parent)).toEqual([]);
    }
  });

  it("consults the injected predicate — a custom rejector blocks an otherwise-Google URL", async () => {
    const projects = tempDir();
    const videoId = "v_05";
    const relative = "images/chunk_05.png";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const rejectAll = () => false;

    await expect(
      downloadToProjectPath(
        videoId,
        relative,
        "https://storage.googleapis.com/bucket/x.png",
        projects,
        rejectAll
      )
    ).rejects.toThrow(/disallowed|allowlist|host/i);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(join(projects, videoId))).toBe(false);
  });

  it("consults the injected predicate — a custom acceptor downloads from a host the Flow default would reject", async () => {
    const projects = tempDir();
    const videoId = "v_06";
    const relative = "images/chunk_06.png";
    const bodyBytes = new Uint8Array([9, 8, 7]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(bodyBytes, {
          status: 200,
          headers: { "content-type": "image/png" },
        })
      )
    );
    const acceptMagnificOnly = (url: string) =>
      url.startsWith("https://cdn.cdnpk.net/");

    await downloadToProjectPath(
      videoId,
      relative,
      "https://cdn.cdnpk.net/output/abc.png",
      projects,
      acceptMagnificOnly
    );

    const finalPath = join(projects, videoId, relative);
    expect(existsSync(finalPath)).toBe(true);
    expect(Array.from(readFileSync(finalPath))).toEqual(Array.from(bodyBytes));
  });
});
