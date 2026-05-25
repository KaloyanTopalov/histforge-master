---
date: 2026-05-04
branch: genaipro
commit: 61ff826f9bac0c18d38da3efc1525a9385e84f46
topic: TTS implementation and the surface a new provider must cover to be usable in workflows
---

# Research: TTS implementation and adding a new provider

> Descriptive documentation of what currently exists in the codebase. No gap analysis or recommendations.

## Research Question

How is TTS implemented today, and what is the surface a new provider must cover so it can be used inside a workflow?

## Summary

TTS in HistForge is a small, three-file subsystem under `src/lib/tts/` plus a single generic worker step (`06-voiceover.ts`). One provider is registered today: `ai33`, an ElevenLabs-compatible client against AI33.pro using a submit/poll/download pattern.

The shape of the system:

- **Registry**: `src/lib/tts/index.ts` exposes a `Record<string, TtsProvider>` and a `getTtsProvider(name)` factory.
- **Interface**: `src/lib/tts/types.ts` defines a single-method `TtsProvider.synthesize(text, outMp3Path, opts)` returning an optional transcripts payload.
- **Single generic step**: there is no provider-specific TTS step file. The slug `"voiceover"` is the only TTS step, and it dispatches at runtime via `ctx.ttsProvider.synthesize(...)`.
- **Workflow gating vs. provider selection**: the workflow's `tts_provider` column controls whether `"voiceover"` is included in the materialized step list (`null` → skip the step). The actual provider object resolved at pipeline startup, however, comes from the **global** `tts_provider` setting in the `settings` table — not from the workflow snapshot. (Image and video providers behave differently: their concrete provider is pinned per workflow via `snapshot.image_provider` / `snapshot.video_provider`.)
- **All voice-tuning parameters are global settings**: voice id, model id, stability, similarity, style, speed, and speaker-boost live in the `settings` table and are read at synthesis time. There are no per-video or per-workflow overrides.
- **API keys live in env vars** (`AI33_API_KEY`), read directly from `process.env` inside the provider.

A new provider therefore needs: (1) one new file under `src/lib/tts/` implementing `TtsProvider`, (2) a one-line registration in `src/lib/tts/index.ts`, (3) the new name added to the `tts_provider` Zod enum in `src/lib/settings.ts` and the **two** hardcoded `<select>` options arrays in `src/app/settings/settings-form.tsx` and `src/app/workflows/[id]/edit/edit-form.tsx`, and (4) any new settings keys it needs (Zod schema + defaults + form UI).

## Detailed Findings

### 1. Provider interface (`src/lib/tts/types.ts`)

The full contract a provider implements (`src/lib/tts/types.ts:10-26`):

```ts
export interface TtsResult {
  transcripts?: {
    srtPath?: string;
    jsonPath?: string;
  };
}

export interface TtsProvider {
  synthesize(
    text: string,
    outMp3Path: string,
    opts: {
      db?: DatabaseType;
      log?: (message: string) => void;
      signal?: AbortSignal;
    }
  ): Promise<TtsResult>;
}
```

Inputs:
- `text` — full narration script (UTF-8 Markdown read directly from `script/full_script.md`).
- `outMp3Path` — absolute path the provider must write the MP3 to. Provider creates parent directories.
- `opts.db` — optional `better-sqlite3` handle; if omitted the provider calls `getDb()` itself.
- `opts.log` — optional line logger wired to `appendLog()` for progress and unusual events.
- `opts.signal` — optional `AbortSignal`. When aborted (mid-step cancellation) providers must propagate to `fetch()` and call `signal.throwIfAborted()` before polls. This is the cancellation pattern flagged by the `project_long_running_step_cancellation` memory.

Outputs:
- A written MP3 at `outMp3Path` (required).
- A resolved `TtsResult` whose `transcripts.srtPath` / `transcripts.jsonPath` are optional absolute paths to any SRT/JSON transcript files the provider also wrote.

### 2. Registry and factory (`src/lib/tts/index.ts`)

