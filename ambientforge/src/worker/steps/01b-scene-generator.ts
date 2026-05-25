import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import * as albumsRepo from '@/lib/repos/albums';
import * as channelsRepo from '@/lib/repos/channels';
import { chatCompletionJSON, OpenRouterError } from '@/lib/llm/openrouter';
import type { Album } from '@/lib/repos/albums';
import type { LogFn } from '../pipelineLog';
import type { PipelineStep } from '../pipeline';

const SceneSchema = z.object({
  scene: z.string().min(1),
  imagePrompt: z.string().min(1),
  seedancePrompt: z.string().min(1),
  title: z.string().min(1),
});

const FALLBACK_THEME = 'medieval knight in a peaceful fantasy environment';

const SCENE_TEMPLATE_KIND = 'ambient-video-scene';

export type Step01bOpts = {
  /** Project root for `projects/<channelId>/<albumId>/scene.json`. Default cwd/projects. */
  projectsDir?: string;
  /** Prompt root override for tests. Default cwd/prompts. */
  promptsRoot?: string;
  /** Random source. Default Math.random. */
  random?: () => number;
};

export const step01bSceneGenerator: PipelineStep = async (album, log) =>
  step01bInternal(album, log);

export async function step01bInternal(
  album: Album,
  log: LogFn,
  opts: Step01bOpts = {},
): Promise<void> {
  log('step 01b', 'start');

  const fresh = albumsRepo.get(album.id) ?? album;
  if (
    fresh.sceneImagePrompt &&
    fresh.sceneSeedancePrompt &&
    fresh.sceneTitle &&
    fresh.sceneImagePrompt.length > 0 &&
    fresh.sceneSeedancePrompt.length > 0 &&
    fresh.sceneTitle.length > 0
  ) {
    log('step 01b', 'noop (scene fields already populated)');
    return;
  }

  const channel = channelsRepo.get(fresh.channelId);
  if (!channel) {
    throw new OpenRouterError(
      'CHANNEL_NOT_FOUND',
      `Channel ${fresh.channelId} not found for album ${fresh.id}`,
      false,
    );
  }

  // Themes are pre-validated by the workflow's preflightChecks
  // (requireSceneThemesValidOrNull). At this point sceneThemes is either null
  // or a JSON string[] with ≥1 non-empty entry — but be defensive in case
  // someone bypasses preflight (tests, direct step invocation).
  const themes = parseThemesOrFallback(channel.sceneThemes);
  const random = opts.random ?? Math.random;
  const picked = themes[Math.floor(random() * themes.length)] ?? FALLBACK_THEME;
  log('step 01b', `theme picked="${picked}"`);

  const promptsRoot = opts.promptsRoot ?? path.join(process.cwd(), 'prompts');
  const template = loadSceneTemplate(channel.id, promptsRoot);
  log('step 01b', `prompt loaded source=${template.source} origin=${template.origin}`);

  const result = await chatCompletionJSON({
    rendered: picked,
    system: template.content,
    schema: SceneSchema,
    temperature: 0.9,
    maxTokens: 600,
    responseFormat: { type: 'json_object' },
  });

  albumsRepo.patch(fresh.id, {
    sceneImagePrompt: result.imagePrompt,
    sceneSeedancePrompt: result.seedancePrompt,
    sceneTitle: result.title,
  });

  // Prominent operator log: the Midjourney prompt is what they need to copy
  // by hand to generate source.jpg. Surround with `=`-banners so it's easy to
  // spot in pipeline.log.
  const banner = '='.repeat(60);
  console.log(banner);
  console.log('[scene] MIDJOURNEY PROMPT — copy this into Midjourney:');
  console.log(result.imagePrompt);
  console.log(banner);
  console.log('[scene] Title:', result.title);
  console.log('[scene] Seedance prompt saved to album.');

  // Persist scene.json so the operator can recover the prompt even if they
  // miss the log line.
  const projectsDir = opts.projectsDir ?? path.join(process.cwd(), 'projects');
  const albumDir = path.join(projectsDir, fresh.channelId, fresh.id);
  fs.mkdirSync(albumDir, { recursive: true });
  const scenePath = path.join(albumDir, 'scene.json');
  fs.writeFileSync(
    scenePath,
    JSON.stringify(
      {
        scene: result.scene,
        imagePrompt: result.imagePrompt,
        seedancePrompt: result.seedancePrompt,
        title: result.title,
      },
      null,
      2,
    ),
  );

  log('step 01b', `done title="${result.title}" scenePath=${scenePath}`);
}

function parseThemesOrFallback(raw: string | null): string[] {
  if (raw == null) return [FALLBACK_THEME];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [FALLBACK_THEME];
  }
  if (!Array.isArray(parsed)) return [FALLBACK_THEME];
  const themes = parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  return themes.length > 0 ? themes : [FALLBACK_THEME];
}

type LoadedSceneTemplate = {
  content: string;
  source: 'channel-file' | 'workflow-default';
  origin: string;
};

/**
 * Bypasses `resolveChannelPrompt` because the scene template isn't one of the
 * five `PromptKind`s. Honors a channel-templates override at
 * `prompts/channel-templates/<channelId>/ambient-video-scene.md`, otherwise
 * falls back to `prompts/defaults/ambient-video-scene.md`.
 */
function loadSceneTemplate(channelId: string, promptsRoot: string): LoadedSceneTemplate {
  const channelFile = path.join(
    promptsRoot,
    'channel-templates',
    channelId,
    `${SCENE_TEMPLATE_KIND}.md`,
  );
  if (fs.existsSync(channelFile)) {
    return {
      content: fs.readFileSync(channelFile, 'utf8'),
      source: 'channel-file',
      origin: relativeToCwd(channelFile),
    };
  }
  const defaultFile = path.join(promptsRoot, 'defaults', `${SCENE_TEMPLATE_KIND}.md`);
  if (!fs.existsSync(defaultFile)) {
    throw new OpenRouterError(
      'SCENE_TEMPLATE_MISSING',
      `expected scene template at ${defaultFile}`,
      false,
    );
  }
  return {
    content: fs.readFileSync(defaultFile, 'utf8'),
    source: 'workflow-default',
    origin: relativeToCwd(defaultFile),
  };
}

function relativeToCwd(p: string): string {
  const rel = path.relative(process.cwd(), p);
  return rel.startsWith('..') ? p : rel;
}
