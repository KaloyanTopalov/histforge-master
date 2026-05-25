import { NextResponse } from 'next/server';
import { errorJson } from '@/lib/api/errors';
import { get as getAlbum, patch as patchAlbum } from '@/lib/repos/albums';
import { setSetting } from '@/lib/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const album = getAlbum(params.id);
  if (!album) return errorJson('ALBUM_NOT_FOUND', 'Album not found', 404);
  if (album.status !== 'awaiting_captcha') {
    return errorJson(
      'NOT_AWAITING_CAPTCHA',
      `Album status is "${album.status}", not "awaiting_captcha"`,
      409,
    );
  }
  // Clear flag and re-queue. Worker picks up on next 1s tick; step 06's
  // idempotency check triggers a clean re-run since distrokidDryRunArtifact
  // is still null from the captcha-paused first attempt.
  setSetting('distrokid_captcha_pending', '');
  const updated = patchAlbum(album.id, { status: 'queued' });
  return NextResponse.json({ album: updated });
}
