import { NextResponse } from 'next/server';
import { errorJson } from '@/lib/api/errors';
import { get as getChannel, markArtistVerified } from '@/lib/repos/channels';
import { DistrokidError, makeDistrokidClient } from '@/lib/distrokid/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const channel = getChannel(params.id);
  if (!channel) return errorJson('CHANNEL_NOT_FOUND', 'Channel not found', 404);
  if (!channel.distrokidArtistName || channel.distrokidArtistName.trim().length === 0) {
    return errorJson(
      'NO_ARTIST_CONFIGURED',
      'Set channel.distrokidArtistName before verifying',
      400,
    );
  }
  const client = makeDistrokidClient();
  try {
    const result = await client.verifyArtist(channel.distrokidArtistName);
    if (!result.found) {
      return NextResponse.json({ found: false, candidates: result.candidates ?? [] });
    }
    const updated = markArtistVerified(channel.id);
    return NextResponse.json({
      found: true,
      verifiedAt: updated?.distrokidArtistVerifiedAt ?? null,
    });
  } catch (err) {
    if (err instanceof DistrokidError) {
      if (err.code === 'DISTROKID_ARTIST_NOT_FOUND') {
        return NextResponse.json({ found: false });
      }
      if (err.code === 'DISTROKID_BRIDGE_UNREACHABLE') {
        return errorJson(
          'BRIDGE_UNREACHABLE',
          'DistroKid bridge offline — start it with `npm run distrokid:bridge`',
          503,
        );
      }
      return errorJson(err.code, err.message, 500);
    }
    return errorJson('UNKNOWN_ERROR', err instanceof Error ? err.message : String(err), 500);
  }
}
