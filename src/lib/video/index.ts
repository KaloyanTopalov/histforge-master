import type { PromptModerator } from "@/lib/moderator";
import type { VideoProvider } from "./types";
import { comfyuiVideoProvider } from "./comfyui";
import { makeGoogleFlowVideoProvider } from "./google-flow";
import { magnificVideoProviderStub } from "./magnific";

export type { VideoProvider } from "./types";

export interface VideoProviderDeps {
  moderator: PromptModerator;
}

type VideoProviderEntry =
  | VideoProvider
  | ((deps: VideoProviderDeps) => VideoProvider);

// See `src/lib/image/index.ts` for the rationale on mixing singletons
// and factories in one record — same shape, same enumeration contract.
export const videoProviders: Record<string, VideoProviderEntry> = {
  comfyui: comfyuiVideoProvider,
  google_flow: ({ moderator }) => makeGoogleFlowVideoProvider(moderator),
  magnific: magnificVideoProviderStub,
};

export function getVideoProvider(
  name: string,
  deps: VideoProviderDeps
): VideoProvider {
  const entry = videoProviders[name];
  if (!entry) {
    throw new Error(`Unknown video provider: "${name}"`);
  }
  return typeof entry === "function" ? entry(deps) : entry;
}
