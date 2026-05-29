// Canonical roster of image provider IDs and operator-facing labels. Every
// other consumer (the registry's `Record` keying in `./index.ts`, the
// narrative workflow zod enum `NarrativeRowSchema.image_provider`, and the
// workflow editor option list) derives from this tuple — adding a backend is
// a one-line edit here plus a registry entry, after which TypeScript flags
// every consumer that hasn't kept up. Mirrors `lib/llm/names.ts`.
//
// Client-safe — no `node:` / `db` imports — same constraint as
// `lib/llm/names.ts`, so this can be imported from both worker and client
// (workflow editor) surfaces without dragging provider implementations into
// the client bundle.

export const IMAGE_PROVIDER_NAMES = [
  "comfyui",
  "google_flow",
  "magnific",
] as const;

export type ImageProviderName = (typeof IMAGE_PROVIDER_NAMES)[number];

// `Record<ImageProviderName, string>` (not `Partial`) forces a label for
// every name in the tuple — a new entry without a matching label fails to
// compile.
export const IMAGE_PROVIDER_LABELS: Record<ImageProviderName, string> = {
  comfyui: "ComfyUI",
  google_flow: "Google Flow",
  magnific: "Magnific",
};
