import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorJson } from '@/lib/api/errors';
import { get as getAlbum, patch as patchAlbum } from '@/lib/repos/albums';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  youtubeVideoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/, 'must be an 11-char YouTube video id'),
  uploadedAt: z.number().int().positive(),
});

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const album = getAlbum(params.id);
  if (!album) return errorJson('ALBUM_NOT_FOUND', 'Album not found', 404);
  return NextResponse.json({ album });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const album = getAlbum(params.id);
  if (!album) return errorJson('ALBUM_NOT_FOUND', 'Album not found', 404);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJson('INVALID_JSON', 'Body is not valid JSON', 400);
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return errorJson(
      'INVALID_BODY',
      'Body must be { youtubeVideoId: 11-char string, uploadedAt: positive int }',
      400,
      parsed.error.flatten(),
    );
  }
  const { youtubeVideoId, uploadedAt } = parsed.data;

  // C3: enforce Content-ID hold at the API layer. Dashboard already disables
  // the button when hold is active, but the API must enforce regardless of UI
  // state — any localhost caller could otherwise bypass.
  if (album.safeToUploadAfter !== null && Date.now() < album.safeToUploadAfter) {
    return errorJson(
      'UPLOAD_HOLD_ACTIVE',
      `Content ID hold active until ${new Date(album.safeToUploadAfter).toISOString()}`,
      409,
      { safeAfter: album.safeToUploadAfter },
    );
  }

  const updated = patchAlbum(album.id, { youtubeVideoId, uploadedAt });
  return NextResponse.json({ album: updated });
}