```ts
export const ttsProviders: Record<string, TtsProvider> = {
  ai33: ai33Provider,
};

export function getTtsProvider(name: string): TtsProvider {
  const provider = ttsProviders[name];
  if (!provider) {
    throw new Error(`Unknown TTS provider: "${name}"`);
  }
  return provider;
}
```

Static map, no async loading, no fallback — `getTtsProvider` throws synchronously for an unknown name.

### 3. Existing provider — AI33 (`src/lib/tts/ai33.ts`)

- Vendor: AI33 Pro, an ElevenLabs-compatible API at `https://api.ai33.pro/v1`.
- Auth: `process.env.AI33_API_KEY` read at call time (`ai33.ts:317`), throws if absent. Declared in `.env.example:2`.
- Settings keys read via `getSetting(key, db)`:
  - `voice_id` (path segment of the URL),
  - `voiceover_model_id` (default `eleven_multilingual_v2`),
  - `voice_stability`, `voice_similarity`, `voice_style`, `voice_speed`,
  - `voice_use_speaker_boost`.
- Flow:
  1. `submitTask()` (`ai33.ts:89`): POST `{BASE_URL}/text-to-speech/{voiceId}?output_format=mp3_44100_128` with `xi-api-key`. Returns `task_id`. Up to 3 retries with exponential backoff; aborts immediately on `AbortError`.
  2. Writes `.tts_task_id` sidecar beside `narration.mp3` (`ai33.ts:347`) so a worker restart can resume polling without re-submitting (the submit is a paid call).
  3. `pollUntilReady()` (`ai33.ts:137`): GET `{BASE_URL}/task/{taskId}` every 30 s, validated with a Zod schema (`ai33.ts:45`). Up to 60 consecutive non-fatal failures before giving up.
  4. Downloads MP3 to `outMp3Path`, optional SRT to `audio/narration.srt`, optional JSON to `audio/narration.json` (`ai33.ts:360-375`).
  5. Deletes the sidecar on success (`ai33.ts:378`).

### 4. Worker step (`src/worker/steps/06-voiceover.ts`)

Step declaration (lines 62-90):

```ts
export const step: Step = {
  name: "voiceover",
  module: "tts",
  inputs: ["script/full_script.md"],
  outputs: ["audio/narration.mp3", "audio/narration.srt", "audio/narration.json", "audio/.tts_task_id"],
  produces: ["audio/narration.mp3", "audio/narration.srt", "audio/narration.json"],
  run(videoId, ctx) {
    return runVoiceover(videoId, {
      projectsDir: ctx.projectsDir,
      provider: ctx.ttsProvider,
      signal: ctx.signal,
    });
  },
};
```

Notes:
- Provider is **not** selected inside the step. The pre-resolved `ctx.ttsProvider` is what runs. The fallback `getTtsProvider(getSetting("tts_provider", getDb()))` at line 34 only fires when `runVoiceover` is invoked standalone (e.g., a test) without `deps.provider`.
- Output path is hardcoded: `join(projectDir, "audio", "narration.mp3")` (line 38). All providers must respect this layout.
- `outputs` includes the `.tts_task_id` sidecar so the orchestrator can clean it on failure; `produces` excludes it because nothing downstream consumes it.
- `ctx.signal` is forwarded straight to `provider.synthesize(...)` at line 41-44.

### 5. Workflow registry behavior (`src/lib/workflows.ts`)

`materializeStepList` (lines 88-109) conditionally inserts the slug `"voiceover"`:

```ts
if (snapshot.tts_provider !== null) {
  out.push("voiceover");
}
```

The presence of `tts_provider` (any non-null value) triggers inclusion of one slug — `"voiceover"` — regardless of which provider is named. There are no provider-specific TTS step files like `generate-voiceover-ai33.ts`. Both built-in workflows (`comfyui` and `google-flow` in `src/lib/db.ts:83-118`) set `tts_provider: "ai33"` and use the same `"voiceover"` slug.

### 6. `workflow_id` → step list → provider object (provider resolution trace)

