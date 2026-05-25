import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  create as createChannel,
  list as listChannels,
  getByName,
  RAP_CLIP_STRATEGIES,
  SUNO_MODES,
  WORKFLOWS,
  YOUTUBE_IMAGE_ASPECTS,
} from '@/lib/repos/channels';
import { replaceAllForChannel as replaceSunoPrompts } from '@/lib/repos/channel-suno-prompts';
import { errorJson } from '@/lib/api/errors';
import { cronSchema } from '@/lib/cron';
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

const ChannelCreateSchema = z.object({
  name: z.string().min(1).max(64),
  displayName: z.string().min(1).max(128),
  description: z.string().default(''),
  active: z.boolean().default(true),
  scheduleCron: cronSchema,
  albumBriefTemplate: z.string().nullable().default(null),
  trackBriefsTemplate: z.string().nullable().default(null),
  coverPromptTemplate: z.string().nullable().default(null),
  thumbnailPromptTemplate: z.string().nullable().default(null),
  ytMetadataTemplate: z.string().nullable().default(null),
  distrokidArtistName: z.string().min(1),
  distrokidPrimaryGenre: z.string().min(1),
  distrokidLabelName: z.string().nullable().default(null),
  youtubeChannelHandle: z
    .string()
    .regex(/^@[\w.-]+$/, { message: 'YouTube handle must start with @ and contain only word chars/.-' })
    .nullable()
    .default(null),
  thumbnailOverlayText: z.string().nullable().default(null),
  spotifyPlaylistUrl: z.string().url().nullable().default(null),
  hashtags: z.string().default(''),
  sunoModel: z.string().min(1).default('chirp-fenix'),
  sunoMode: z.enum(SUNO_MODES as unknown as [string, ...string[]]).default('custom'),
  sunoInstrumental: z.boolean().default(false),
  sunoPersonaId: z.string().nullable().default(null),
  // v5 additions: workflow + per-channel pipeline + prompts + DK overrides.
  workflow: z.enum(WORKFLOWS as unknown as [string, ...string[]]).default('ambient'),
  tracksPerAlbum: z.number().int().min(1).max(50).nullable().default(null),
  targetVideoSeconds: z.number().int().min(60).nullable().default(null),
  brollFolderPath: z.string().nullable().default(null),
  sunoStylePrompt: z.string().nullable().default(null),
  promptAlbumBrief: z.string().nullable().default(null),
  promptTrackBriefs: z.string().nullable().default(null),
  promptCoverImage: z.string().nullable().default(null),
  promptThumbnail: z.string().nullable().default(null),
  promptYtMetadata: z.string().nullable().default(null),
  youtubeImageAspect: z.enum(YOUTUBE_IMAGE_ASPECTS as unknown as [string, ...string[]]).nullable().default(null),
  distrokidSongwriterName: z.string().nullable().default(null),
  distrokidPerformerName: z.string().nullable().default(null),
  distrokidPerformerRole: z.string().nullable().default(null),
  distrokidProducerName: z.string().nullable().default(null),
  distrokidProducerRole: z.string().nullable().default(null),
  rapClipStrategy: z.enum(RAP_CLIP_STRATEGIES as unknown as [string, ...string[]]).nullable().default(null),
  // v9 (ambient-video): JSON-string array of scene themes the scene-generator
  // step 01b picks from per album. Shape is enforced cross-field below (it
  // depends on `workflow`).
  sceneThemes: z.string().nullable().default(null),
  // v9 (ambient-video): channel-level fallback motion prompt for the Seedance
  // step 08, used when album.scene_seedance_prompt is empty.
  seedanceMotionPrompt: z.string().nullable().default(null),
  // v10 (ambient-video): name of a saved Magnific style applied via the
  // freepik-runner's My Styles picker. Optional; null = no style.
  imageStyleName: z.string().nullable().default(null),
  // v7: per-channel collection of suno style prompts. When present, this
  // replaces (rebuilds) the channel's prompt collection. Legacy sunoStylePrompt
  // field is honored separately for backward compatibility.
  sunoStylePrompts: z.array(SunoStylePromptInput).optional(),
});

