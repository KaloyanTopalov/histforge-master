import type { LlmProvider } from "./types";
import { openrouterProvider } from "./openrouter";
import { claudeCliProvider } from "./claude-cli";
import type { LlmProviderName } from "./names";

export type { LlmProvider, ChatMessage, ChatOpts } from "./types";
export { LLM_PROVIDER_NAMES, LLM_PROVIDER_LABELS } from "./names";
export type { LlmProviderName } from "./names";

export const llmProviders: Record<LlmProviderName, LlmProvider> = {
  openrouter: openrouterProvider,
  claude_cli: claudeCliProvider,
};

// Compile-time guard: the registry's keys must match the canonical name
// tuple exactly. If a future provider is added to `LLM_PROVIDER_NAMES`
// (`lib/llm/names.ts`) without a corresponding entry here — or vice
// versa — this assertion fails to compile. Mirrors the
// `_assertEnumKeysAreSettingKeys` shape in `lib/settings-enums.ts:53-57`.
type _AssertRegistryMatchesNames =
  keyof typeof llmProviders extends LlmProviderName
    ? LlmProviderName extends keyof typeof llmProviders
      ? true
      : never
    : never;
const _assertRegistryMatchesNames: _AssertRegistryMatchesNames = true;
void _assertRegistryMatchesNames;

export function getLlmProvider(name: string): LlmProvider {
  const provider = llmProviders[name as LlmProviderName];
  if (!provider) {
    throw new Error(`Unknown LLM provider: "${name}"`);
  }
  return provider;
}
