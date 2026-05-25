import type { TtsProvider } from "./types";
import { ai33Provider } from "./ai33";
import { genaiproProvider } from "./genaipro";
import { chatterboxProvider } from "./chatterbox";
import { chatterboxFastProvider } from "./chatterbox-fast";

export type { TtsProvider, TtsResult } from "./types";

export const ttsProviders: Record<string, TtsProvider> = {
  ai33: ai33Provider,
  genaipro: genaiproProvider,
  chatterbox: chatterboxProvider,
  "chatterbox-fast": chatterboxFastProvider,
};

export function getTtsProvider(name: string): TtsProvider {
  const provider = ttsProviders[name];
  if (!provider) {
    throw new Error(`Unknown TTS provider: "${name}"`);
  }
  return provider;
}
