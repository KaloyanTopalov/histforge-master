// @vitest-environment node
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Mock the install library so tests don't hit the real GitHub /
// Hugging Face URLs. The mocks return controlled values per test.
vi.mock("@/lib/whisper-install", () => {
  return {
    resolveWhisperInstall: vi.fn(),
    setupWhisper: vi.fn(),
    WhisperInstallError: class WhisperInstallError extends Error {
      constructor(message: string, public stage: string) {
        super(message);
        this.name = "WhisperInstallError";
      }
    },
  };
});

import {
  resolveWhisperInstall,
  setupWhisper,
  WhisperInstallError,
} from "@/lib/whisper-install";

const mockResolve = resolveWhisperInstall as unknown as ReturnType<typeof vi.fn>;
const mockSetup = setupWhisper as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockResolve.mockReset();
  mockSetup.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callPost() {
  const { POST } = await import("@/app/api/whisper/setup/route");
  return POST();
}

function notInstalledState(autoSupported: boolean) {
  return {
    source: "none" as const,
    installed: false,
    binPath: null,
    modelPath: null,
    autoInstallSupported: autoSupported,
  };
}

function installedState(source: "env" | "vendor") {
  return {
    source,
    installed: true,
    binPath: source === "env" ? "/env/bin" : "/vendor/bin",
    modelPath: source === "env" ? "/env/model" : "/vendor/model",
    autoInstallSupported: true,
  };
}

describe("POST /api/whisper/setup", () => {
  it("returns 409 already_installed when an env-vars install is already present", async () => {
    mockResolve.mockReturnValue(installedState("env"));
    const r = await callPost();
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.error).toBe("already_installed");
    expect(body.state.source).toBe("env");
    expect(mockSetup).not.toHaveBeenCalled();
  });

  it("returns 409 already_installed when a vendor/ install is already present", async () => {
    mockResolve.mockReturnValue(installedState("vendor"));
    const r = await callPost();
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("already_installed");
    expect(mockSetup).not.toHaveBeenCalled();
  });

  it("returns 503 unsupported_platform on non-Windows hosts when nothing is configured", async () => {
    mockResolve.mockReturnValue(notInstalledState(false));
    const r = await callPost();
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe("unsupported_platform");
    expect(mockSetup).not.toHaveBeenCalled();
  });

  it("invokes setupWhisper and returns 200 with the resulting paths on success", async () => {
    // First resolve call (preflight) returns not-installed. Second
    // resolve call (post-install) returns vendor state.
    mockResolve
      .mockReturnValueOnce(notInstalledState(true))
      .mockReturnValueOnce(installedState("vendor"));
    mockSetup.mockResolvedValueOnce({
      ok: true,
      binPath: "/repo/vendor/whisper/whisper-cli.exe",
      modelPath: "/repo/vendor/whisper/ggml-base.en.bin",
      binBytes: 9 * 1024 * 1024,
      modelBytes: 150 * 1024 * 1024,
    });

    const r = await callPost();
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.binPath).toContain("whisper-cli.exe");
    expect(body.modelPath).toContain("ggml-base.en.bin");
    expect(body.binBytes).toBe(9 * 1024 * 1024);
    expect(body.modelBytes).toBe(150 * 1024 * 1024);
    expect(body.state.source).toBe("vendor");
    expect(mockSetup).toHaveBeenCalledTimes(1);
  });

  it("returns 500 install_failed with the stage tag when setupWhisper throws WhisperInstallError", async () => {
    mockResolve.mockReturnValueOnce(notInstalledState(true));
    mockSetup.mockRejectedValueOnce(
      new WhisperInstallError(
        "HTTP 404 Not Found on https://github.com/...",
        "download_binary",
      ),
    );

    const r = await callPost();
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body.error).toBe("install_failed");
    expect(body.stage).toBe("download_binary");
    expect(body.message).toContain("HTTP 404");
  });

  it("returns 500 install_failed for unexpected (non-WhisperInstallError) throws", async () => {
    mockResolve.mockReturnValueOnce(notInstalledState(true));
    mockSetup.mockRejectedValueOnce(new Error("disk full"));

    const r = await callPost();
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body.error).toBe("install_failed");
    expect(body.message).toContain("disk full");
  });
});
