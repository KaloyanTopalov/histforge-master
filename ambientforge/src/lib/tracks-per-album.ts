import { getSettings } from './settings';
import type { Channel } from './repos/channels';
import type { WorkflowDefinition } from '@/worker/workflows/types';

/**
 * Resolve how many tracks an album should have. Precedence:
 *   1. settings.tracks_per_album_override     (test escape hatch, clamped 1-30)
 *   2. channel.tracksPerAlbum                  (per-channel column, when > 0)
 *   3. workflow.defaultTracksPerAlbum          (workflow default — 30 ambient, 10 rap)
 *
 * Step 02 calls this with the resolved workflow; step 06 calls this with the
 * same so both ends of the pipeline agree on N. The `tracks_per_album_override`
 * setting is the only one that can lower the count to <10 (for fast smoke tests).
 */
export function resolveTracksPerAlbum(
  channel: Channel | null,
  workflow: WorkflowDefinition,
): number {
  const override = getSettings().tracks_per_album_override;
  if (override > 0 && override <= 30) return override;
  if (channel?.tracksPerAlbum != null && channel.tracksPerAlbum > 0) {
    return channel.tracksPerAlbum;
  }
  return workflow.defaultTracksPerAlbum;
}
