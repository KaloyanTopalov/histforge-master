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

  it('returns an ImageProvider for "magnific"', () => {
    const provider = getImageProvider("magnific", { moderator: noOpModerator });
    expect(provider).toBeDefined();
    expect(typeof provider.generateBatch).toBe("function");
  });
});

describe("imageProviders", () => {
  it("exposes comfyui (singleton), google_flow (factory), and magnific (singleton) — Object.keys is the enumeration contract", () => {
    expect(Object.keys(imageProviders)).toEqual([
      "comfyui",
      "google_flow",
      "magnific",
    ]);
  });
});
