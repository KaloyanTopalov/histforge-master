import fs from 'node:fs';
import path from 'node:path';
import type { Channel, Workflow } from './repos/channels';

export class MissingTemplateError extends Error {
  code = 'MISSING_TEMPLATE';
  constructor(name: string, channelId: string, root: string) {
    super(
      `Template "${name}" not found for channel ${channelId} in ${path.join(root, 'channel-templates', channelId)} or ${path.join(root, 'defaults')}`,
    );
    this.name = 'MissingTemplateError';
  }
}

export type LoadedTemplate = {
  content: string;
  path: string;
  source: 'override' | 'default';
};

/** Five LLM prompt kinds that participate in per-channel resolution. */
export type PromptKind =
  | 'album-brief'
  | 'track-briefs'
  | 'cover-image'
  | 'thumbnail'
  | 'yt-metadata';

/** Where the resolved prompt content came from. Logged on each step's prompt
 * load so the operator can see which fields are customized vs default. */
export type PromptSource = 'channel-db' | 'channel-file' | 'workflow-default';

export type ResolvedPrompt = {
  kind: PromptKind;
  source: PromptSource;
  content: string;
  /** Human-readable reference for logs: 'channel-db', 'prompts/.../foo.md'. */
  origin: string;
};

/** Maps PromptKind → channel column on the Channel row. */
const PROMPT_KIND_TO_CHANNEL_FIELD: Record<PromptKind, keyof Channel> = {
  'album-brief': 'promptAlbumBrief',
  'track-briefs': 'promptTrackBriefs',
  'cover-image': 'promptCoverImage',
  thumbnail: 'promptThumbnail',
  'yt-metadata': 'promptYtMetadata',
};

/**
 * Workflow-aware default-template *file basename* (NOT extension). Resolves
 * to prompts/defaults/<basename>.md. Ambient sticks with the legacy file
 * names; rap-compilation uses suffixed variants. ambient-video aliases to
 * ambient's defaults (per Phase 6 Task 6.1 decision in
 * docs/plans/2026-05-14-ambient-video-scene-generation.md — copy/title/genre
 * are still ambient). Step modules pass these names directly into
 * resolveChannelPrompt.
 */
export function defaultPromptBasename(
  kind: PromptKind,
  workflow: Workflow,
): string {
  if (workflow === 'rap-compilation') {
    if (kind === 'album-brief') return 'album-brief-rap';
    if (kind === 'track-briefs') return 'track-briefs-rap';
    if (kind === 'cover-image') return 'cover-image-rap';
    if (kind === 'thumbnail') return 'thumbnail-rap';
    if (kind === 'yt-metadata') return 'yt-metadata-rap';
  }
  // ambient + ambient-video (and any future workflow that doesn't override)
  // keep the legacy basenames: album-brief, track-briefs, cover-prompt,
  // thumbnail-prompt, yt-metadata.
  switch (kind) {
    case 'album-brief':
      return 'album-brief';
    case 'track-briefs':
      return 'track-briefs';
    case 'cover-image':
      return 'cover-prompt';
    case 'thumbnail':
      return 'thumbnail-prompt';
    case 'yt-metadata':
      return 'yt-metadata';
  }
}

function defaultRoot(): string {
  return path.join(process.cwd(), 'prompts');
}

/**
 * Load a template by name with channel-override hierarchy:
 *   1) <root>/channel-templates/<channelId>/<name>.md   (override)
 *   2) <root>/defaults/<name>.md                         (default)
 *
 * Re-reads from disk on every call (no in-memory cache) so that operator
 * edits / drops / deletes during a session take effect on the next pipeline tick.
 */
export function loadTemplate(name: string, channelId: string, root?: string): LoadedTemplate {
  const r = root ?? defaultRoot();
  const overridePath = path.join(r, 'channel-templates', channelId, `${name}.md`);
  const defaultPath = path.join(r, 'defaults', `${name}.md`);
  if (fs.existsSync(overridePath)) {
    return {
      content: fs.readFileSync(overridePath, 'utf8'),
      path: relativeToCwd(overridePath),
      source: 'override',
    };
  }
  if (fs.existsSync(defaultPath)) {
    return {
      content: fs.readFileSync(defaultPath, 'utf8'),
      path: relativeToCwd(defaultPath),
      source: 'default',
    };
  }
  throw new MissingTemplateError(name, channelId, r);
}

function relativeToCwd(p: string): string {
  const rel = path.relative(process.cwd(), p);
  // Always use forward slashes in logged paths so the value is grep-friendly across platforms.
  return rel.split(path.sep).join('/');
}

/**
 * Mustache-style interpolation. Supports {{key}} and dotted {{a.b.c}} lookup.
 * Unknown keys render as empty string so callers don't need to pre-fill every var.
 */
export function renderTemplate(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = lookup(vars, key);
    if (value === undefined || value === null) return '';
    return String(value);
  });
}

function lookup(obj: unknown, dotted: string): unknown {
  const parts = dotted.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const MOCK_DIRECTIVE_RE = /<!--\s*mock-response:\s*([\s\S]*?)\s*-->/;

/**
 * Extract the JSON payload from an embedded `<!-- mock-response: {...} -->` HTML
 * comment. Returns null if no such comment exists. Throws SyntaxError if the
 * comment exists but its body is not valid JSON.
 */
export function extractMockResponse(rendered: string): unknown | null {
  const m = rendered.match(MOCK_DIRECTIVE_RE);
  if (!m) return null;
  return JSON.parse(m[1]);
}

/**
 * Strip ALL `<!-- mock-response: ... -->` HTML comments from the rendered text.
 * Used on the real OpenRouter path so the directive never reaches the model.
 */
export function stripMockDirective(rendered: string): string {
  return rendered.replace(/<!--\s*mock-response:[\s\S]*?-->\s*/g, '');
}

/**
 * Per-channel + workflow-aware prompt resolution. Order:
 *   1. channel.prompt_<kind>            (DB content, operator-edited via dashboard)
 *   2. prompts/channel-templates/<id>/<kind>.md  (file override, power-user)
 *   3. prompts/defaults/<workflow-basename>.md   (workflow default)
 *
 * Returns the content + a label for logging. Step modules log the source so
 * operators can see which prompts are customized at a glance.
 */
export function resolveChannelPrompt(
  channel: Channel,
  kind: PromptKind,
  root?: string,
): ResolvedPrompt {
  // 1. Channel DB content wins when set.
  const dbField = PROMPT_KIND_TO_CHANNEL_FIELD[kind];
  const dbValue = channel[dbField];
  if (typeof dbValue === 'string' && dbValue.trim().length > 0) {
    return {
      kind,
      source: 'channel-db',
      content: dbValue,
      origin: 'channel-db',
    };
  }

  // 2. Channel-templates file override (legacy power-user mechanism).
  const r = root ?? defaultRoot();
  const channelFilePath = path.join(r, 'channel-templates', channel.id, `${kind}.md`);
  if (fs.existsSync(channelFilePath)) {
    return {
      kind,
      source: 'channel-file',
      content: fs.readFileSync(channelFilePath, 'utf8'),
      origin: relativeToCwd(channelFilePath),
    };
  }

  // 3. Workflow default.
  const basename = defaultPromptBasename(kind, channel.workflow);
  const defaultPath = path.join(r, 'defaults', `${basename}.md`);
  if (fs.existsSync(defaultPath)) {
    return {
      kind,
      source: 'workflow-default',
      content: fs.readFileSync(defaultPath, 'utf8'),
      origin: relativeToCwd(defaultPath),
    };
  }

  throw new MissingTemplateError(basename, channel.id, r);
}
