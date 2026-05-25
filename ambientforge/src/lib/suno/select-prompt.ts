import * as albumsRepo from '@/lib/repos/albums';
import * as channelsRepo from '@/lib/repos/channels';
import * as sunoPromptsRepo from '@/lib/repos/channel-suno-prompts';
import * as tracksRepo from '@/lib/repos/tracks';
import { getDb, type Db } from '@/lib/db';
import type { Album } from '@/lib/repos/albums';
import type { Track } from '@/lib/repos/tracks';
import type { ChannelSunoPrompt } from '@/lib/repos/channel-suno-prompts';

export type SelectedSunoPrompt = {
  /** ULID id of the picked prompt row, or null when falling back to the
   *  legacy column / in-flight album snapshot. */
  promptId: string | null;
  content: string;
  source: 'channel-prompts' | 'legacy-column' | 'in-flight-album-snapshot' | 'resumed';
};

export class SunoStylePromptRequiredError extends Error {
  readonly code = 'SUNO_STYLE_PROMPT_REQUIRED';
  constructor(channelId: string, albumId: string) {
    super(
      `channel ${channelId} has no active suno prompts and no legacy suno_style_prompt; album ${albumId} cannot proceed`,
    );
    this.name = 'SunoStylePromptRequiredError';
  }
}

/**
 * Pick the suno style prompt to use for `albumId`, persisting the selection
 * onto the album row so subsequent step-03 retries reuse it idempotently.
 *
 * Resolution order:
 *   1. Resumed: album.sunoPromptId already set → re-fetch that prompt; if the
 *      row was deleted, fall back to album.sunoPromptResolvedText.
 *   2. In-flight: album.sunoPromptId is null but album.sunoPromptResolvedText
 *      is null AND album.sunoStylePrompt is non-empty → this album was created
 *      under the old schema where step 01 wrote sunoStylePrompt. Preserve.
 *   3. Channel-prompts: pick uniformly at random from active prompts in the
 *      channel collection. Persist promptId + resolved text + sunoStylePrompt.
 *   4. Legacy column: 0 active prompts but channel.sunoStylePrompt non-empty
 *      → use legacy value. Persist resolved text + sunoStylePrompt; promptId
 *      stays null.
 *   5. Hard-fail with SunoStylePromptRequiredError. Should have been caught at
 *      preflight.
 *
 * Note: weights are stored on prompt rows for a future weighted-selection
 * feature, but selection here is uniform random (Math.random()).
 */
export async function selectSunoPromptForAlbum(
  channelId: string,
  albumId: string,
  db: Db = getDb(),
): Promise<SelectedSunoPrompt> {
  const album = albumsRepo.get(albumId, db);
  if (!album) throw new Error(`album ${albumId} not found`);

  // 1. Resumed via FK: prompt still exists in the collection.
  if (album.sunoPromptId) {
    const existing = sunoPromptsRepo.get(album.sunoPromptId, db);
    if (existing) {
      return { promptId: existing.id, content: existing.content, source: 'resumed' };
    }
    // Edge case: FK set but row gone (shouldn't happen with our remove()
    // cascade, but be defensive). Fall through to resolved-text branch.
  }

  // 2. Resumed via resolved-text snapshot: prior step 03 ran, but the prompt
  // was later deleted (remove() nulls the FK and keeps resolved_text). The
  // snapshot is the source of truth — never re-roll.
  if (album.sunoPromptResolvedText && album.sunoPromptResolvedText.length > 0) {
    return {
      promptId: null,
      content: album.sunoPromptResolvedText,
      source: 'resumed',
    };
  }

  // 3. In-flight (pre-v7 schema): step 01 wrote sunoStylePrompt before the
  // collection existed. Preserve that value.
  if (album.sunoStylePrompt && album.sunoStylePrompt.length > 0) {
    albumsRepo.patch(
      albumId,
      { sunoPromptResolvedText: album.sunoStylePrompt },
      db,
    );
    return {
      promptId: null,
      content: album.sunoStylePrompt,
      source: 'in-flight-album-snapshot',
    };
  }

  // 4. Channel-prompts: random pick from the active collection.
  const active = sunoPromptsRepo.listByChannel(channelId, { activeOnly: true }, db);
  if (active.length > 0) {
    const idx = Math.floor(Math.random() * active.length);
    const picked = active[idx];
    albumsRepo.patch(
      albumId,
      {
        sunoPromptId: picked.id,
        sunoPromptResolvedText: picked.content,
        sunoStylePrompt: picked.content,
      },
      db,
    );
    return { promptId: picked.id, content: picked.content, source: 'channel-prompts' };
  }

  // 5. Legacy column.
  const channel = channelsRepo.get(channelId, db);
  if (channel?.sunoStylePrompt && channel.sunoStylePrompt.length > 0) {
    albumsRepo.patch(
      albumId,
      {
        sunoPromptResolvedText: channel.sunoStylePrompt,
        sunoStylePrompt: channel.sunoStylePrompt,
      },
      db,
    );
    return {
      promptId: null,
      content: channel.sunoStylePrompt,
      source: 'legacy-column',
    };
  }

  // 6. Hard-fail.
  throw new SunoStylePromptRequiredError(channelId, albumId);
}

