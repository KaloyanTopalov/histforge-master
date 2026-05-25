import { NextResponse } from 'next/server';
import { z } from 'zod';
import { get as getChannel } from '@/lib/repos/channels';
import { create as createAlbum, hasOpenForChannel } from '@/lib/repos/albums';
import { errorJson } from '@/lib/api/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AlbumCreateSchema = z.object({
  channelId: z.string().length(26),
  themePrompt: z.string().nullable().optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJson('INVALID_JSON', 'Body is not valid JSON', 400);
  }
  const parsed = AlbumCreateSchema.safeParse(body);
  if (!parsed.success) {
    return errorJson('INVALID_BODY', 'Validation failed', 400, parsed.error.flatten());
  }
  const channel = getChannel(parsed.data.channelId);
  if (!channel) return errorJson('CHANNEL_NOT_FOUND', 'Channel not found', 404);
  if (!channel.active) {
    return errorJson('CHANNEL_INACTIVE', 'Channel is inactive (soft-deleted)', 409);
  }
  if (hasOpenForChannel(channel.id)) {
    return errorJson(
      'ALREADY_QUEUED_OR_RUNNING',
      'Channel already has a new/queued/in_progress/awaiting_captcha album',
      409,
    );
  }
  const album = createAlbum({
    channelId: channel.id,
    themePrompt: parsed.data.themePrompt ?? null,
    artistName: channel.distrokidArtistName,
    status: 'queued',
  });
  return NextResponse.json({ album });
}
