import { NextResponse } from 'next/server';
import { z } from 'zod';
import { get as getChannel } from '@/lib/repos/channels';
import {
  create as createPrompt,
  listByChannel,
  countAlbumsUsing,
} from '@/lib/repos/channel-suno-prompts';
import { errorJson } from '@/lib/api/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateSchema = z.object({
  label: z.string().min(1).max(100),
  content: z.string().min(1),
  weight: z.number().positive().default(1.0),
  active: z.boolean().default(true),
});

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const channel = getChannel(params.id);
  if (!channel) return errorJson('CHANNEL_NOT_FOUND', 'Channel not found', 404);
  const prompts = listByChannel(channel.id, {});
  const withCounts = prompts.map((p) => ({
    ...p,
    albumsUsing: countAlbumsUsing(p.id),
  }));
  return NextResponse.json({ prompts: withCounts });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const channel = getChannel(params.id);
  if (!channel) return errorJson('CHANNEL_NOT_FOUND', 'Channel not found', 404);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJson('INVALID_JSON', 'Body is not valid JSON', 400);
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return errorJson('INVALID_BODY', 'Validation failed', 400, parsed.error.flatten());
  }
  const prompt = createPrompt({
    channelId: channel.id,
    label: parsed.data.label,
    content: parsed.data.content,
    weight: parsed.data.weight,
    active: parsed.data.active,
  });
  return NextResponse.json({ prompt }, { status: 201 });
}
