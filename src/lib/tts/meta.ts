// Operator-facing metadata for each TTS provider — the single source of
// truth for the env-var name, display label, and endpoint string. The
// worker providers (`ai33.ts`, `genaipro.ts`) read from here, closing
// the parallel-catalogue drift surface flagged in finding #4 of the
// SOLID audit.
//
// `TTS_PROVIDER_META` is also the canonical roster of provider IDs:
// `TtsProviderId` is derived from its keys, so adding a provider here
// is the only edit needed for the type. The workflow row's
// `tts_provider` enum (`lib/workflows-schema.ts`) and the workflow
// editor's inline option list (`app/workflows/[id]/edit/edit-form.tsx`)
// are kept narrow and updated by hand.
//
// Client-safe — no `node:` imports — so any future client surface can
// consume `TTS_PROVIDER_META` without dragging the worker providers
// (which import `node:fs`) into the client bundle.
//
// `envKey` is empty string for providers that don't read an API key
// (Chatterbox runs locally over HTTP; configuration lives in Settings →
// TTS, not env). Providers with an empty `envKey` MUST NOT do
// `process.env[envKey]` — the lookup would return whatever value the
// empty-string env var happens to have, which is meaningless.

export interface TtsProviderMeta {
  readonly label: string;
  readonly envKey: string;
  readonly endpoint: string;
}

export const TTS_PROVIDER_META = {
  genaipro: {
    label: "GenAIPro",
    envKey: "GENAIPRO_API_KEY",
    endpoint: "genaipro.vn/api/v1",
  },
  ai33: {
    label: "AI33",
    envKey: "AI33_API_KEY",
    endpoint: "api.ai33.pro/v1",
  },
  chatterbox: {
    label: "Chatterbox",
    envKey: "",
    endpoint: "127.0.0.1:8004",
  },
  // Parallelism-capable Chatterbox sidecar (rsxdalv/chatterbox@fast).
  // Same voice-folder convention as devnen, different port. Operators
  // run both side-by-side and pick per-workflow.
  "chatterbox-fast": {
    label: "Chatterbox (fast)",
    envKey: "",
    endpoint: "127.0.0.1:8005",
  },
} as const satisfies Record<string, TtsProviderMeta>;

export type TtsProviderId = keyof typeof TTS_PROVIDER_META;
