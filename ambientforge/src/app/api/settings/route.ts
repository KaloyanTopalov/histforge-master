import { NextResponse } from 'next/server';
import type { ZodTypeAny } from 'zod';
import { errorJson } from '@/lib/api/errors';
import { getDb } from '@/lib/db';
import {
  getSettings,
  setSetting,
  maskSecret,
  SettingsSchema,
} from '@/lib/settings';
import { LIVE_MODE_CONFIRM_PHRASE } from '@/lib/distrokid/constants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PATCHABLE_KEYS = [
  'queue_state',
  'scheduler_enabled',
  'openrouter_api_key',
  'model_name',
  'distrokid_dry_run',
  'target_video_seconds',
  'cover_resample_threshold_mb',
  'youtube_image_aspect',
  'suno_max_concurrent',
  'suno_poll_interval_ms',
  'suno_poll_timeout_ms',
  'suno_mock_credits',
  'suno_insufficient_credits',
  'nvenc_enabled',
  'stats_fetch_hour_utc',
  'content_id_hold_days',
  'keep_raw_audio_after_done',
  'distrokid_artist_missing',
  'distrokid_captcha_pending',
  'distrokid_live_mode_blocked_at',
  'suno_cookie_rotated',
  'broll_allowed_root_paths',
  'force_branch_b_failure_for_album',
  'tracks_per_album_override',
  'distrokid_songwriter_first_name',
  'distrokid_songwriter_middle_name',
  'distrokid_songwriter_last_name',
  'distrokid_credit_performer_name',
  'distrokid_credit_performer_role',
  'distrokid_credit_producer_name',
  'distrokid_credit_producer_role',
] as const;

type PatchableKey = (typeof PATCHABLE_KEYS)[number];

function isPatchableKey(k: string): k is PatchableKey {
  return (PATCHABLE_KEYS as readonly string[]).includes(k);
}

function maskedView(settings: ReturnType<typeof getSettings>) {
  return {
    ...settings,
    openrouter_api_key: maskSecret(settings.openrouter_api_key || undefined),
  };
}

export async function GET() {
  const settings = getSettings();
  return NextResponse.json({ settings: maskedView(settings) });
}

export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJson('INVALID_JSON', 'Body is not valid JSON', 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return errorJson('INVALID_BODY', 'Body must be an object of setting keys', 400);
  }
  const data = { ...(body as Record<string, unknown>) };
  // live_mode_confirm is a transit-only confirmation token — never persisted,
  // never iterated as a setting key. Pull it out before the loop.
  const liveModeConfirm = data['live_mode_confirm'];
  delete data['live_mode_confirm'];
  const db = getDb();
  const shape = SettingsSchema.shape as Record<string, ZodTypeAny>;

  for (const [key, raw] of Object.entries(data)) {
    if (!isPatchableKey(key)) {
      return errorJson('UNKNOWN_SETTING_KEY', `Setting "${key}" is not patchable`, 400);
    }
    if (key === 'openrouter_api_key') {
      // Empty string = leave unchanged; non-empty string = overwrite.
      const v = typeof raw === 'string' ? raw : '';
      if (v.length === 0) continue;
      setSetting(key, v, db);
      continue;
    }
    const fieldSchema = shape[key];
    const fieldParsed = fieldSchema.safeParse(raw);
    if (!fieldParsed.success) {
      return errorJson(
        'INVALID_SETTING_VALUE',
        `Setting "${key}" failed validation`,
        400,
        fieldParsed.error.flatten(),
      );
    }
    const v = fieldParsed.data;
    // C2 defense-in-depth: flipping distrokid_dry_run=false requires an exact
    // confirmation phrase. Step 06 has its own gate, but we don't want a
    // misclick or a malicious localhost PATCH to silently flip live mode.
    if (key === 'distrokid_dry_run' && v === false) {
      if (liveModeConfirm !== LIVE_MODE_CONFIRM_PHRASE) {
        return errorJson(
          'LIVE_MODE_CONFIRM_REQUIRED',
          `Setting distrokid_dry_run=false requires live_mode_confirm to be exactly: "${LIVE_MODE_CONFIRM_PHRASE}"`,
          400,
        );
      }
    }
    const stringValue =
      typeof v === 'boolean' ? (v ? 'true' : 'false') : typeof v === 'number' ? String(v) : String(v);
    setSetting(key, stringValue, db);
  }

  return NextResponse.json({ settings: maskedView(getSettings(db)) });
}
