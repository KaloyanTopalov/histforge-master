import { NextResponse } from 'next/server';
import { errorJson } from '@/lib/api/errors';
import { DistrokidError, makeDistrokidClient } from '@/lib/distrokid/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const client = makeDistrokidClient();
  try {
    const result = await client.focusWindow();
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof DistrokidError && err.code === 'DISTROKID_BRIDGE_UNREACHABLE') {
      return errorJson(
        'BRIDGE_UNREACHABLE',
        'DistroKid bridge offline — start it with `npm run distrokid:bridge`',
        503,
      );
    }
    return errorJson('UNKNOWN_ERROR', err instanceof Error ? err.message : String(err), 500);
  }
}
