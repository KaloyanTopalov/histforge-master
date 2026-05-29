import type { PromptModerator } from "@/lib/moderator";
import type { ImageProvider } from "./types";
import { comfyuiProvider } from "./comfyui";
import { makeGoogleFlowImageProvider } from "./google-flow";
import { magnificImageProvider } from "./magnific";
import type { ImageProviderName } from "./names";

export type { ImageProvider } from "./types";
export { IMAGE_PROVIDER_NAMES, IMAGE_PROVIDER_LABELS } from "./names";
export type { ImageProviderName } from "./names";

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
export const imageProviders: Record<ImageProviderName, ImageProviderEntry> = {
  comfyui: comfyuiProvider,
  google_flow: ({ moderator }) => makeGoogleFlowImageProvider(moderator),
  magnific: magnificImageProvider,
};

// Compile-time guard: the registry's keys must match the canonical name
// tuple (`./names.ts`) exactly. Adding a provider to one without the other
// fails to compile. Mirrors `_assertRegistryMatchesNames` in
// `lib/llm/index.ts`.
type _AssertRegistryMatchesNames =
  keyof typeof imageProviders extends ImageProviderName
    ? ImageProviderName extends keyof typeof imageProviders
      ? true
      : never
    : never;
const _assertRegistryMatchesNames: _AssertRegistryMatchesNames = true;
void _assertRegistryMatchesNames;

export function getImageProvider(
  name: string,
  deps: ImageProviderDeps
): ImageProvider {
  const entry = imageProviders[name as ImageProviderName];
  if (!entry) {
    throw new Error(`Unknown image provider: "${name}"`);
  }
  return typeof entry === "function" ? entry(deps) : entry;
}
