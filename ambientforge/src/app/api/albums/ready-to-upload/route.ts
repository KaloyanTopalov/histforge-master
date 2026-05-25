import { NextResponse } from 'next/server';
import { listReadyToUpload } from '@/lib/repos/albums';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const albums = listReadyToUpload();
  return NextResponse.json({ albums, count: albums.length });
}
