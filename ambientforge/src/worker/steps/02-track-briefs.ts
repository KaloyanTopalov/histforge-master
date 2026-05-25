import { z } from 'zod';
import * as albumsRepo from '@/lib/repos/albums';
import * as channelsRepo from '@/lib/repos/channels';
import * as tracksRepo from '@/lib/repos/tracks';
import { renderTemplate, resolveChannelPrompt } from '@/lib/prompts';
import { chatCompletionJSON, OpenRouterError } from '@/lib/llm/openrouter';
import { formatTrackFilename } from '@/lib/util/filename';
import { resolveTracksPerAlbum } from '@/lib/tracks-per-album';
import { getWorkflow } from '../workflows';
import type { Channel } from '@/lib/repos/channels';
import type { PipelineStep } from '../pipeline';

export const step02TrackBriefs: PipelineStep = async (album, log) => {
  log('step 02', 'start');

  const fresh = albumsRepo.get(album.id) ?? album;
  const channel = channelsRepo.get(fresh.channelId);
  if (!channel) {
    throw new OpenRouterError(
      'CHANNEL_NOT_FOUND',
      `Channel ${fresh.channelId} not found for album ${album.id}`,
      false,
    );
  }
  const workflow = getWorkflow(channel.workflow);
  const N = resolveTracksPerAlbum(channel as Channel, workflow);
  const TrackBriefSchema = z.object({
    trackNumber: z.number().int().min(1).max(N),
    title: z.string().min(1),
    lyrics: z.string().nullable(),
  });
  const TrackBriefsSchema = z.object({
    tracks: z.array(TrackBriefSchema).length(N),
  });
  const STRICT_REMINDER =
    `\n\nIMPORTANT: Return EXACTLY ${N} entries in the tracks array, no more no less, with trackNumber 1..${N} in order.`;
  if (N !== workflow.defaultTracksPerAlbum)
    log('step 02', `tracks_per_album=${N} (workflow default ${workflow.defaultTracksPerAlbum})`);

  const existing = tracksRepo.listByAlbum(album.id);
  if (existing.length === N) {
    log('step 02', `noop (already ${N} tracks)`);
    return;
  }
  if (existing.length > 0) {
    tracksRepo.deleteByAlbum(album.id);
    log('step 02', `cleared partial state (had ${existing.length}, expected ${N})`);
  }

  const resolved = resolveChannelPrompt(channel, 'track-briefs');
  log(
    'step 02',
    `prompt loaded source=${resolved.source} kind=${resolved.kind} origin=${resolved.origin}`,
  );
  const renderedBase = renderTemplate(resolved.content, {
    album: fresh,
    channel,
    tracksPerAlbum: N,
  });

  let result: z.infer<typeof TrackBriefsSchema> | null = null;
  let lastError: unknown = undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const rendered = attempt === 0 ? renderedBase : renderedBase + STRICT_REMINDER;
    try {
      result = await chatCompletionJSON({
        rendered,
        schema: TrackBriefsSchema,
        malformedRetries: 0, // count length-mismatch as our own retry, not malformed-JSON
      });
      break;
    } catch (err) {
      lastError = err;
      if (!isLikelyCountMismatch(err)) {
        // unrelated failure (auth, network, etc.) — don't retry here
        throw err;
      }
      log('step 02', `attempt ${attempt + 1} returned wrong count, retrying with stricter prompt`);
    }
  }
  if (!result) {
    throw new OpenRouterError(
      'INVALID_TRACK_COUNT',
      `OpenRouter did not return exactly ${N} tracks after retry`,
      false,
      undefined,
      lastError,
    );
  }

  const sorted = [...result.tracks].sort((a, b) => a.trackNumber - b.trackNumber);
  const inputs = sorted.map((t) => ({
    albumId: album.id,
    trackNumber: t.trackNumber,
    title: t.title,
    fileName: formatTrackFilename(t.trackNumber, t.title),
    sunoLyrics: t.lyrics ?? null,
  }));

  tracksRepo.insertMany(inputs);

  log('step 02', `done inserted=${inputs.length}`);
};

function isLikelyCountMismatch(err: unknown): boolean {
  if (err instanceof OpenRouterError) {
    if (err.code === 'OPENROUTER_MALFORMED_JSON') return true;
  }
  if (err instanceof z.ZodError) {
    return err.issues.some(
      (i) =>
        i.path.includes('tracks') &&
        (i.code === 'too_small' || i.code === 'too_big' || i.message.toLowerCase().includes('length')),
    );
  }
  return false;
}
