// Canonical roster of image style IDs, operator-facing labels, and the
// per-style definition map (prompt prefix, per-style locks, reveal-effect
// config). Every consumer derives from this tuple — the narrative workflow
// Zod enum `NarrativeRowSchema.image_style`, the workflow editor option
// list, and step 09's assembler — so adding a style is a one-line edit to
// `IMAGE_STYLE_NAMES` plus a definition entry, after which TypeScript flags
// every consumer that hasn't kept up. Mirrors `lib/image/names.ts`.
//
// Client-safe — no `node:` / `db` imports — same constraint as
// `lib/image/names.ts`, so this can be imported from both the worker (step
// 09) and the workflow editor without dragging step internals into the
// client bundle.

export const IMAGE_STYLE_NAMES = [
  "cinematic",
  "doodle_polished",
  "doodle_rough",
] as const;

export type ImageStyleName = (typeof IMAGE_STYLE_NAMES)[number];

// `Record<ImageStyleName, string>` (not `Partial`) forces a label for every
// name in the tuple — a new entry without a matching label fails to
// compile.
export const IMAGE_STYLE_LABELS: Record<ImageStyleName, string> = {
  cinematic: "Cinematic",
  doodle_polished: "Doodle — polished",
  doodle_rough: "Doodle — rough marker",
};

export interface ImageStyleDefinition {
  // Appended after the per-chunk SUBJECT by the step 09 assembler.
  // Contains ONLY style words — never subject words. The subject comes
  // from the step's LLM.
  prompt_prefix: string;
  // Per-style locks REPLACE the global style_lock_description /
  // character_lock_negative for this style. If null, the assembler falls
  // back to the global lock setting (preserves current behavior for
  // cinematic / unmigrated styles).
  style_lock: string | null;
  negative_lock: string | null;
  reveal_effect: "none" | "pixel_dissolve";
  // CSS color; null = no background composite (full-bleed).
  background_color: string | null;
  // Operator-facing note about recommended image durations.
  pacing_hint?: string;
}

export const IMAGE_STYLE_DEFINITIONS: Record<
  ImageStyleName,
  ImageStyleDefinition
> = {
  cinematic: {
    prompt_prefix: "",
    style_lock: null,
    negative_lock: null,
    reveal_effect: "none",
    background_color: null,
    pacing_hint: "5-7 seconds per image works well",
  },

  // VALIDATED BY HAND in Magnific (Nano Banana 2) during the design
  // session. Came out clean/modern — confident linework, smooth flat
  // color. Good for friendly/positive content. This is the operator's
  // working prompt verbatim.
  doodle_polished: {
    prompt_prefix:
      "whiteboard doodle cartoon illustration, " +
      "thick black felt-tip marker outline, " +
      "flat accent colors (green for money, red for warnings, yellow for highlights), " +
      "pure white background, single centered composition, " +
      "simple scribble shading, friendly hand-drawn style, vector-clean lines",
    style_lock:
      "consistent whiteboard-marker doodle style, flat 2D, pure white background, " +
      "functional color coding (green = money/good, red = warning/loss, yellow = highlight)",
    negative_lock:
      "photorealistic, 3D render, photograph, dark background, complex background, " +
      "realistic textures, dramatic lighting, gradient background",
    reveal_effect: "pixel_dissolve",
    background_color: "#FFFFFF",
    pacing_hint: "3-5 seconds per image works well",
  },

  // VALIDATED DIRECTION in Magnific. Pushes toward the reference channel's
  // authentic hand-drawn marker look (wobbly lines, directional scribble
  // fill, flat 2D, no render polish) via explicit anti-polish negatives.
  // Good for urgent/warning content. NB2 biases toward polish, so the
  // negatives are load-bearing here — without them the output drifts back
  // to doodle_polished.
  doodle_rough: {
    prompt_prefix:
      "rough hand-drawn whiteboard marker doodle, " +
      "wobbly uneven black marker outlines with visible marker texture, " +
      "directional scribble fill shading with visible individual strokes, " +
      "flat 2D look, slightly messy imperfect linework like a real whiteboard drawing, " +
      "flat accent colors (green for money, red for warnings, yellow for highlights), " +
      "pure white background, single centered composition, friendly hand-drawn doodle style",
    style_lock:
      "authentic rough marker doodle, flat 2D, hand-drawn imperfection, pure white background, " +
      "functional color coding (green = money/good, red = warning/loss, yellow = highlight)",
    negative_lock:
      "smooth shading, gradient, drop shadow, 3D render, polished, clean vector lines, " +
      "professional illustration, soft lighting, depth of field, photorealistic, photograph",
    reveal_effect: "pixel_dissolve",
    background_color: "#FFFFFF",
    pacing_hint: "3-5 seconds per image works well",
  },
};
