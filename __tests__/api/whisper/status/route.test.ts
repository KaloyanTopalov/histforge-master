// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/whisper-install", () => {
  return {
    resolveWhisperInstall: vi.fn(),
  };
});

import { resolveWhisperInstall } from "@/lib/whisper-install";

const mockResolve = resolveWhisperInstall as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockResolve.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function callGet() {
  const { GET } = await import("@/app/api/whisper/status/route");
  return GET();
}

describe("GET /api/whisper/status", () => {
  it("returns the env-source install state", async () => {
    mockResolve.mockReturnValue({
      source: "env",
      installed: true,
      binPath: "/env/bin",
      modelPath: "/env/model",
      autoInstallSupported: true,
    });
    const r = await callGet();
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({
      source: "env",
      installed: true,
      binPath: "/env/bin",
      modelPath: "/env/model",
      autoInstallSupported: true,
    });
  });

  it("returns the vendor-source install state", async () => {
    mockResolve.mockReturnValue({
      source: "vendor",
      installed: true,
      binPath: "/vendor/whisper/whisper-cli.exe",
      modelPath: "/vendor/whisper/ggml-base.en.bin",
      autoInstallSupported: true,
    });
    const body = await (await callGet()).json();
    expect(body.source).toBe("vendor");
    expect(body.installed).toBe(true);
  });

  it("returns source:none + installed:false when nothing is configured", async () => {
    mockResolve.mockReturnValue({
      source: "none",
      installed: false,
      binPath: null,
      modelPath: null,
      autoInstallSupported: true,
    });
    const body = await (await callGet()).json();
    expect(body.source).toBe("none");
    expect(body.installed).toBe(false);
    expect(body.binPath).toBeNull();
  });

  it("reflects autoInstallSupported: false on non-Windows hosts", async () => {
    mockResolve.mockReturnValue({
      source: "none",
      installed: false,
      binPath: null,
      modelPath: null,
      autoInstallSupported: false,
    });
    const body = await (await callGet()).json();
    expect(body.autoInstallSupported).toBe(false);
  });
});