1. **Snapshot pin** (`src/lib/workflows.ts:42-60`): on video create/queue, `resolveSnapshot` reads `workflows` + `workflow_steps` and serializes them (including `tts_provider`) into `videos.workflow_snapshot`.
2. **Pipeline startup** (`src/worker/pipeline.ts:280-340`): `resolveDeps` reads the snapshot back via `readSnapshot` (lines 242-258) and resolves the TTS provider at line 297:

   ```ts
   const ttsProvider = deps?.ttsProvider ?? getTtsProvider(getSetting("tts_provider", db));
   ```

   The provider object is read from the **global `tts_provider` setting**, not from the snapshot. The snapshot's `tts_provider` field controls only whether `"voiceover"` ends up in the step list. (Compare: the same function resolves image/video providers from `snapshot.image_provider` / `snapshot.video_provider` at lines 302-311 — these are workflow-pinned.)
3. **Step list materialization** (line 315): `materializeStepList(snapshot)` produces the ordered slug list.
4. **Step lookup**: slugs are matched against `REAL_STEPS` (lines 316-327). `"voiceover"` resolves to the `step` export from `06-voiceover.ts`.
5. **StepContext build** (`src/worker/pipeline.ts:179-197`): `buildStepContext` packages `ttsProvider`, `imageProvider`, `videoProvider`, `db`, `projectsDir`, `promptsDir`, `chat`, `enrichChat`, and the `AbortSignal` from the pipeline's `AbortController` into a single `StepContext`. The signal originates from `AbortController` created at pipeline line 358; the cancellation watcher (lines 361-363) polls the cancellation source (`videos.delete_requested` by default) and aborts the controller when it flips.

### 7. StepContext (`src/worker/pipeline.ts:32-50`)

```ts
export interface StepContext {
  db: DatabaseType;
  projectsDir: string;
  promptsDir: string;
  log: (message: string) => void;
  chat: (messages: ChatMessage[], opts?: ChatOpts) => Promise<string>;
  enrichChat: (messages: ChatMessage[], opts?: ChatOpts) => Promise<string>;
  ttsProvider: TtsProvider;
  imageProvider: ImageProvider;
  videoProvider: VideoProvider;
  signal: AbortSignal;
}
```

`signal` is the cancellation channel; the voiceover step forwards it directly to `provider.synthesize`.

### 8. TTS vs. image provider architecture

| Aspect | TTS | Image |
|---|---|---|
| Registry | `Record<string, TtsProvider>` in `src/lib/tts/index.ts` | `Record<string, ImageProvider>` in `src/lib/image/index.ts` (entries `comfyui`, `google_flow`) |
| Step slug | One generic `"voiceover"` | One generic `"generate_main_images"` |
| Concrete provider source | **Global setting** `tts_provider` read inside `resolveDeps` (line 297) | **Snapshot** field `snapshot.image_provider` read inside `resolveDeps` (lines 302-306) |
| Workflow-pinned per-instance | No (only presence/absence pinned) | Yes (full provider name pinned) |
| Step file count | 1 (the generic step) | 1 (the generic step dispatches via `ctx.imageProvider`) |

Adding a new provider in either subsystem does **not** require a new step file — both dispatch via the resolved registry entry. The wiring difference is where the name is read from at pipeline startup.

### 9. Settings — Zod schema (`src/lib/settings.ts:70-88`)

| Key | Zod type |
|---|---|
| `tts_provider` | `z.enum(["ai33"])` (line 70) |
| `voice_id` | `z.string()` (line 75) |
| `voiceover_model_id` | `z.enum([...])` — four ElevenLabs model slugs (lines 76-81) |
| `voice_stability` | `z.coerce.number().min(0).max(1)` (line 82) |
| `voice_similarity` | `z.coerce.number().min(0).max(1)` (line 83) |
| `voice_style` | `z.coerce.number().min(0).max(1)` (line 84) |
| `voice_speed` | `z.coerce.number().min(0.7).max(1.2)` (line 85) |
| `voice_use_speaker_boost` | `z.enum(["true","false"]).transform(...)` (lines 86-88) |

No schema entry for an API key — that lives in env only.

### 10. Default seeds (`src/lib/db.ts:33-44`)

