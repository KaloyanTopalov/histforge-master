import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import * as albumsRepo from '@/lib/repos/albums';
import * as channelsRepo from '@/lib/repos/channels';
import { renderTemplate, resolveChannelPrompt } from '@/lib/prompts';
import { chatCompletionJSON, OpenRouterError } from '@/lib/llm/openrouter';
import { generateTracklist } from '@/lib/audio/tracklist';
import type { PipelineStep } from '../pipeline';

const YtMetadataSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1),
});

const TAGS_TOTAL_MAX = 500;

export type Step10Opts = {
  projectsDir?: string;
};

export const step10YoutubeMetadata: PipelineStep = async (album, log) =>
  step10Internal(album, log, {});

export async function step10Internal(
  album: albumsRepo.Album,
  log: (stage: string, msg: string) => void,
  opts: Step10Opts = {},
): Promise<void> {
  log('step 10', 'start');
  const projectsDir = opts.projectsDir ?? path.join(process.cwd(), 'projects');

  const fresh = albumsRepo.get(album.id) ?? album;
  const channel = channelsRepo.get(fresh.channelId);
  if (!channel) {
    throw new OpenRouterError(
      'CHANNEL_NOT_FOUND',
      `channel ${fresh.channelId} not found for album ${album.id}`,
      false,
    );
  }

  const albumDir = path.join(projectsDir, fresh.channelId, fresh.id);
  const tracklistPath = path.join(albumDir, 'tracklist.txt');
  const titlePath = path.join(albumDir, 'title.txt');
  const descriptionPath = path.join(albumDir, 'description.txt');
  const tagsPath = path.join(albumDir, 'tags.txt');

  // Idempotency: all four artifacts exist on disk AND DB has yt_* fields populated.
  if (
    fresh.ytTitle !== null &&
    fresh.ytDescription !== null &&
    fresh.ytTags !== null &&
    fileNonEmpty(tracklistPath) &&
    fileNonEmpty(titlePath) &&
    fileNonEmpty(descriptionPath) &&
    fileNonEmpty(tagsPath)
  ) {
    log('step 10', 'noop (yt metadata already generated)');
    return;
  }

  await fs.promises.mkdir(albumDir, { recursive: true });

  const tracklist = await generateTracklist(fresh.id, { projectsDir });
  log('step 10', `tracklist entries=${tracklist.entries.length} chars=${tracklist.text.length}`);

  const resolved = resolveChannelPrompt(channel, 'yt-metadata');
  log(
    'step 10',
    `prompt loaded source=${resolved.source} kind=${resolved.kind} origin=${resolved.origin}`,
  );

  const tracklistEscaped = jsonStringContent(tracklist.text);
  const hashtagsLine = csvToHashtags(channel.hashtags);
  const spotifyLine = channel.spotifyPlaylistUrl
    ? `${channel.spotifyPlaylistUrl}\n\n`
    : '';
  const spotifyLineEscaped = jsonStringContent(spotifyLine);
  const hashtagsLineEscaped = jsonStringContent(hashtagsLine);

  const renderedBase = renderTemplate(resolved.content, {
    album: fresh,
    channel,
    tracklist: tracklist.text,
    tracklistEscaped,
    spotifyLine: spotifyLineEscaped,
    hashtagsLine: hashtagsLineEscaped,
  });

  let result: z.infer<typeof YtMetadataSchema> | null = null;
  let lastError: unknown = undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const reminder =
      attempt === 0
        ? ''
        : '\n\nIMPORTANT: Your previous description did not contain the tracklist verbatim. Paste the tracklist EXACTLY as supplied above into the description.';
    const rendered = renderedBase + reminder;
    const candidate = await chatCompletionJSON({ rendered, schema: YtMetadataSchema });
    if (!candidate.description.includes(tracklist.text)) {
      lastError = new OpenRouterError(
        'YT_METADATA_MISSING_TRACKLIST',
        'description does not contain the tracklist verbatim',
        false,
      );
      log('step 10', `attempt ${attempt + 1} description missing tracklist, retrying`);
      continue;
    }
    result = candidate;
    break;
  }
  if (!result) {
    if (lastError instanceof Error) throw lastError;
    throw new OpenRouterError(
      'YT_METADATA_MISSING_TRACKLIST',
      'description does not contain the tracklist verbatim after retry',
      false,
    );
  }

  // ambient-video: when step 01b produced a scene_title (Gates-formula
  // "The Knight's Quiet Fire | Medieval Fantasy Music for Peaceful Focus"),
  // it overrides whatever the yt-metadata LLM chose. The LLM-generated
  // description + tags stand as-is — only the title gets the scene treatment.
  // This is the single permitted workflow conditional in step code (see
  // domain-workflows.md anti-patterns); the alternative (a workflow-supplied
  // titleResolver) would be over-engineering for one override.
  if (fresh.workflow === 'ambient-video') {
    const sceneTitle = (fresh.sceneTitle ?? '').trim();
    if (sceneTitle.length > 0) {
      log('step 10', `ambient-video title override: "${sceneTitle}" (was "${result.title}")`);
      result.title = sceneTitle;
    }
  }

  const trimmedTags = trimTagsToLimit(result.tags, TAGS_TOTAL_MAX);
  const tagsCsv = trimmedTags.join(',');

  await fs.promises.writeFile(titlePath, result.title, 'utf8');
  await fs.promises.writeFile(descriptionPath, result.description, 'utf8');
  await fs.promises.writeFile(tagsPath, tagsCsv, 'utf8');

  albumsRepo.patch(fresh.id, {
    tracklistText: tracklist.text,
    ytTitle: result.title,
    ytDescription: result.description,
    ytTags: tagsCsv,
  });

  log(
    'step 10',
    `done title="${result.title}" descChars=${result.description.length} tags=${trimmedTags.length} tagChars=${tagsCsv.length}`,
  );
}

function fileNonEmpty(p: string): boolean {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

/** Returns content of a JSON string literal *without* the surrounding quotes — safe to splice into mock-response JSON. */
function jsonStringContent(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

function csvToHashtags(csv: string): string {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => `#${s.replace(/^#/, '')}`)
    .join(' ');
}

/**
 * Trim tags from the end until the comma-joined total length is within `max`.
 * Always keeps at least one tag (the first), even if it alone exceeds the cap —
 * that's an upstream LLM bug worth surfacing rather than silently emitting "".
 */
export function trimTagsToLimit(tags: string[], max: number): string[] {
  const out = [...tags];
  while (out.length > 1 && out.join(',').length > max) {
    out.pop();
  }
  return out;
}
