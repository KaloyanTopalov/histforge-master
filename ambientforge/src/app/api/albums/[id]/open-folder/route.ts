import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { NextResponse } from 'next/server';
import { errorJson } from '@/lib/api/errors';
import { get as getAlbum } from '@/lib/repos/albums';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const album = getAlbum(params.id);
  if (!album) return errorJson('ALBUM_NOT_FOUND', 'Album not found', 404);

  const albumDir = path.join(process.cwd(), 'projects', album.channelId, album.id);
  if (!fs.existsSync(albumDir)) {
    return errorJson(
      'ALBUM_FOLDER_MISSING',
      `Album folder does not exist on disk: ${albumDir}`,
      404,
    );
  }

  if (process.platform !== 'win32') {
    return errorJson(
      'OPEN_FOLDER_UNSUPPORTED',
      `open-folder is Windows-only (current platform: ${process.platform})`,
      501,
    );
  }

  // Detached, no stdio inheritance — fire-and-forget so the explorer window
  // outlives the request.
  const child = spawn('explorer.exe', [albumDir], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  return NextResponse.json({ ok: true, path: albumDir });
}
