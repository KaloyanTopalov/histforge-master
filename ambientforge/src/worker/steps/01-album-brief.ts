import { z } from 'zod';
import * as albumsRepo from '@/lib/repos/albums';
import * as channelsRepo from '@/lib/repos/channels';
import { renderTemplate, resolveChannelPrompt } from '@/lib/prompts';
import { chatCompletionJSON, OpenRouterError } from '@/lib/llm/openrouter';
import type { PipelineStep } from '../pipeline';

const AlbumBriefSchema = z.object({
  albumTitle: z.string().min(1),
  primaryGenre: z.string().min(1),
});

export const step01AlbumBrief: PipelineStep = async (album, log) => {
  log('step 01', 'start');

  const channel = channelsRepo.get(album.channelId);
  if (!channel) {
    throw new OpenRouterError(
      'CHANNEL_NOT_FOUND',
      `Channel ${album.channelId} not found for album ${album.id}`,
      false,
    );
  }

  const fresh = albumsRepo.get(album.id) ?? album;
  if (
    fresh.albumTitle.length > 0 &&
    fresh.artistName.length > 0 &&
    fresh.primaryGenre.length > 0
  ) {
    log('step 01', 'noop (already populated)');
    return;
  }

  const resolved = resolveChannelPrompt(channel, 'album-brief');
  log(
    'step 01',
    `prompt loaded source=${resolved.source} kind=${resolved.kind} origin=${resolved.origin}`,
  );
  const rendered = renderTemplate(resolved.content, {
    channel,
    themePrompt: fresh.themePrompt ?? '',
  });

  const result = await chatCompletionJSON({
    rendered,
    schema: AlbumBriefSchema,
  });

  // sunoStylePrompt is no longer generated here; step 03 owns it via
  // selectSunoPromptForAlbum (random pick from the channel.suno_prompts
  // collection or fallback to channel.suno_style_prompt). Session 12.
  albumsRepo.patch(album.id, {
    albumTitle: result.albumTitle,
    primaryGenre: result.primaryGenre,
    artistName: channel.distrokidArtistName,
  });

  log(
    'step 01',
    `done title="${result.albumTitle}" artist="${channel.distrokidArtistName}" genre="${result.primaryGenre}"`,
  );
};
