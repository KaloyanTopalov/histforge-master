import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import { getRawSetting } from '@/lib/settings';
import { PATCH as patchSettings } from '@/app/api/settings/route';
import { LIVE_MODE_CONFIRM_PHRASE } from '@/lib/distrokid/constants';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
});

afterEach(() => {
  __setDbForTests(null);
  db.close();
});

function patchReq(body: unknown): Request {
  return new Request('http://localhost/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/settings — distrokid_dry_run double-confirm', () => {
  it('rejects {distrokid_dry_run: false} with no live_mode_confirm', async () => {
    const res = await patchSettings(patchReq({ distrokid_dry_run: false }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error?.code).toBe('LIVE_MODE_CONFIRM_REQUIRED');
    // Setting must NOT have been flipped.
    expect(getRawSetting('distrokid_dry_run', db) ?? 'true').toBe('true');
  });

  it('rejects {distrokid_dry_run: false, live_mode_confirm: "wrong"}', async () => {
    const res = await patchSettings(
      patchReq({ distrokid_dry_run: false, live_mode_confirm: 'wrong' }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error?.code).toBe('LIVE_MODE_CONFIRM_REQUIRED');
    expect(getRawSetting('distrokid_dry_run', db) ?? 'true').toBe('true');
  });

  it('accepts {distrokid_dry_run: false} with the exact magic phrase', async () => {
    const res = await patchSettings(
      patchReq({
        distrokid_dry_run: false,
        live_mode_confirm: LIVE_MODE_CONFIRM_PHRASE,
      }),
    );
    expect(res.status).toBe(200);
    expect(getRawSetting('distrokid_dry_run', db)).toBe('false');
    // Confirmation token MUST NOT be persisted.
    expect(getRawSetting('live_mode_confirm', db)).toBeUndefined();
  });

  it('accepts {distrokid_dry_run: true} with no confirmation needed', async () => {
    // First flip to live so we have something to flip back from.
    await patchSettings(
      patchReq({
        distrokid_dry_run: false,
        live_mode_confirm: LIVE_MODE_CONFIRM_PHRASE,
      }),
    );
    const res = await patchSettings(patchReq({ distrokid_dry_run: true }));
    expect(res.status).toBe(200);
    expect(getRawSetting('distrokid_dry_run', db)).toBe('true');
  });
});
