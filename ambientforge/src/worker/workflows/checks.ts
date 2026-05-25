import fs from 'node:fs';
import path from 'node:path';
import * as sunoPromptsRepo from '@/lib/repos/channel-suno-prompts';
import type { PreflightCheck, PreflightCheckResult } from './types';

/** Minimum size for `source.jpg` to count as "an actual Midjourney render"
 * rather than an accidental 1-byte touch / empty placeholder. 50 KB is well
 * below any plausible Midjourney 1024² PNG (typically several MB) but big
 * enough to reject empty files. */
const SOURCE_JPG_MIN_BYTES = 50 * 1024;

/**
 * Shared preflight: a channel must have at least one source for the suno
 * style prompt — either ≥1 active row in channel_suno_prompts (the new
 * collection introduced in v7) OR a non-empty channel.suno_style_prompt
 * legacy column. Step 03 will throw SUNO_STYLE_PROMPT_REQUIRED at submit
 * time as a failsafe; this preflight catches the same condition earlier.
 */
export const requireSunoStylePromptSource: PreflightCheck = async ({
  channel,
}): Promise<PreflightCheckResult> => {
  if (!channel) {
    return {
      ok: false,
      code: 'CHANNEL_NOT_FOUND',
      message: 'preflight requires a channel row',
    };
  }
  const active = sunoPromptsRepo.listByChannel(channel.id, { activeOnly: true });
  const legacyOk = (channel.sunoStylePrompt ?? '').trim().length > 0;
  if (active.length > 0 || legacyOk) return { ok: true };
  return {
    ok: false,
    code: 'SUNO_STYLE_PROMPT_REQUIRED',
    message: `channel ${channel.id} has 0 active suno prompts and no legacy suno_style_prompt`,
  };
};

/** Resolve the expected source.jpg path for a channel. Exported so the
 * step 05a/08 modules and the dashboard banner can reference the same path. */
export function sourceJpgPath(channelId: string): string {
  return path.join(process.cwd(), 'projects', channelId, 'source.jpg');
}

/**
 * ambient-video preflight: operator must drop a Midjourney render at
 * `projects/<channel_id>/source.jpg`. It's the cover/thumbnail base AND the
 * Seedance first/last frame. Rejecting here (rather than in step 05a/08)
 * fails the album before Suno burns 30 song credits.
 */
export const requireSourceJpg: PreflightCheck = async ({
  channel,
}): Promise<PreflightCheckResult> => {
  if (!channel) {
    return {
      ok: false,
      code: 'CHANNEL_NOT_FOUND',
      message: 'preflight requires a channel row',
    };
  }
  const p = sourceJpgPath(channel.id);
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return {
      ok: false,
      code: 'SOURCE_JPG_MISSING',
      message: `expected source.jpg at ${p} — drop the Midjourney render there before queueing this album`,
    };
  }
  if (!st.isFile() || st.size <= SOURCE_JPG_MIN_BYTES) {
    return {
      ok: false,
      code: 'SOURCE_JPG_MISSING',
      message: `source.jpg at ${p} is too small (${st.size} bytes, need > ${SOURCE_JPG_MIN_BYTES}) — re-export from Midjourney`,
    };
  }
  return { ok: true };
};

/**
 * ambient-video preflight: when `channel.sceneThemes` is non-null, it must
 * parse as a non-empty `string[]`. Null is OK — step 01b falls back to a
 * hardcoded default theme. Validating here keeps the step code simple
 * because only "null or valid array" reaches it.
 */
export const requireSceneThemesValidOrNull: PreflightCheck = async ({
  channel,
}): Promise<PreflightCheckResult> => {
  if (!channel) {
    return {
      ok: false,
      code: 'CHANNEL_NOT_FOUND',
      message: 'preflight requires a channel row',
    };
  }
  const raw = channel.sceneThemes;
  if (raw == null) return { ok: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      code: 'SCENE_THEMES_INVALID',
      message: `channel ${channel.id} sceneThemes is not valid JSON: ${(err as Error).message}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      code: 'SCENE_THEMES_INVALID',
      message: `channel ${channel.id} sceneThemes must be a JSON array, got ${typeof parsed}`,
    };
  }
  if (parsed.length === 0) {
    return {
      ok: false,
      code: 'SCENE_THEMES_INVALID',
      message: `channel ${channel.id} sceneThemes is an empty array — set channel.sceneThemes to null to use the default theme, or add ≥1 theme string`,
    };
  }
  const bad = parsed.findIndex((x) => typeof x !== 'string' || x.trim().length === 0);
  if (bad !== -1) {
    return {
      ok: false,
      code: 'SCENE_THEMES_INVALID',
      message: `channel ${channel.id} sceneThemes[${bad}] is not a non-empty string`,
    };
  }
  return { ok: true };
};
