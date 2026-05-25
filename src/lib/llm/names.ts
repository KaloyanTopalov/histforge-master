// Canonical roster of LLM provider IDs and operator-facing labels. Every
// other consumer (the registry's `Record` keying, the workflow zod enum,
// the seed type, the workflow editor option list, the Script tab's
// provider-view dispatch) derives from this tuple — adding a backend is
// a one-line edit here plus a registry entry, after which TypeScript
// flags every consumer that hasn't kept up.
//
// Client-safe — no `node:` / `db` imports — same constraint as
// `lib/settings-enums.ts:1-10`, so this can be imported from both worker
// and client surfaces.

export const LLM_PROVIDER_NAMES = ["openrouter", "claude_cli"] as const;

export type LlmProviderName = (typeof LLM_PROVIDER_NAMES)[number];

// `Record<LlmProviderName, string>` (not `Partial`) forces a label for
// every name in the tuple — a new entry without a matching label fails
// to compile.
export const LLM_PROVIDER_LABELS: Record<LlmProviderName, string> = {
  openrouter: "OpenRouter",
  claude_cli: "Claude CLI",
};
