import type { PromptModerator } from "@/lib/moderator";
import type { ImageProvider } from "./types";
import { comfyuiProvider } from "./comfyui";
import { makeGoogleFlowImageProvider } from "./google-flow";
import { magnificImageProviderStub } from "./magnific";

export type { ImageProvider } from "./types";

export interface ImageProviderDeps {
  moderator: PromptModerator;
}

type ImageProviderEntry =
  | ImageProvider
  | ((deps: ImageProviderDeps) => ImageProvider);

// Stateless providers register their singleton; factory providers (which
// close over per-run deps like the PromptModerator) register their factory
// function. Object.keys(imageProviders) stays the single source of truth
// for "which provider names exist" — consumed by the schema endpoint and
// the workflow editor.
export const imageProviders: Record<string, ImageProviderEntry> = {
  comfyui: comfyuiProvider,
  google_flow: ({ moderator }) => makeGoogleFlowImageProvider(moderator),
  magnific: magnificImageProviderStub,
};

export function getImageProvider(
  name: string,
  deps: ImageProviderDeps
): ImageProvider {
  const entry = imageProviders[name];
  if (!entry) {
    throw new Error(`Unknown image provider: "${name}"`);
  }
  return typeof entry === "function" ? entry(deps) : entry;
}
