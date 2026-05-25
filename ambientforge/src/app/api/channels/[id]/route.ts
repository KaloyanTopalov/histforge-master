import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  get as getChannel,
  patch as patchChannel,
  RAP_CLIP_STRATEGIES,
  SUNO_MODES,
  WORKFLOWS,
  YOUTUBE_IMAGE_ASPECTS,
} from '@/lib/repos/channels';
import { listByChannel } from '@/lib/repos/albums';
import { replaceAllForChannel as replaceSunoPrompts } from '@/lib/repos/channel-suno-prompts';
import { errorJson } from '@/lib/api/errors';
import { isValidCron } from '@/lib/cron';
import {
  assertBrollPathAllowed,
  preflightBrollFolder,
  readAllowedBrollRoots,
} from '@/lib/broll/preflight';

const SunoStylePromptInput = z.object({
  id: z.string().optional(),
  label: z.string().min(1).max(100),
  content: z.string().min(1),
  weight: z.number().positive().default(1.0),
  active: z.boolean().default(true),
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ChannelPatchSchema = z
  .object({
    name: z.string().min(1).max(64),
    displayName: z.string().min(1).max(128),
    description: z.string(),
    active: z.boolean(),
    scheduleCron: z.string(),
    albumBriefTemplate: z.string().nullable(),
    trackBriefsTemplate: z.string().nullable(),
    coverPromptTemplate: z.string().nullable(),
    thumbnailPromptTemplate: z.string().nullable(),
    ytMetadataTemplate: z.string().nullable(),
    distrokidArtistName: z.string().min(1),
    distrokidPrimaryGenre: z.string().min(1),
    distrokidLabelName: z.string().nullable(),
    youtubeChannelHandle: z
      .string()
      .regex(/^@[\w.-]+$/, {
        message: 'YouTube handle must start with @ and contain only word chars/.-',
      })
      .nullable(),
    thumbnailOverlayText: z.string().nullable(),
    spotifyPlaylistUrl: z.string().url().nullable(),
    hashtags: z.string(),
    sunoModel: z.string().min(1),
    sunoMode: z.enum(SUNO_MODES as unknown as [string, ...string[]]),
    sunoInstrumental: z.boolean(),
    sunoPersonaId: z.string().nullable(),
    workflow: z.enum(WORKFLOWS as unknown as [string, ...string[]]),
    tracksPerAlbum: z.number().int().min(1).max(50).nullable(),
    targetVideoSeconds: z.number().int().min(60).nullable(),
    brollFolderPath: z.string().nullable(),
    sunoStylePrompt: z.string().nullable(),
    promptAlbumBrief: z.string().nullable(),
    promptTrackBriefs: z.string().nullable(),
    promptCoverImage: z.string().nullable(),
    promptThumbnail: z.string().nullable(),
    promptYtMetadata: z.string().nullable(),
    youtubeImageAspect: z
      .enum(YOUTUBE_IMAGE_ASPECTS as unknown as [string, ...string[]])
      .nullable(),
    distrokidSongwriterName: z.string().nullable(),
    distrokidPerformerName: z.string().nullable(),
    distrokidPerformerRole: z.string().nullable(),
    distrokidProducerName: z.string().nullable(),
    distrokidProducerRole: z.string().nullable(),
    rapClipStrategy: z
      .enum(RAP_CLIP_STRATEGIES as unknown as [string, ...string[]])
      .nullable(),
    // v9 (ambient-video): JSON-string scene themes + channel-level Seedance
    // motion prompt fallback. Cross-field shape validation below; PATCH
    // accepts undefined (unchanged) or null (clear) or string.
    sceneThemes: z.string().nullable(),
    seedanceMotionPrompt: z.string().nullable(),
    // v10 (ambient-video): Magnific saved-style name (e.g. "medievel").
    imageStyleName: z.string().nullable(),
    // v7: per-channel collection of suno style prompts. When present on PATCH,
    // the existing collection is replaced (rebuilt) by this array. Items with
    // an `id` field are PATCHED; items without are INSERTED; existing rows
    // whose id is absent from the input are DELETED (album FKs cascade NULL).
    sunoStylePrompts: z.array(SunoStylePromptInput),
  })
  .partial();

function validateSceneThemes(
  workflow: string,
  sceneThemes: string | null,
): { code: string; message: string } | null {
  if (workflow !== 'ambient-video') return null;
  if (sceneThemes == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(sceneThemes);
  } catch (err) {
    return {
      code: 'SCENE_THEMES_INVALID',
      message: `sceneThemes is not valid JSON: ${(err as Error).message}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      code: 'SCENE_THEMES_INVALID',
      message: `sceneThemes must be a JSON array, got ${typeof parsed}`,
    };
  }
  if (parsed.length === 0) {
    return {
      code: 'SCENE_THEMES_INVALID',
      message: 'sceneThemes is an empty array — set null to use the default theme, or add ≥1 theme',
    };
  }
  const bad = parsed.findIndex((x) => typeof x !== 'string' || x.trim().length === 0);
  if (bad !== -1) {
    return {
      code: 'SCENE_THEMES_INVALID',
      message: `sceneThemes[${bad}] is not a non-empty string`,
    };
  }
  return null;
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const channel = getChannel(params.id);
  if (!channel) return errorJson('CHANNEL_NOT_FOUND', 'Channel not found', 404);
  const albums = listByChannel(channel.id, 50);
  return NextResponse.json({ channel, albums, nextScheduledAt: null });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const channel = getChannel(params.id);
  if (!channel) return errorJson('CHANNEL_NOT_FOUND', 'Channel not found', 404);

  const albums = listByChannel(channel.id, 50);
  if (albums.some((a) => a.status === 'in_progress')) {
    return errorJson(
      'CHANNEL_LOCKED_DURING_RUN',
      'Cannot edit channel while one of its albums is in_progress',
      409,
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJson('INVALID_JSON', 'Body is not valid JSON', 400);
  }
  const parsed = ChannelPatchSchema.safeParse(body);
  if (!parsed.success) {
    return errorJson('INVALID_BODY', 'Validation failed', 400, parsed.error.flatten());
  }
  if (parsed.data.scheduleCron !== undefined && !isValidCron(parsed.data.scheduleCron)) {
    return errorJson('INVALID_CRON', 'Invalid cron expression (5-field standard)', 400);
  }

  // Cross-field workflow validation: when the merged workflow ends up as
  // rap-compilation, brollFolderPath must point at a valid folder.
  const effectiveWorkflow = parsed.data.workflow ?? channel.workflow;
  const effectiveBrollPath =
    parsed.data.brollFolderPath !== undefined
      ? parsed.data.brollFolderPath
      : channel.brollFolderPath;
  const effectiveSceneThemes =
    parsed.data.sceneThemes !== undefined ? parsed.data.sceneThemes : channel.sceneThemes;
  const sceneCheck = validateSceneThemes(effectiveWorkflow, effectiveSceneThemes);
  if (sceneCheck) {
    return errorJson(sceneCheck.code, sceneCheck.message, 400);
  }
  if (effectiveWorkflow === 'rap-compilation') {
    if (!effectiveBrollPath || effectiveBrollPath.trim().length === 0) {
      return errorJson(
        'BROLL_FOLDER_REQUIRED',
        'workflow=rap-compilation requires brollFolderPath',
        400,
      );
    }
    // C5: enforce allowlist before probing the filesystem.
    const allowedRoots = readAllowedBrollRoots();
    const allowed = assertBrollPathAllowed(effectiveBrollPath, allowedRoots);
    if (!allowed.ok) {
      const status = allowed.code === 'PATH_NOT_FOUND' ? 400 : 403;
      return errorJson(allowed.code, allowed.reason, status, { allowedRoots });
    }
    const preflight = await preflightBrollFolder(allowed.resolvedPath);
    if (!preflight.ok) {
      return errorJson(
        'BROLL_FOLDER_INVALID',
        `brollFolderPath failed preflight: ${preflight.reasons.join('; ')}`,
        400,
        preflight,
      );
    }
  }

  // Backward compat warn-log for legacy single-string field.
  if (
    parsed.data.sunoStylePrompt &&
    parsed.data.sunoStylePrompt.length > 0 &&
    parsed.data.sunoStylePrompts === undefined
  ) {
    console.warn(
      'channel API received legacy sunoStylePrompt — consider migrating to sunoStylePrompts array',
    );
  }

  const { sunoStylePrompts, ...channelPatch } = parsed.data;
  const updated = patchChannel(channel.id, channelPatch as Parameters<typeof patchChannel>[1]);
  if (sunoStylePrompts !== undefined) {
    replaceSunoPrompts(channel.id, sunoStylePrompts);
  }
  return NextResponse.json({ channel: updated });
}
