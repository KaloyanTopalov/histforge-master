import { NextResponse } from 'next/server';
import { getDb, getDbVersion } from '@/lib/db';
import { getRawSetting } from '@/lib/settings';
import { listAll as listSessions } from '@/lib/repos/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const db = getDb();
  return NextResponse.json({
    ok: true,
    queueState: getRawSetting('queue_state', db) ?? 'paused',
    schedulerEnabled: (getRawSetting('scheduler_enabled', db) ?? 'false') === 'true',
    dbVersion: getDbVersion(db),
    sessions: listSessions(db),
  });
}