`DEFAULT_SETTINGS` seeds:
- `tts_provider: "ai33"`
- `voice_id: ""` (operator must fill in)
- `voiceover_model_id: "eleven_multilingual_v2"`
- `voice_stability: "0.75"`, `voice_similarity: "0.5"`, `voice_style: "0.0"`, `voice_speed: "1.0"`
- `voice_use_speaker_boost: "true"`

All values are stored as TEXT strings (Zod coerces on read).

### 11. Settings API (`src/app/api/settings/route.ts`)

A single flat `/api/settings` endpoint. `GET` (line 12) returns all settings via `getAllSettings()`. `PATCH` (lines 39-64) accepts a partial `Record<string, unknown>` and calls `setSetting` for each key inside one DB transaction. There is no `/api/settings/tts` sub-route.

### 12. Settings UI (`src/app/settings/settings-form.tsx`)

TTS fields render exclusively in the `"ai33"` tab (declared at line 35 in `TABS`). The `TAB_FIELDS["ai33"]` map at lines 76-85 assigns all eight TTS keys to that tab. Field components inside `<TabsContent value="ai33">` (lines 468-535):

- `tts_provider`: `SelectField` with hardcoded `options={["ai33"]}` array (line 473). The provider list is **not** registry-driven — it is a literal JSX array.
- `voice_id`: `TextField` (line 479).
- `voiceover_model_id`: `SelectField` with four hardcoded options mirroring the Zod enum (lines 484-499).
- `voice_stability`, `voice_similarity`, `voice_style`, `voice_speed`: `NumberField` `step={0.01}` (lines 501-527).
- `voice_use_speaker_boost`: `BoolField` (lines 529-534).

A **second** hardcoded TTS provider list lives in the workflow edit form (`src/app/workflows/[id]/edit/edit-form.tsx:389-400`):

```tsx
<SelectField
  id="tts_provider"
  label="TTS provider"
  value={values.tts_provider ?? NONE}
  options={[
    { value: "ai33", label: "AI33" },
    { value: NONE, label: "(none)" },
  ]}
  onChange={(v) => update("tts_provider", v === NONE ? null : v)}
/>
```

The workflows list page (`src/app/workflows/workflows-table.tsx:351`) only renders the column value (`<ProviderCell kind="tts" value={r.providers.tts} />`) — it has no provider list of its own.

### 13. Per-video and per-workflow overrides

- `videos` table has no TTS columns (`src/lib/db.ts:222-238`).
- Video edit modal under `src/app/videos/` references no TTS keys.
- `WorkflowSnapshot` carries only `tts_provider` as a TTS-related field, and that field gates step inclusion only.
- All voice tuning parameters come from global `getSetting(...)` calls at synthesis time inside the provider.

### 14. Surface a new provider crosses

Compiled from the trace above (every site that mentions `"ai33"` or any of the TTS settings keys):

- `src/lib/tts/<newProvider>.ts` — implementation file.
- `src/lib/tts/index.ts` — add key → instance entry to `ttsProviders`.
- `src/lib/settings.ts:70` — extend `tts_provider: z.enum([...])` with the new name (and add any new settings keys this provider needs).
- `src/lib/db.ts:33-44` — default values for any new settings keys.
- `src/app/settings/settings-form.tsx:469-477` — extend the hardcoded `<select>` options array with the new provider name (and add field components + tab assignments for any new settings keys).
- `src/app/workflows/[id]/edit/edit-form.tsx:393-396` — extend the hardcoded `[{ value: "ai33", label: "AI33" }, { value: NONE, label: "(none)" }]` options array. This is a **separate** hardcoded list from the settings form's; it is not registry-driven and not derived from the Zod enum.
- `.env.example` — declare any new env-var credentials.
- `src/lib/db.ts:83-118` — `BUILTIN_WORKFLOWS` if the new provider should be the default for an existing built-in workflow (otherwise users select per-workflow in the UI).
- `src/app/workflows/workflows-table.tsx` — only renders the column value (`r.providers.tts` at line 351) and needs no change for a new provider.

Note on provider selection scope: because `resolveDeps` reads the **global** `tts_provider` setting (not `snapshot.tts_provider`), all videos sharing a worker run use the same TTS provider object regardless of their workflow. Per-workflow TTS selection is currently absent in the resolver path even though the snapshot column exists — see `src/worker/pipeline.ts:297`.

