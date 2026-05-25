import { describe, it, expect } from "vitest";
import { getImageProvider, imageProviders } from "@/lib/image";
import { noOpModerator } from "../../../helpers/no-op-moderator";

describe("getImageProvider", () => {
  it('returns an ImageProvider for "comfyui"', () => {
    const provider = getImageProvider("comfyui", { moderator: noOpModerator });
    expect(provider).toBeDefined();
    expect(typeof provider.generateBatch).toBe("function");
  });

  it('returns an ImageProvider for "google_flow"', () => {
    const provider = getImageProvider("google_flow", {
      moderator: noOpModerator,
    });
    expect(provider).toBeDefined();
    expect(typeof provider.generateBatch).toBe("function");
  });

  it("throws on unknown provider name", () => {
    expect(() =>
      getImageProvider("nope", { moderator: noOpModerator })
    ).toThrow(/Unknown image provider: "nope"/);
  });

  it('returns a stub ImageProvider for "magnific" (belt-and-braces guard; music_video kind dispatches via magnific_queue, not generateBatch)', () => {
    const provider = getImageProvider("magnific", { moderator: noOpModerator });
    expect(provider).toBeDefined();
    expect(typeof provider.generateBatch).toBe("function");
  });

  it("magnific stub's generateBatch throws a clear error pointing at the magnific_queue worker step", async () => {
    const provider = getImageProvider("magnific", { moderator: noOpModerator });
    await expect(
      provider.generateBatch([], "/tmp", { videoId: "v1", projectsDir: "/tmp" })
    ).rejects.toThrow(/magnific.*magnific_queue/i);
  });
});

describe("imageProviders", () => {
  it("exposes comfyui (singleton), google_flow (factory), and magnific (stub) — Object.keys is the enumeration contract", () => {
    expect(Object.keys(imageProviders)).toEqual([
      "comfyui",
      "google_flow",
      "magnific",
    ]);
  });
});
