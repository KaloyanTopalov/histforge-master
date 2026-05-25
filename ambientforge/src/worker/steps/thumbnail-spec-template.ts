/**
 * Thumbnail-spec prompt template resolution. Mirrors step 01b's
 * `loadSceneTemplate` (a hardcoded-kind file loader that intentionally bypasses
 * `resolveChannelPrompt` because the thumbnail spec is NOT one of the five
 * `PromptKind`s). Resolution order, first match wins:
 *
 *   1. prompts/channel-templates/<channelId>/thumbnail-spec.md  (per-channel)
 *   2. prompts/defaults/thumbnail-spec.md                       (workflow default)
 *
 * The loaded template is rendered with the album's scene title and fed to
 * `chatCompletionText` (with the album cover attached as a vision image) to
 * produce the Magnific thumbnail prompt.
 */

import fs from 'node:fs';
import path from 'node:path';

export type ThumbnailSpecTemplateSource = 'channel-file' | 'workflow-default';

export type LoadedThumbnailSpecTemplate = {
  content: string;
  source: ThumbnailSpecTemplateSource;
  origin: string;
};

/** Distinct, operator-actionable error. Unlike step 01b (which throws an
 * OpenRouterError for a missing scene template — a smell from a file loader),
 * this carries its own `.code` so callers/tests stay class-agnostic. */
export class ThumbnailSpecTemplateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ThumbnailSpecTemplateError';
    this.code = code;
  }
}

const THUMBNAIL_SPEC_TEMPLATE_KIND = 'thumbnail-spec';

export function loadThumbnailSpecTemplate(
  channelId: string,
  promptsRoot: string,
): LoadedThumbnailSpecTemplate {
  const channelFile = path.join(
    promptsRoot,
    'channel-templates',
    channelId,
    `${THUMBNAIL_SPEC_TEMPLATE_KIND}.md`,
  );
  if (fs.existsSync(channelFile)) {
    return {
      content: fs.readFileSync(channelFile, 'utf8'),
      source: 'channel-file',
      origin: relativeToCwd(channelFile),
    };
  }

  const defaultFile = path.join(
    promptsRoot,
    'defaults',
    `${THUMBNAIL_SPEC_TEMPLATE_KIND}.md`,
  );
  if (!fs.existsSync(defaultFile)) {
    throw new ThumbnailSpecTemplateError(
      'THUMBNAIL_SPEC_TEMPLATE_MISSING',
      `expected thumbnail-spec template at ${defaultFile}`,
    );
  }
  return {
    content: fs.readFileSync(defaultFile, 'utf8'),
    source: 'workflow-default',
    origin: relativeToCwd(defaultFile),
  };
}

/** Interpolate the video title into the loaded template. Replaces every
 * `{{TITLE}}` token. Split/join (not String.replace) so a title containing
 * `$` can't be mangled by replacement-pattern semantics. */
export function renderThumbnailSpec(template: string, title: string): string {
  return template.split('{{TITLE}}').join(title);
}

function relativeToCwd(p: string): string {
  const rel = path.relative(process.cwd(), p);
  return rel.startsWith('..') ? p : rel;
}
