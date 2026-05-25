import { NextResponse } from 'next/server';
import { errorJson } from '@/lib/api/errors';
import { get as getAlbum, patch as patchAlbum } from '@/lib/repos/albums';
import { setSetting } from '@/lib/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/albums/[id]/resume-suno-auth
 *
 * Operator-driven resume after a Suno-chain disruption: cookie rotation
 * (set by step 04) OR bridge / sidecar / Chrome connectivity loss (set by
 * step 03 + step 04 — see src/lib/suno/bridge-disruption.ts). Clears both
 * flags and patches the album back to `queued` so the worker picks it up.
 * Step 03's `pending` filter and step 04's `audio_path` idempotency
 * guarantee already-submitted / already-downloaded tracks aren't repeated.
 *
 * Pattern mirrors POST /api/albums/[id]/resume-captcha.
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const album = getAlbum(params.id);
  if (!album) return errorJson('ALBUM_NOT_FOUND', 'Album not found', 404);
  if (album.status !== 'awaiting_suno_relogin') {
    return errorJson(
      'NOT_AWAITING_SUNO_RELOGIN',
      `Album status is "${album.status}", not "awaiting_suno_relogin"`,
      409,
    );
  }
  setSetting('suno_cookie_rotated', '');
  setSetting('suno_bridge_disrupted', '');
  const updated = patchAlbum(album.id, { status: 'queued' });
  return NextResponse.json({ album: updated });
}