## Code References

- `src/lib/tts/types.ts:3-26` — `TtsResult`, `TtsProvider` interface.
- `src/lib/tts/index.ts:1-16` — registry map and `getTtsProvider` factory.
- `src/lib/tts/ai33.ts:45,89,137,317,347,360-378` — Zod poll schema, submit, poll, env-var read, sidecar write, downloads, sidecar delete.
- `src/worker/steps/06-voiceover.ts:34,38,41-44,62-90` — fallback resolution, output path, signal forwarding, `Step` export.
- `src/worker/pipeline.ts:32-50` — `StepContext` interface.
- `src/worker/pipeline.ts:179-197` — `buildStepContext`.
- `src/worker/pipeline.ts:242-258` — `readSnapshot`.
- `src/worker/pipeline.ts:280-340` — `resolveDeps` (TTS at line 297, image at lines 302-306, video at lines 307-311, materialization at line 315).
- `src/worker/pipeline.ts:358,361-363` — `AbortController` and cancellation watcher.
- `src/lib/workflows.ts:42-60` — `resolveSnapshot`.
- `src/lib/workflows.ts:88-109` — `materializeStepList` with the `tts_provider !== null` gate at lines 97-99.
- `src/lib/settings.ts:70-88` — TTS Zod schema entries.
- `src/lib/db.ts:33-44` — TTS default settings seed.
- `src/lib/db.ts:83-118` — `BUILTIN_WORKFLOWS` showing both pin `tts_provider: "ai33"`.
- `src/lib/db.ts:222-238` — `videos` table schema (no TTS columns).
- `src/app/api/settings/route.ts:12,39-64` — flat GET/PATCH settings endpoint.
- `src/app/settings/settings-form.tsx:35,76-85,468-535` — `"ai33"` tab declaration, tab field map, TTS field components inside the `<TabsContent value="ai33">`.
- `src/app/workflows/[id]/edit/edit-form.tsx:389-400` — workflow-edit `tts_provider` `SelectField` with its own hardcoded options array.
- `src/app/workflows/workflows-table.tsx:351` — TTS column display only (no provider list).
- `src/lib/image/index.ts:7-10` — image registry (for comparison: two entries).
- `.env.example:2` — `AI33_API_KEY` env declaration.

## Architecture Patterns Found

- **Generic-step + runtime registry dispatch**: TTS, image, and video subsystems all use one generic worker step that dispatches to a provider object resolved at pipeline startup. No provider-specific step files exist.
- **Two different provider-selection scopes**: TTS reads the provider from a **global** setting; image and video read from the **per-workflow snapshot**. Both subsystems use the same `Record<string, ProviderInterface>` registry shape.
- **Snapshot pinning**: workflows are pinned into `videos.workflow_snapshot` JSON at queue time. `materializeStepList(snapshot)` builds the ordered slug list from that snapshot at execution time. The TTS slot is conditionally included based on `snapshot.tts_provider !== null`.
- **Submit/poll/download with restart-safe sidecar**: the AI33 provider writes a `.tts_task_id` sidecar after a paid submit so worker restarts can resume polling without paying twice. The sidecar is in the step's `outputs` (cleanup) but not `produces` (not consumed downstream).
- **Cancellation pattern**: a single `AbortController` per pipeline run, `signal` field on `StepContext`, threaded into provider calls. The TTS step forwards `ctx.signal` directly into `provider.synthesize`.
- **String-stored, Zod-coerced settings**: all settings are TEXT in SQLite; Zod schemas in `src/lib/settings.ts` coerce/validate on read.
- **Hardcoded provider option lists in UI (two sites)**: provider `<select>` options are hardcoded JSX arrays — once in the settings form (`settings-form.tsx:473`) and again in the workflow edit form (`edit-form.tsx:393-396`). Neither is registry-driven nor derived from the Zod enum; a new provider must be added to the Zod enum **and both** JSX arrays.
- **Env-only credentials, settings-only config**: API keys live in `process.env` and are read at call time inside the provider; everything else (voice id, model, tuning) lives in the SQLite settings table.
