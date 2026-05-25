import { z } from 'zod';
import { getDb, type Db } from './db';

const zBool = z.preprocess(
  (v) => (typeof v === 'string' ? v === 'true' || v === '1' : Boolean(v)),
  z.boolean(),
);

const zNum = z.preprocess(
  (v) => (typeof v === 'string' ? Number(v) : v),
  z.number(),
);

const zIntInRange = (min: number, max: number) =>
  z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().int().min(min).max(max));

export const SettingsSchema = z.object({
  queue_state: z.enum(['paused', 'running']),
  scheduler_enabled: zBool,
  openrouter_api_key: z.string().default(''),
  model_name: z.string().min(1),
  distrokid_dry_run: zBool,
  target_video_seconds: zNum,
  // Step 05a auto-resamples cover.png to a JPEG sibling whenever the PNG
  // exceeds this many MB. DistroKid's hard cap is 10 MB; we sit below it so
  // the JPEG never lands flush against DK's limit (their server may add
  // metadata or recompress). Keep <= 9.7 unless tightening further.
  cover_resample_threshold_mb: zNum.default(9.5),
  youtube_image_aspect: z.enum(['letterbox', 'crop']),
  suno_max_concurrent: zNum,
  suno_poll_interval_ms: zNum,
  suno_poll_timeout_ms: zNum,
  suno_mock_credits: zNum.default(100),
  suno_insufficient_credits: z.string().default(''),
  nvenc_enabled: z.enum(['auto', 'force', 'off']),
  stats_fetch_hour_utc: zIntInRange(0, 23),
  content_id_hold_days: zIntInRange(0, 30),
  keep_raw_audio_after_done: zBool,
  yt_stats_auth_expired: zBool.default(false),
  distrokid_artist_missing: z.string().default(''),
  distrokid_captcha_pending: z.string().default(''),
  distrokid_live_mode_blocked_at: z.string().default(''),
  // Set by step 04 when Suno's __client cookie rotates mid-album. JSON-encoded
  // {albumId, channelId, at}. Cleared by /api/albums/:id/resume-suno-auth and
  // by recoverInProgress on worker startup.
  suno_cookie_rotated: z.string().default(''),
  // Set by step 03 / step 04 when the Suno bridge / sidecar / Chrome CDP chain
  // becomes unreachable mid-album (codes: SUNO_BRIDGE_UNREACHABLE,
  // SUNO_BRIDGE_TIMEOUT, SUNO_SIDECAR_CRASHED, SIDECAR_INTERNAL). JSON-encoded
  // {albumId, channelId, code, detail, at}. Distinct from suno_cookie_rotated
  // because the recovery path is different — bridge disruptions are typically
  // auto-recoverable by restarting Chrome / the sidecar (the Phase-2 watchdog
  // does this), while cookie rotation requires re-running `npm run suno:login`.
  // Cleared by /api/albums/:id/resume-suno-auth and by the runner's
  // auto-resume tick (Phase 3) when the bridge ping returns healthy.
  suno_bridge_disrupted: z.string().default(''),
  // C5: JSON-encoded array of canonical absolute prefixes. validate-broll,
  // channel CRUD, workflow preflight, and step 09-rap reject paths that
  // don't fall under one of these. Empty array = deny-all (operator must
  // configure before any rap channel can validate).
  broll_allowed_root_paths: z.string().default('[]'),
  // Test-only flag: when set to an album id, step 07 throws a synthetic
  // FORCE_BRANCH_B_FAILURE so runtime checks can verify branch B's failure
  // path without depending on file-system race conditions. Empty in prod.
  force_branch_b_failure_for_album: z.string().default(''),
  // Test-only flag: 0 = use spec default (30 tracks per album); >0 and <=30
  // = generate that many tracks instead. Used for fast end-to-end smoke
  // tests so we burn ~6 Suno credits instead of ~60. Default off.
  tracks_per_album_override: zIntInRange(0, 30).default(0),
  // Operator's real name for DistroKid songwriter credit. DK requires legal
  // first + last name on every track for publishing rights. Replicated to all
  // tracks in step 06 (operator collects royalties, tracks are 100% AI but
  // the real-person credit is what the publisher needs). Defaults populated
  // from runtime settings; channel-level override is a future addition.
  distrokid_songwriter_first_name: z.string().default(''),
  distrokid_songwriter_middle_name: z.string().default(''),
  distrokid_songwriter_last_name: z.string().default(''),
  // Performer + Producer credit fields. DistroKid's per-track credits
  // section requires both for full publishing metadata. Performer = who
  // played the instrument, Producer = who produced. For AI-generated music
  // both default to the operator's real name. Empty role skips that credit.
  distrokid_credit_performer_name: z.string().default(''),
  distrokid_credit_performer_role: z.string().default(''),
  distrokid_credit_producer_name: z.string().default(''),
  distrokid_credit_producer_role: z.string().default(''),
  // v9 ambient-video: which model the freepik-runner picks in the Magnific
  // model dropdown for step 05a-amv (image gen). Exact label as it appears in
  // the Freepik UI — content.js does a regex prefix match so a credits suffix
  // like "Seedream 5 Lite Fast 473 -" still matches "Seedream 5 Lite Fast".
  freepik_model_name: z.string().default('Seedream 5 Lite Fast'),
});

export type Settings = z.infer<typeof SettingsSchema>;

export function readRawSettings(db: Db = getDb()): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{
    key: string;
    value: string;
  }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function getSettings(db: Db = getDb()): Settings {
  return SettingsSchema.parse(readRawSettings(db));
}

export function getRawSetting(key: string, db: Db = getDb()): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string | number | boolean, db: Db = getDb()): void {
  const stringValue =
    typeof value === 'string' ? value : typeof value === 'boolean' ? String(value) : String(value);
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, stringValue);
}

/**
 * Returns the OpenRouter API key, preferring the DB-stored value over the env var.
 * The env var (`OPENROUTER_API_KEY`) stays as a usable bootstrap when the DB row is empty.
 * Returns `undefined` when neither is set. The literal `"mock"` sentinel is honored either way.
 */
export function getOpenRouterApiKey(db: Db = getDb()): string | undefined {
  const stored = getRawSetting('openrouter_api_key', db);
  if (stored && stored.length > 0) return stored;
  return process.env.OPENROUTER_API_KEY;
}

/** Mask a secret for safe display: shows the last 4 characters, prefixed with `…`. */
export function maskSecret(value: string | undefined): string {
  if (!value || value.length === 0) return '';
  if (value.length <= 4) return '…';
  return `…${value.slice(-4)}`;
}
