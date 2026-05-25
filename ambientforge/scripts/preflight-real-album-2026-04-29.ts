/**
 * Pre-flight check for the first real-mode 30-track album run.
 * Reads production DB (data/ambientforge.db) and reports settings + channel state.
 */
import { openDb } from '../src/lib/db';

const CHANNEL_ID = '01KQ7HRA4SJ9GX6JMC4Q3CNWR1';

const REQUIRED_SETTINGS: Array<{ key: string; expected: string | null; mode: 'eq' | 'neq' | 'absent_or_default' }> = [
  { key: 'tracks_per_album_override', expected: '0', mode: 'eq' },
  { key: 'content_id_hold_days', expected: '14', mode: 'eq' },
  { key: 'distrokid_dry_run', expected: 'true', mode: 'eq' },
  { key: 'queue_state', expected: 'running', mode: 'eq' },
  { key: 'openrouter_api_key', expected: 'mock', mode: 'neq' },
  { key: 'live_mode_confirm', expected: null, mode: 'absent_or_default' },
];

const REQUIRED_CHANNEL_FIELDS = [
  'suno_style_prompt',
  'suno_mode',
  'suno_instrumental',
  'prompt_album_brief',
  'prompt_track_briefs',
  'prompt_cover_image',
  'prompt_thumbnail',
  'prompt_yt_metadata',
  'tracks_per_album',
  'target_video_seconds',
  'distrokid_artist_name',
  'distrokid_primary_genre',
];

type Failure = { kind: string; detail: string };

function main(): void {
  const failures: Failure[] = [];
  console.log(`AMBIENTFORGE_DB_PATH=${process.env.AMBIENTFORGE_DB_PATH ?? 'data/ambientforge.db'}`);
  const db = openDb();

  // Settings
  console.log('\n=== settings ===');
  for (const r of REQUIRED_SETTINGS) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(r.key) as { value: string } | undefined;
    const v = row?.value ?? null;
    let ok = false;
    let note = '';
    if (r.mode === 'eq') {
      ok = v === r.expected;
      note = `expected="${r.expected}" got=${v === null ? 'NULL' : `"${v}"`}`;
    } else if (r.mode === 'neq') {
      ok = v !== r.expected;
      note = `must NOT be "${r.expected}", got=${v === null ? 'NULL' : `"${v.length > 20 ? v.slice(0, 8) + '...' + v.slice(-4) : v}"`}`;
    } else if (r.mode === 'absent_or_default') {
      ok = v === null || v === '';
      note = `must be absent/empty, got=${v === null ? 'NULL' : `"${v}"`}`;
    }
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${r.key}: ${note}`);
    if (!ok) failures.push({ kind: 'setting', detail: `${r.key}: ${note}` });
  }
  // target_video_seconds: per spec "NOT set globally (channel has 14400)". Channel-overrides-settings priority means this is informational.
  const tvs = db.prepare('SELECT value FROM settings WHERE key = ?').get('target_video_seconds') as { value: string } | undefined;
  console.log(`  INFO target_video_seconds (global): ${tvs?.value ?? 'NULL'} (channel value will override)`);

  // Channel row
  console.log('\n=== channel ===');
  const cols = REQUIRED_CHANNEL_FIELDS.join(',');
  const ch = db.prepare(`SELECT id, name, display_name, active, ${cols} FROM channels WHERE id = ?`).get(CHANNEL_ID) as Record<string, unknown> | undefined;
  if (!ch) {
    failures.push({ kind: 'channel', detail: `channel ${CHANNEL_ID} not found` });
    console.log('  FAIL channel not found');
  } else {
    console.log(`  channel: ${ch.display_name} active=${ch.active}`);
    if (ch.active !== 1) failures.push({ kind: 'channel', detail: `channel inactive (active=${ch.active})` });
    const checks: Array<[string, boolean, string]> = [
      ['suno_mode', ch.suno_mode === 'description', `expected "description", got "${ch.suno_mode}"`],
      ['suno_instrumental', ch.suno_instrumental === 1, `expected 1, got ${ch.suno_instrumental}`],
      ['tracks_per_album', ch.tracks_per_album === 30, `expected 30, got ${ch.tracks_per_album}`],
      ['target_video_seconds', ch.target_video_seconds === 14400, `expected 14400, got ${ch.target_video_seconds}`],
      ['distrokid_artist_name', ch.distrokid_artist_name === 'AetherSound', `expected "AetherSound", got "${ch.distrokid_artist_name}"`],
      ['distrokid_primary_genre', ch.distrokid_primary_genre === 'Ambient', `expected "Ambient", got "${ch.distrokid_primary_genre}"`],
    ];
    for (const [field, ok, msg] of checks) {
      console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${field}: ${ok ? 'matches' : msg}`);
      if (!ok) failures.push({ kind: 'channel', detail: `${field}: ${msg}` });
    }
    const promptChecks = ['suno_style_prompt', 'prompt_album_brief', 'prompt_track_briefs', 'prompt_cover_image', 'prompt_thumbnail', 'prompt_yt_metadata'] as const;
    for (const f of promptChecks) {
      const v = ch[f] as string | null;
      const present = typeof v === 'string' && v.trim().length > 0;
      console.log(`  ${present ? 'OK  ' : 'FAIL'} ${f}: ${present ? `${v!.length} chars` : 'EMPTY/NULL'}`);
      if (!present) failures.push({ kind: 'channel', detail: `${f} is empty` });
    }
  }

  // Pre-existing non-terminal albums for this channel?
  console.log('\n=== queue ===');
  const open = db
    .prepare("SELECT id, status FROM albums WHERE channel_id = ? AND status IN ('new','queued','in_progress','awaiting_captcha','awaiting_suno_relogin') ORDER BY created_at DESC")
    .all(CHANNEL_ID) as Array<{ id: string; status: string }>;
  if (open.length > 0) {
    console.log(`  FAIL ${open.length} pre-existing non-terminal album(s) on this channel:`);
    for (const a of open) console.log(`    - ${a.id} status=${a.status}`);
    failures.push({ kind: 'queue', detail: `pre-existing albums: ${open.map((a) => a.id + ':' + a.status).join(', ')}` });
  } else {
    console.log('  OK   no non-terminal albums for this channel (POST /api/albums will succeed)');
  }

  // Env checks for the dev process: we can't read its env, but we can sanity check that mock keys aren't set in the current process.
  console.log('\n=== current process env (info only) ===');
  for (const k of ['SUNO_MODE', 'FLOW_MODE', 'DISTROKID_MODE', 'AMBIENTFORGE_DB_PATH']) {
    console.log(`  ${k}=${process.env[k] ?? '(unset)'}`);
  }

  console.log(`\n=== summary ===`);
  if (failures.length === 0) {
    console.log('  ALL PRE-FLIGHT CHECKS PASSED');
    process.exit(0);
  }
  console.log(`  ${failures.length} FAILURE(S):`);
  for (const f of failures) console.log(`    [${f.kind}] ${f.detail}`);
  process.exit(2);
}

main();
