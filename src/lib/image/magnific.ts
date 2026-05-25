import type { ImageProvider } from "./types";

/**
 * Belt-and-braces stub. The `magnific` provider name appears on
 * `music-video-magnific-suno` workflow snapshots, but those snapshots
 * dispatch image generation through the `magnific_queue` worker step
 * (`generate_loop_image`), not through the `ImageProvider.generateBatch`
 * interface. `resolveDeps` / `runPipeline` already short-circuit the
 * registry lookup for `kind='music_video'`; this stub guards against
 * future code paths that resolve providers regardless of kind.
 */
export const magnificImageProviderStub: ImageProvider = {
  async generateBatch() {
    throw new Error(
      "magnific image provider is dispatched via the magnific_queue worker step, not via generateBatch; this code path should not be reached"
    );
  },
};
