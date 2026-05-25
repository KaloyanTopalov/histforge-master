import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorJson } from '@/lib/api/errors';
import { get as getAlbum, patch as patchAlbum } from '@/lib/repos/albums';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  branch: z.enum(['A', 'B']),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const album = getAlbum(params.id);
  if (!album) return errorJson('ALBUM_NOT_FOUND', 'Album not found', 404);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJson('INVALID_JSON', 'Body is not valid JSON', 400);
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return errorJson(
      'INVALID_BODY',
      'Body must be { branch: "A" | "B" }',
      400,
      parsed.error.flatten(),
    );
  }
  const { branch } = parsed.data;

  if (album.status === 'in_progress') {
    return errorJson(
      'ALBUM_LOCKED_DURING_RUN',
      'Cannot retry while album is in_progress',
      409,
    );
  }

  if (branch === 'A' && album.distrokidStatus !== 'failed') {
    return errorJson(
      'BRANCH_NOT_RETRIABLE',
      `Branch A is not in 'failed' state (distrokid_status="${album.distrokidStatus}")`,
      409,
    );
  }
  if (branch === 'B' && album.videoStatus !== 'failed') {
    return errorJson(
      'BRANCH_NOT_RETRIABLE',
      `Branch B is not in 'failed' state (video_status="${album.videoStatus}")`,
      409,
    );
  }

  if (branch === 'A') {
    const updated = patchAlbum(album.id, {
      distrokidStatus: 'pending',
      distrokidSubmittedAt: null,
      safeToUploadAfter: null,
      distrokidDryRunArtifact: null,
      retryBranchOnly: 'A',
      status: 'queued',
    });
    return NextResponse.json({ album: updated });
  }

  // branch === 'B'
  const updated = patchAlbum(album.id, {
    videoStatus: 'pending',
    finalVideoPath: null,
    videoProgressPct: 0,
    retryBranchOnly: 'B',
    status: 'queued',
  });
  return NextResponse.json({ album: updated });
}
