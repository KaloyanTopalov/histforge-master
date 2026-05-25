import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorJson } from '@/lib/api/errors';
import {
  extractMockResponse,
  renderTemplate,
  stripMockDirective,
  type PromptKind,
} from '@/lib/prompts';
import {
  chatCompletionJSON,
  OpenRouterError,
} from '@/lib/llm/openrouter';
import { getOpenRouterApiKey } from '@/lib/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROMPT_KINDS = [
  'album-brief',
  'track-briefs',
  'cover-image',
  'thumbnail',
  'yt-metadata',
] as const;

const PreviewBodySchema = z.object({
  kind: z.enum(PROMPT_KINDS),
  /** The prompt template content (as the operator typed it in the form). */
  prompt: z.string().min(1),
  /** Optional partial Channel-shaped object used for variable interpolation
   *  inside the rendered prompt. Operator typically passes the form's current
   *  state without saving so they can iterate. */
  channelDraft: z.record(z.unknown()).default({}),
  /** Optional partial Album shape (test album). Defaults to a stub. */
  albumDraft: z.record(z.unknown()).default({}),
});

/** Minimal Zod schemas for each prompt kind's expected JSON output.
 *  These are RELAXED versions of the production schemas — they let the
 *  operator preview a prompt that doesn't yet return all fields. */
const albumBriefPreview = z.object({
  albumTitle: z.string().min(1),
  sunoStylePrompt: z.string().min(1),
  primaryGenre: z.string().min(1),
});
const trackBriefsPreview = z.object({
  tracks: z
    .array(
      z.object({
        trackNumber: z.number().int().min(1),
        title: z.string().min(1),
        lyrics: z.string().nullable(),
      }),
    )
    .min(1),
});
const coverImagePreview = z.object({
  imagePrompt: z.string().min(1),
});
const thumbnailPreview = z.union([
  z.object({ useCover: z.literal(true) }),
  z.object({ useCover: z.literal(false), imagePrompt: z.string().min(1) }),
]);
const ytMetadataPreview = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1),
});

function schemaForKind(kind: PromptKind): z.ZodTypeAny {
  switch (kind) {
    case 'album-brief':
      return albumBriefPreview;
    case 'track-briefs':
      return trackBriefsPreview;
    case 'cover-image':
      return coverImagePreview;
    case 'thumbnail':
      return thumbnailPreview;
    case 'yt-metadata':
      return ytMetadataPreview;
  }
}

const SAMPLE_ALBUM_DEFAULTS = {
  id: 'preview-album-id',
  albumTitle: 'Preview Album',
  sunoStylePrompt: 'preview style prompt',
  primaryGenre: 'Ambient',
  artistName: 'Preview Artist',
  themePrompt: '',
};

const SAMPLE_CHANNEL_DEFAULTS = {
  id: 'preview-channel-id',
  name: 'preview',
  displayName: 'Preview Channel',
  description: 'A preview channel used to test prompt templates.',
  distrokidArtistName: 'Preview Artist',
  distrokidPrimaryGenre: 'Ambient',
  hashtags: 'ambient,preview',
  workflow: 'ambient',
};

const SAMPLE_TRACKLIST = '0:00 - Track One\n3:00 - Track Two\n6:00 - Track Three';

/**
 * POST /api/channels/preview-prompt
 *
 * Body: { kind, prompt, channelDraft?, albumDraft? }
 * Returns: {
 *   renderedPrompt: string,           // after var interpolation, mock directive stripped
 *   mode: 'mock' | 'live',            // which path was taken
 *   mockResponse: unknown | null,     // parsed mock-response if any
 *   llmResponse: unknown | null,      // parsed live-LLM response if mode='live'
 *   parsedOk: boolean,                // did the response satisfy the kind's preview schema
 *   validationErrors: string[]        // Zod issues (humanized)
 * }
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJson('INVALID_JSON', 'Body is not valid JSON', 400);
  }
  const parsed = PreviewBodySchema.safeParse(body);
  if (!parsed.success) {
    return errorJson('INVALID_BODY', 'Validation failed', 400, parsed.error.flatten());
  }
  const { kind, prompt, channelDraft, albumDraft } = parsed.data;

  const channel = { ...SAMPLE_CHANNEL_DEFAULTS, ...channelDraft };
  const album = { ...SAMPLE_ALBUM_DEFAULTS, ...albumDraft };

  const rendered = renderTemplate(prompt, {
    channel,
    album,
    themePrompt: (albumDraft as { themePrompt?: string }).themePrompt ?? '',
    tracksPerAlbum: (albumDraft as { tracksPerAlbum?: number }).tracksPerAlbum ?? 30,
    tracklist: SAMPLE_TRACKLIST,
    tracklistEscaped: SAMPLE_TRACKLIST,
    spotifyLine: '',
    hashtagsLine: '#ambient #preview',
  });

  const apiKey = getOpenRouterApiKey();
  const isMock = apiKey === 'mock';

  let mockResponse: unknown | null = null;
  try {
    mockResponse = extractMockResponse(rendered);
  } catch (err) {
    return NextResponse.json({
      renderedPrompt: stripMockDirective(rendered),
      mode: isMock ? 'mock' : 'live',
      mockResponse: null,
      llmResponse: null,
      parsedOk: false,
      validationErrors: [
        `mock-response directive is present but not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      ],
    });
  }

  const schema = schemaForKind(kind as PromptKind);

  if (isMock) {
    if (mockResponse === null) {
      return NextResponse.json({
        renderedPrompt: stripMockDirective(rendered),
        mode: 'mock',
        mockResponse: null,
        llmResponse: null,
        parsedOk: false,
        validationErrors: [
          'apiKey=mock but the prompt has no <!-- mock-response: ... --> directive',
        ],
      });
    }
    const r = schema.safeParse(mockResponse);
    return NextResponse.json({
      renderedPrompt: stripMockDirective(rendered),
      mode: 'mock',
      mockResponse,
      llmResponse: null,
      parsedOk: r.success,
      validationErrors: r.success ? [] : zodIssues(r.error),
    });
  }

  // Live path: call OpenRouter with the rendered prompt (mock directive
  // stripped). Operator opted into a live preview by configuring a real key.
  try {
    const llmResponse = await chatCompletionJSON({
      rendered,
      schema,
    });
    return NextResponse.json({
      renderedPrompt: stripMockDirective(rendered),
      mode: 'live',
      mockResponse,
      llmResponse,
      parsedOk: true,
      validationErrors: [],
    });
  } catch (err) {
    if (err instanceof OpenRouterError) {
      return NextResponse.json({
        renderedPrompt: stripMockDirective(rendered),
        mode: 'live',
        mockResponse,
        llmResponse: null,
        parsedOk: false,
        validationErrors: [`${err.code}: ${err.message}`],
      });
    }
    return NextResponse.json({
      renderedPrompt: stripMockDirective(rendered),
      mode: 'live',
      mockResponse,
      llmResponse: null,
      parsedOk: false,
      validationErrors: [err instanceof Error ? err.message : String(err)],
    });
  }
}

function zodIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
}
