import type { VideoProvider } from "./types";

/**
 * Belt-and-braces stub. The `magnific` provider name appears on
 * `music-video-magnific-suno` workflow snapshots, but those snapshots
 * dispatch image-to-video generation through the `magnific_queue` worker
 * step (`generate_loop_clip`), not through the `VideoProvider.generateBatch`
 * interface. `resolveDeps` / `runPipeline` already short-circuit the
 * registry lookup for `kind='music_video'`; this stub guards against
 * future code paths that resolve providers regardless of kind.
 */
export const magnificVideoProviderStub: VideoProvider = {
  async generateBatch() {
    throw new Error(
      "magnific video provider is dispatched via the magnific_queue worker step, not via generateBatch; this code path should not be reached"
    );
  },
};