/**
 * Per-track style assignment (v8). Returns one SelectedSunoPrompt entry per
 * track in the album, ordered by trackNumber ASC. Allows a single album to
 * rotate styles across its tracks (mixtape format) when the channel has
 * multiple active prompts.
 *
 * Algorithm:
 *   - If ANY track already has tracks.suno_prompt_id set → resume mode: use
 *     stored ids verbatim, fill any gaps deterministically. Never re-roll
 *     across a retry.
 *   - Else if the album already has a single-style binding from prior step 03
 *     (album.suno_prompt_id / suno_prompt_resolved_text / suno_style_prompt) →
 *     legacy single-style: every track uses that same prompt. Persist it on
 *     each track row so audit is consistent going forward.
 *   - Else with N >= 1 active prompts → round-robin sorted by id ASC. Track
 *     i (1-indexed) maps to sorted[(i-1) % N]. Persist each track's pick to
 *     tracks.suno_prompt_id + tracks.suno_prompt_resolved_text. Set
 *     album.suno_prompt_id + suno_prompt_resolved_text + suno_style_prompt
 *     to track-1's pick (album-level "primary" for cover/audit).
 *   - Else → delegate to selectSunoPromptForAlbum and use its result for all
 *     tracks (handles legacy column + hard-fail).
 *
 * Idempotency: per-track FKs lock in the rotation on the first run. Retries
 * re-read those FKs and re-fetch content, so adding/removing prompts mid-album
 * doesn't shift earlier track assignments.
 *
 * Returns content snapshots resolved at call time. If a track's stored
 * suno_prompt_id no longer exists in channel_suno_prompts (e.g., deleted
 * post-submission), falls back to tracks.suno_prompt_resolved_text, then
 * album.suno_prompt_resolved_text, then album.suno_style_prompt.
 */
