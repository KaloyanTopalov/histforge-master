import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultPromptBasename,
  loadTemplate,
  renderTemplate,
  extractMockResponse,
  stripMockDirective,
  MissingTemplateError,
} from '@/lib/prompts';

let tmpRoot: string;
const CHANNEL_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'af-prompts-'));
  fs.mkdirSync(path.join(tmpRoot, 'defaults'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'channel-templates', CHANNEL_ID), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadTemplate', () => {
  it('prefers channel override over default', () => {
    fs.writeFileSync(path.join(tmpRoot, 'defaults', 'album-brief.md'), 'DEFAULT BODY');
    fs.writeFileSync(
      path.join(tmpRoot, 'channel-templates', CHANNEL_ID, 'album-brief.md'),
      'OVERRIDE BODY',
    );
    const loaded = loadTemplate('album-brief', CHANNEL_ID, tmpRoot);
    expect(loaded.content).toBe('OVERRIDE BODY');
    expect(loaded.source).toBe('override');
    expect(loaded.path).toContain(CHANNEL_ID);
  });

  it('falls back to default when no override exists', () => {
    fs.writeFileSync(path.join(tmpRoot, 'defaults', 'album-brief.md'), 'DEFAULT BODY');
    const loaded = loadTemplate('album-brief', CHANNEL_ID, tmpRoot);
    expect(loaded.content).toBe('DEFAULT BODY');
    expect(loaded.source).toBe('default');
    expect(loaded.path).toContain('defaults');
  });

  it('throws MissingTemplateError when neither exists', () => {
    expect(() => loadTemplate('album-brief', CHANNEL_ID, tmpRoot)).toThrow(MissingTemplateError);
  });

  it('does not cache — picks up file changes between calls', () => {
    fs.writeFileSync(path.join(tmpRoot, 'defaults', 'album-brief.md'), 'V1');
    expect(loadTemplate('album-brief', CHANNEL_ID, tmpRoot).content).toBe('V1');
    fs.writeFileSync(path.join(tmpRoot, 'defaults', 'album-brief.md'), 'V2');
    expect(loadTemplate('album-brief', CHANNEL_ID, tmpRoot).content).toBe('V2');
  });

  it('does not cache — picks up newly added override on next call', () => {
    fs.writeFileSync(path.join(tmpRoot, 'defaults', 'album-brief.md'), 'DEFAULT');
    expect(loadTemplate('album-brief', CHANNEL_ID, tmpRoot).source).toBe('default');
    fs.writeFileSync(
      path.join(tmpRoot, 'channel-templates', CHANNEL_ID, 'album-brief.md'),
      'OVERRIDE',
    );
    expect(loadTemplate('album-brief', CHANNEL_ID, tmpRoot).source).toBe('override');
  });
});

describe('renderTemplate', () => {
  it('substitutes simple {{key}}', () => {
    expect(renderTemplate('Hello {{name}}!', { name: 'World' })).toBe('Hello World!');
  });

  it('supports dotted {{a.b}} lookup', () => {
    expect(renderTemplate('Channel: {{channel.displayName}}', { channel: { displayName: 'X' } })).toBe(
      'Channel: X',
    );
  });

  it('renders missing keys as empty string', () => {
    expect(renderTemplate('A:{{a}} B:{{b.c}}', { a: 'ok' })).toBe('A:ok B:');
  });

  it('renders null/undefined values as empty string', () => {
    expect(renderTemplate('x={{x}}', { x: null })).toBe('x=');
    expect(renderTemplate('x={{x}}', { x: undefined })).toBe('x=');
  });

  it('tolerates whitespace inside braces', () => {
    expect(renderTemplate('{{  name  }}', { name: 'spaced' })).toBe('spaced');
  });
});

describe('extractMockResponse', () => {
  it('parses JSON from a mock-response comment', () => {
    const text = '<!-- mock-response: {"a":1,"b":"x"} -->\n\nrest of template';
    expect(extractMockResponse(text)).toEqual({ a: 1, b: 'x' });
  });

  it('returns null when comment missing', () => {
    expect(extractMockResponse('just text')).toBeNull();
  });

  it('handles multiline JSON inside the comment', () => {
    const text = '<!-- mock-response: {"a":\n1,\n"b":2} -->';
    expect(extractMockResponse(text)).toEqual({ a: 1, b: 2 });
  });
});

describe('stripMockDirective', () => {
  it('removes the mock-response comment', () => {
    const text = '<!-- mock-response: {"x":1} -->\n\nLLM prompt body';
    expect(stripMockDirective(text)).toBe('LLM prompt body');
  });

  it('is a no-op when no comment present', () => {
    expect(stripMockDirective('plain prompt')).toBe('plain prompt');
  });
});

describe('defaultPromptBasename — workflow routing', () => {
  it('ambient uses the legacy basenames', () => {
    expect(defaultPromptBasename('album-brief', 'ambient')).toBe('album-brief');
    expect(defaultPromptBasename('track-briefs', 'ambient')).toBe('track-briefs');
    expect(defaultPromptBasename('cover-image', 'ambient')).toBe('cover-prompt');
    expect(defaultPromptBasename('thumbnail', 'ambient')).toBe('thumbnail-prompt');
    expect(defaultPromptBasename('yt-metadata', 'ambient')).toBe('yt-metadata');
  });

  it('rap-compilation uses suffixed basenames', () => {
    expect(defaultPromptBasename('album-brief', 'rap-compilation')).toBe('album-brief-rap');
    expect(defaultPromptBasename('track-briefs', 'rap-compilation')).toBe('track-briefs-rap');
    expect(defaultPromptBasename('cover-image', 'rap-compilation')).toBe('cover-image-rap');
    expect(defaultPromptBasename('thumbnail', 'rap-compilation')).toBe('thumbnail-rap');
    expect(defaultPromptBasename('yt-metadata', 'rap-compilation')).toBe('yt-metadata-rap');
  });

  it('ambient-video aliases ambient defaults (Phase 6 Task 6.1 decision)', () => {
    // Same basenames as 'ambient' — copy/title/genre framing is still ambient
    // for ambient-video; only the cover/thumbnail SOURCE differs (operator-
    // generated source.jpg vs Flow), not the prompts used to generate
    // copy/genre/title.
    expect(defaultPromptBasename('album-brief', 'ambient-video')).toBe('album-brief');
    expect(defaultPromptBasename('track-briefs', 'ambient-video')).toBe('track-briefs');
    expect(defaultPromptBasename('cover-image', 'ambient-video')).toBe('cover-prompt');
    expect(defaultPromptBasename('thumbnail', 'ambient-video')).toBe('thumbnail-prompt');
    expect(defaultPromptBasename('yt-metadata', 'ambient-video')).toBe('yt-metadata');
  });
});
