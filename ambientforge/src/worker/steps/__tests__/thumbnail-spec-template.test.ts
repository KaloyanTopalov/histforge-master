import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadThumbnailSpecTemplate,
  renderThumbnailSpec,
} from '@/worker/steps/thumbnail-spec-template';
import { extractMockResponse } from '@/lib/prompts';

let promptsRoot: string;

beforeEach(() => {
  promptsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-spec-tpl-'));
});

afterEach(() => {
  fs.rmSync(promptsRoot, { recursive: true, force: true });
});

function writeDefault(content: string): void {
  const dir = path.join(promptsRoot, 'defaults');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'thumbnail-spec.md'), content);
}

function writeChannel(channelId: string, content: string): void {
  const dir = path.join(promptsRoot, 'channel-templates', channelId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'thumbnail-spec.md'), content);
}

describe('loadThumbnailSpecTemplate', () => {
  it('loads the workflow-default template when no channel override exists', () => {
    writeDefault('DEFAULT SPEC BODY {{TITLE}}');
    const loaded = loadThumbnailSpecTemplate('ch-1', promptsRoot);
    expect(loaded.source).toBe('workflow-default');
    expect(loaded.content).toContain('DEFAULT SPEC BODY');
  });

  it('prefers a per-channel override file over the workflow default', () => {
    writeDefault('DEFAULT SPEC BODY {{TITLE}}');
    writeChannel('ch-7', 'CHANNEL OVERRIDE SPEC {{TITLE}}');
    const loaded = loadThumbnailSpecTemplate('ch-7', promptsRoot);
    expect(loaded.source).toBe('channel-file');
    expect(loaded.content).toContain('CHANNEL OVERRIDE SPEC');
    expect(loaded.content).not.toContain('DEFAULT SPEC BODY');
  });

  it('throws THUMBNAIL_SPEC_TEMPLATE_MISSING when neither channel file nor default exists', () => {
    expect(() => loadThumbnailSpecTemplate('ch-9', promptsRoot)).toThrow(
      expect.objectContaining({ code: 'THUMBNAIL_SPEC_TEMPLATE_MISSING' }),
    );
  });

  it('the shipped default asset loads, carries {{TITLE}}, and has a valid mock-response directive', () => {
    const realPromptsRoot = path.join(process.cwd(), 'prompts');
    const loaded = loadThumbnailSpecTemplate('any-channel', realPromptsRoot);
    expect(loaded.source).toBe('workflow-default');
    expect(loaded.content).toContain('{{TITLE}}');
    expect(loaded.content).toContain('GATES OF VORTALANIA');
    // Phase 6/13 mock tests depend on this directive being valid JSON that
    // chatCompletionText's mock path returns verbatim.
    const mock = extractMockResponse(loaded.content);
    expect(typeof mock).toBe('string');
    expect(mock as string).toContain('TITLE_BLOCK');
  });
});

describe('renderThumbnailSpec', () => {
  it('substitutes every {{TITLE}} occurrence with the scene title, leaving the rest intact', () => {
    const template =
      'Title: {{TITLE}}\n<task>Analyze for "{{TITLE}}"</task>\nNever change GATES OF VORTALANIA.';
    const out = renderThumbnailSpec(template, 'The Knight — Quiet Fire');
    expect(out).toBe(
      'Title: The Knight — Quiet Fire\n<task>Analyze for "The Knight — Quiet Fire"</task>\nNever change GATES OF VORTALANIA.',
    );
    expect(out).not.toContain('{{TITLE}}');
  });
});
