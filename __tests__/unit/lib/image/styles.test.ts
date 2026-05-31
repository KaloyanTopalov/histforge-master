import { describe, it, expect } from "vitest";
import {
  IMAGE_STYLE_NAMES,
  IMAGE_STYLE_LABELS,
  IMAGE_STYLE_DEFINITIONS,
} from "@/lib/image/styles";

describe("image styles registry", () => {
  it("exposes the three style ids in spec order", () => {
    expect(IMAGE_STYLE_NAMES).toEqual([
      "cinematic",
      "doodle_polished",
      "doodle_rough",
    ]);
  });

  it("labels every style id", () => {
    for (const name of IMAGE_STYLE_NAMES) {
      expect(IMAGE_STYLE_LABELS[name]).toBeTruthy();
    }
  });

  it("defines every style id in IMAGE_STYLE_DEFINITIONS", () => {
    for (const name of IMAGE_STYLE_NAMES) {
      expect(IMAGE_STYLE_DEFINITIONS[name]).toBeDefined();
    }
  });

  it("cinematic carries null locks and empty prompt_prefix (global fallback contract)", () => {
    const def = IMAGE_STYLE_DEFINITIONS.cinematic;
    expect(def.prompt_prefix).toBe("");
    expect(def.style_lock).toBeNull();
    expect(def.negative_lock).toBeNull();
    expect(def.reveal_effect).toBe("none");
    expect(def.background_color).toBeNull();
  });

  it("doodle_polished declares its own color-allowing locks (NOT global fallback)", () => {
    const def = IMAGE_STYLE_DEFINITIONS.doodle_polished;
    expect(def.prompt_prefix).toMatch(/whiteboard doodle/i);
    expect(def.style_lock).not.toBeNull();
    expect(def.style_lock).toMatch(/whiteboard-marker doodle/i);
    expect(def.negative_lock).not.toBeNull();
    expect(def.negative_lock).toMatch(/photorealistic/i);
    expect(def.reveal_effect).toBe("pixel_dissolve");
    expect(def.background_color).toBe("#FFFFFF");
  });

  it("doodle_rough's negative_lock contains the anti-polish terms (load-bearing)", () => {
    const neg = IMAGE_STYLE_DEFINITIONS.doodle_rough.negative_lock ?? "";
    expect(neg).toMatch(/drop shadow/i);
    expect(neg).toMatch(/3D render/i);
    expect(neg).toMatch(/polished/i);
  });
});
