import { z } from 'zod';
import { chatCompletionJSON } from '@/lib/llm/openrouter';
import { renderTemplate } from '@/lib/prompts';
import type { Album } from '@/lib/repos/albums';
import type { Channel } from '@/lib/repos/channels';

const ImagePromptResponse = z.object({
  imagePrompt: z.string().min(1),
});

export type GenerateImagePromptInput = {
  album: Album;
  channel: Channel;
  /** Resolved template content. Caller (step 05a / 05b) calls
   *  resolveChannelPrompt(channel, kind) and passes .content here. */
  templateContent: string;
  /** When true, append explicit "square 1:1 composition" emphasis. */
  forceSquare?: boolean;
};

const SQUARE_REMINDER =
  '\n\nIMPORTANT: emphasize a square 1:1 composition. The image will be cropped to a square; subjects should be centered and self-contained.';

export async function generateImagePrompt(input: GenerateImagePromptInput): Promise<string> {
  const baseRendered = renderTemplate(input.templateContent, {
    album: input.album,
    channel: input.channel,
  });
  const rendered = input.forceSquare ? baseRendered + SQUARE_REMINDER : baseRendered;
  const result = await chatCompletionJSON({
    rendered,
    schema: ImagePromptResponse,
  });
  return result.imagePrompt;
}
