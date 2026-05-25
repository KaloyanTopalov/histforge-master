import { NextResponse } from 'next/server';
import { z } from 'zod';
import { get as getChannel } from '@/lib/repos/channels';
import {
  get as getPrompt,
  patch as patchPrompt,
  remove as removePrompt,
} from '@/lib/repos/channel-suno-prompts';
import { errorJson } from '@/lib/api/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchSchema = z
  .object({
    label: z.string().min(1).max(100),
    content: z.string().min(1),
    weight: z.number().positive(),
    active: z.boolean(),
  })
  .partial();

function load(channelId: string, promptId: string) {
  const channel = getChannel(channelId);
  if (!channel) return { error: errorJson('CHANNEL_NOT_FOUND', 'Channel not found', 404) };
  const prompt = getPrompt(promptId);
  if (!prompt || prompt.channelId !== channel.id) {
    return { error: errorJson('PROMPT_NOT_FOUND', 'Prompt not found on this channel', 404) };
  }
  return { channel, prompt };
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string; promptId: string } },
) {
  const loaded = load(params.id, params.promptId);
  if (loaded.error) return loaded.error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJson('INVALID_JSON', 'Body is not valid JSON', 400);
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return errorJson('INVALID_BODY', 'Validation failed', 400, parsed.error.flatten());
  }
  const updated = patchPrompt(params.promptId, parsed.data);
  return NextResponse.json({ prompt: updated });
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string; promptId: string } },
) {
  const loaded = load(params.id, params.promptId);
  if (loaded.error) return loaded.error;
  const ok = removePrompt(params.promptId);
  return NextResponse.json({ ok });
}
