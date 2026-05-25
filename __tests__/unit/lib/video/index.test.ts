import { describe, it, expect } from "vitest";
import { getVideoProvider, videoProviders } from "@/lib/video";
import { noOpModerator } from "../../../helpers/no-op-moderator";

describe("getVideoProvider", () => {
  it('returns a VideoProvider for "comfyui"', () => {
    const provider = getVideoProvider("comfyui", { moderator: noOpModerator });
    expect(provider).toBeDefined();
    expect(typeof provider.generateBatch).toBe("function");
  });

  it('returns a VideoProvider for "google_flow"', () => {
    const provider = getVideoProvider("google_flow", {
      moderator: noOpModerator,
    });
    expect(provider).toBeDefined();
    expect(typeof provider.generateBatch).toBe("function");
  });

  it("throws on unknown provider name", () => {
    expect(() =>
      getVideoProvider("nope", { moderator: noOpModerator })
    ).toThrow(/Unknown video provider: "nope"/);
  });

  it('returns a stub VideoProvider for "magnific" (belt-and-braces guard; music_video kind dispatches via magnific_queue, not generateBatch)', () => {
    const provider = getVideoProvider("magnific", { moderator: noOpModerator });
    expect(provider).toBeDefined();
    expect(typeof provider.generateBatch).toBe("function");
  });

  it("magnific stub's generateBatch throws a clear error pointing at the magnific_queue worker step", async () => {
    const provider = getVideoProvider("magnific", { moderator: noOpModerator });
    await expect(
      provider.generateBatch([], "/tmp", { videoId: "v1", projectsDir: "/tmp" })
    ).rejects.toThrow(/magnific.*magnific_queue/i);
  });
});

describe("videoProviders", () => {
  it("exposes comfyui (singleton), google_flow (factory), and magnific (stub) — Object.keys is the enumeration contract", () => {
    expect(Object.keys(videoProviders)).toEqual([
      "comfyui",
      "google_flow",
      "magnific",
    ]);
  });
});