/**
 * Cross-field validation: when workflow is ambient-video and sceneThemes is
 * non-null, the value must parse as a non-empty `string[]`. Returns null on
 * success; a 400-style `{ code, message }` object on failure. Pulled out of
 * Zod because workflow lives on the same object and `.refine` on a single
 * field can't see other fields.
 */
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

export async function GET() {
  const channels = listChannels();
  const counts = channels.reduce(
    (acc, c) => {
      if (c.active) acc.active++;
      else acc.inactive++;
      return acc;
    },
    { active: 0, inactive: 0 },
  );
  return NextResponse.json({ channels, counts });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJson('INVALID_JSON', 'Body is not valid JSON', 400);
  }
  const parsed = ChannelCreateSchema.safeParse(body);
  if (!parsed.success) {
    // Only surface INVALID_CRON when the cron refinement actually failed (value present but invalid).
    const cronRefinement = parsed.error.issues.find(
      (i) => i.path.length === 1 && i.path[0] === 'scheduleCron' && i.code === 'custom',
    );
    if (cronRefinement) {
      return errorJson('INVALID_CRON', cronRefinement.message, 400);
    }
    return errorJson('INVALID_BODY', 'Validation failed', 400, parsed.error.flatten());
  }
  if (getByName(parsed.data.name)) {
    return errorJson(
      'CHANNEL_NAME_TAKEN',
      `Channel "${parsed.data.name}" already exists`,
      409,
    );
  }
  // Cross-field validation: ambient-video sceneThemes shape (when set).
  const sceneCheck = validateSceneThemes(parsed.data.workflow, parsed.data.sceneThemes);
  if (sceneCheck) {
    return errorJson(sceneCheck.code, sceneCheck.message, 400);
  }
  // Workflow-specific cross-field validation. rap-compilation requires a
  // brollFolderPath that points to a real folder with ≥10 video clips.
  if (parsed.data.workflow === 'rap-compilation') {
    if (!parsed.data.brollFolderPath || parsed.data.brollFolderPath.trim().length === 0) {
      return errorJson(
        'BROLL_FOLDER_REQUIRED',
        'workflow=rap-compilation requires brollFolderPath',
        400,
      );
    }
    // C5: enforce allowlist before probing the filesystem.
    const allowedRoots = readAllowedBrollRoots();
    const allowed = assertBrollPathAllowed(parsed.data.brollFolderPath, allowedRoots);
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
  // Backward compat warn-log: if the operator submits the legacy
  // sunoStylePrompt field, the new collection model is preferred.
  if (
    parsed.data.sunoStylePrompt &&
    parsed.data.sunoStylePrompt.length > 0 &&
    !parsed.data.sunoStylePrompts
  ) {
    console.warn(
      'channel API received legacy sunoStylePrompt — consider migrating to sunoStylePrompts array',
    );
  }
  // Strip the prompts collection out before passing to createChannel — the
  // collection lives in a separate table.
  const { sunoStylePrompts, ...channelInput } = parsed.data;
  // YouTube handle -> UC ID resolution lands in a future session. Persist null for now.
  const channel = createChannel({
    ...channelInput,
    sunoMode: channelInput.sunoMode as (typeof SUNO_MODES)[number],
    workflow: channelInput.workflow as (typeof WORKFLOWS)[number],
    youtubeImageAspect: channelInput.youtubeImageAspect as
      | (typeof YOUTUBE_IMAGE_ASPECTS)[number]
      | null,
    rapClipStrategy: channelInput.rapClipStrategy as
      | (typeof RAP_CLIP_STRATEGIES)[number]
      | null,
    youtubeChannelId: null,
  });
  if (sunoStylePrompts && sunoStylePrompts.length > 0) {
    replaceSunoPrompts(channel.id, sunoStylePrompts);
  }
  return NextResponse.json({ channel });
}