export async function selectSunoPromptRotation(
  channelId: string,
  albumId: string,
  db: Db = getDb(),
): Promise<SelectedSunoPrompt[]> {
  const album = albumsRepo.get(albumId, db);
  if (!album) throw new Error(`album ${albumId} not found`);
  const tracks = tracksRepo.listByAlbum(albumId, db);
  if (tracks.length === 0) return [];

  const active = sunoPromptsRepo.listByChannel(channelId, { activeOnly: true }, db);

  // Resume: any track already has a stored prompt id (or snapshot). Lock in
  // existing assignments; fill gaps from the deterministic rotation.
  const anyPerTrack = tracks.some(
    (t) => t.sunoPromptId != null || (t.sunoPromptResolvedText ?? '').length > 0,
  );
  if (anyPerTrack) {
    return resumePerTrack(album, tracks, active, db);
  }

  // Legacy single-style: prior step 03 ran with the v7 album-level binding.
  // Honor that — every track uses the album's existing prompt. Persist to
  // tracks so future retries take the resume path above.
  const albumHasBinding =
    !!album.sunoPromptId ||
    (album.sunoPromptResolvedText ?? '').length > 0 ||
    (album.sunoStylePrompt ?? '').length > 0;
  if (albumHasBinding) {
    const sel = await selectSunoPromptForAlbum(channelId, albumId, db);
    for (const t of tracks) {
      tracksRepo.patch(
        t.id,
        { sunoPromptId: sel.promptId, sunoPromptResolvedText: sel.content },
        db,
      );
    }
    return tracks.map(() => sel);
  }

  // Fresh album with no binding yet. Apply rotation if we have active prompts.
  if (active.length > 0) {
    const sorted = [...active].sort((a, b) => a.id.localeCompare(b.id));
    const result: SelectedSunoPrompt[] = [];
    for (let i = 0; i < tracks.length; i++) {
      const picked = sorted[i % sorted.length];
      tracksRepo.patch(
        tracks[i].id,
        { sunoPromptId: picked.id, sunoPromptResolvedText: picked.content },
        db,
      );
      result.push({
        promptId: picked.id,
        content: picked.content,
        source: 'channel-prompts',
      });
    }
    // Album-level "primary" = track 1's pick. Lets cover/audit queries keep
    // working without knowing about per-track rotation.
    albumsRepo.patch(
      albumId,
      {
        sunoPromptId: result[0].promptId,
        sunoPromptResolvedText: result[0].content,
        sunoStylePrompt: result[0].content,
      },
      db,
    );
    return result;
  }

  // No active prompts — delegate to the album-level fallback (legacy column
  // / hard-fail). Same prompt for every track, persisted per-track for audit.
  const sel = await selectSunoPromptForAlbum(channelId, albumId, db);
  for (const t of tracks) {
    tracksRepo.patch(
      t.id,
      { sunoPromptId: sel.promptId, sunoPromptResolvedText: sel.content },
      db,
    );
  }
  return tracks.map(() => sel);
}

function resumePerTrack(
  album: Album,
  tracks: Track[],
  active: ChannelSunoPrompt[],
  db: Db,
): SelectedSunoPrompt[] {
  const sorted = [...active].sort((a, b) => a.id.localeCompare(b.id));
  const result: SelectedSunoPrompt[] = [];
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    // 1. Stored FK — re-fetch content, fall back to snapshot if deleted.
    if (t.sunoPromptId) {
      const existing = sunoPromptsRepo.get(t.sunoPromptId, db);
      if (existing) {
        result.push({ promptId: existing.id, content: existing.content, source: 'resumed' });
        continue;
      }
      // Prompt deleted — use stored snapshot.
      if ((t.sunoPromptResolvedText ?? '').length > 0) {
        result.push({
          promptId: null,
          content: t.sunoPromptResolvedText!,
          source: 'resumed',
        });
        continue;
      }
    }
    // 2. Snapshot only (no FK) — use it.
    if ((t.sunoPromptResolvedText ?? '').length > 0) {
      result.push({
        promptId: null,
        content: t.sunoPromptResolvedText!,
        source: 'resumed',
      });
      continue;
    }
    // 3. Gap — fill from rotation if active prompts exist, else fall back to
    //    album-level snapshot/style.
    if (sorted.length > 0) {
      const picked = sorted[i % sorted.length];
      tracksRepo.patch(
        t.id,
        { sunoPromptId: picked.id, sunoPromptResolvedText: picked.content },
        db,
      );
      result.push({
        promptId: picked.id,
        content: picked.content,
        source: 'channel-prompts',
      });
      continue;
    }
    const fallback =
      album.sunoPromptResolvedText ?? album.sunoStylePrompt ?? '';
    if (fallback.length > 0) {
      tracksRepo.patch(t.id, { sunoPromptResolvedText: fallback }, db);
      result.push({ promptId: null, content: fallback, source: 'resumed' });
      continue;
    }
    // Should never happen — preflight catches "0 active + no legacy".
    throw new SunoStylePromptRequiredError(album.channelId, album.id);
  }
  return result;
}
