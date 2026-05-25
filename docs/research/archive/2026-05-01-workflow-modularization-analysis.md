## Research: Workflow Architecture for Modularization

**Date**: 2026-05-01
**Branch**: master
**Commit**: 295379c
**Topic**: How workflows currently work in HistForge — descriptive analysis of the registry, step contract, provider abstractions (LLM/TTS/image/video), settings, and UI surface, in preparation for making workflow construction more modular.

> Descriptive documentation of what exists. No gap analysis or recommendations.

---

## Research Question

> Analyze how workflows work. I want to make the process of creating workflows more modular. I want to be able to create workflows (via AI skills and via UI module that I will implement in the future). For example:
> - First module is **script creation**. It will support multiple steps. Each step will produce artifacts (md files) that can be used in future steps. Currently the steps — research outline, research characters, write hook, write chapters — do exactly that. I want to be more flexible. The steps should be able to produce a single artifact or multiple (via loops).
> - I want to have a **TTS module** which will support multiple providers — including local ones such as Chatterbox. I want to be able to easily choose a provider for a specific workflow.
> - Similar to TTS, an **image creation module** with multiple providers (currently ComfyUI and Google Flow).
> - **Video creation module** — similar to image creation module.
>
> How can we rework the existing architecture in order to implement these changes in the long run?

---

## Summary

HistForge today resolves a video's `workflow_id` string into a fixed, in-code ordered list of step slugs at runtime. Two workflows exist: `comfyui` and `google-flow`. They differ only in four positions (the image and hook-video steps); the other nine steps are shared. Each step is a stateless module that reads from disk, writes to disk, and is registered in a flat `REAL_STEPS` array. Workflows declare a `readonly steps: string[]` referencing those slugs.

Provider abstractions exist in three places: LLM (`src/lib/llm/`), TTS (`src/lib/tts/`), and image (`src/lib/image/`). All three have the **same** registry shape: a `providers: Record<string, Provider>` map and a `getXProvider(name)` lookup. The selected provider name is read once at pipeline boot from a single global setting (`llm_provider`, `tts_provider`, `image_provider`) and injected into every step via `StepContext`. Each registry currently holds exactly **one** entry: `openrouter`, `ai33`, `comfyui` respectively. Their Zod schemas accept only that one literal value.

Video generation does NOT use the image/provider registry. Hook-video generation is split across two distinct, hand-coded code paths:
- `generate_hook_video_comfyui` calls `lib/image/comfyui.generateHookVideoBatch` directly (no provider interface).
- `generate_hook_video_google_flow` delegates to `runGoogleFlowStep` (the shared Google Flow worker helper).

The Google Flow path is a separate sub-system: a server-side coordinator (`lib/flow-*.ts`, `app/api/flow/*`) manages a SQLite-backed queue, an account fleet, webhook routes for the Chrome extension, and a reaper. Google Flow worker steps enqueue, then block-poll until the queue drains.

The `write_chapters` step is the only step today that produces multiple artifacts via a loop. It is hand-coded with bespoke resume logic (atomic `.tmp`→rename writes, file-existence checks, an in-memory rolling story-so-far). Other multi-output steps (image/video generation per chunk) handle their loops inside the provider client.

Settings are global and stored as TEXT in a single `settings` table. Per-video settings do not exist. Provider parameters (e.g., voice settings, ComfyUI URL, Google Flow models) are global, not workflow-scoped.

The Add/Edit Video modal captures only three fields: `title`, `topic_info`, `workflow_id`. The workflow dropdown is populated from the in-code `WORKFLOWS` array. There is no UI for constructing or editing workflows themselves.

---

## Detailed Findings

### 1. Workflow Registry and Step Resolution

#### 1.1 Registry shape (`src/worker/workflows/index.ts`)

The `Workflow` interface (`workflows/index.ts:11-16`):

```ts
export interface Workflow {
  id: string;
  shortLabel: string;
  label: string;
  steps: readonly string[];
}
```

`SHARED_STEPS` (`workflows/index.ts:18-28`) lists the nine steps common to every workflow:
```ts
const SHARED_STEPS = [
  "research_outline", "research_characters", "write_hook", "write_chapters",
  "assemble_script", "voiceover", "align", "chunk", "enrich_chunks",
] as const;
```

`WORKFLOWS` array (`workflows/index.ts:30-57`) holds two entries today. Each appends 4 provider-specific steps to `SHARED_STEPS`:

| Workflow `id` | Position 10 | Position 11 | Positions 12–13 |
|---|---|---|---|
| `"comfyui"` | `generate_main_images_comfyui` | `generate_hook_video_comfyui` | `render`, `cleanup` |
| `"google-flow"` | `generate_main_images_google_flow` | `generate_hook_video_google_flow` | `render`, `cleanup` |

Lookup: `getWorkflowById(id)` (`workflows/index.ts:59-61`) returns `Workflow | null`.

#### 1.2 Slug ↔ Step object resolution (`src/worker/pipeline.ts:190-231`)

`resolveDeps`, called at the top of `runPipeline`:
1. Reads `workflow_id` from the `videos` row (`pipeline.ts:207-209`).
2. Dynamically imports `getWorkflowById` and `REAL_STEPS` (`pipeline.ts:213-220`).
3. Builds `Map<string, Step>` keyed by `step.name` (`pipeline.ts:221`).
4. Maps `workflow.steps` slugs through that map → ordered `Step[]` (`pipeline.ts:222-230`).
5. Throws on unknown slug: `Workflow "<id>" references unknown step "<slug>"` (`pipeline.ts:225-228`).

#### 1.3 Boot-time validators (`src/worker/steps/index.ts:54-93`)

- `validateWorkflowSteps` (called at module load, line 70): asserts every slug in every workflow exists in `REAL_STEPS`.
- `validateStepArtifactRules` (line 79): asserts every slug in `STEP_ARTIFACT_RULES` exists in `REAL_STEPS`.

A typo or missing registration surfaces at worker startup, not mid-run.

#### 1.4 File naming versus slug naming

- File slugs use hyphens: `01-research-outline.ts`, `04-write-chapters.ts`.
- `Step.name` and workflow slug strings use underscores: `"research_outline"`, `"write_chapters"`.
- Provider-specific files follow `generate-<artifact>-<provider>.ts` → `Step.name = "generate_<artifact>_<provider>"`.
- Steps 10–13 do not exist as numbered files; their slot is filled by the four provider-specific files.

---

### 2. Pipeline Orchestrator and Step Lifecycle

#### 2.1 `runPipeline(videoId, depsOverride?)` — `pipeline.ts:244`

Resolved deps include `db`, `projectsDir`, `promptsDir`, `chat`, `ttsProvider`, `imageProvider`, and the resolved `steps` list (`pipeline.ts:190-242`).

Pre-loop seeding (`pipeline.ts:252-255`): `stepsRepo.upsertPending` runs for every step (idempotent via `INSERT OR IGNORE`).

#### 2.2 Per-step loop (`pipeline.ts:257-311`)

For each step:
1. Delete check → wipe `projects/<videoId>/`, hard-delete DB rows, return.
2. Pause check → return without state change (resumable later).
3. Done check → `continue` if `video_steps.status = 'done'`.
4. Mark running (transactional, sets both `video_steps.status` and `videos.current_step`).
5. Build `StepContext` and call `step.run(videoId, ctx)` in `try/catch`.
6. On throw → `recordStepFailure`: append stack to `pipeline.log`, run cleanup (custom hook OR `rmSync` over `step.outputs`), mark step + video failed (transactional), return.
7. On `DeferSignal` (`{ deferred: true, retryAfter: number }`) → set `videos.deferred_until`, leave step status `running`, return.
8. On normal return → mark step done (`finished_at` stamped).

Post-loop (`pipeline.ts:316-334`): re-checks delete + pause, then `videosRepo.markDone` with `output_path = "projects/${videoId}/final.mp4"`.

#### 2.3 Step status transitions (`video_steps.status`)

`pending` → set by `upsertPending`, `resetAllRunningToPending` (boot recovery), `resetToPending` (retry).
`running` → set by `markRunning`; persists during a `DeferSignal` yield.
`done` → set by `markDone`.
`failed` → set by `markFailed` inside `recordStepFailure`.

#### 2.4 Video status transitions (`videos.status`)

`new` → `queued` → `in_progress` → `done` | `failed`. Recorded by repo functions in `src/lib/repos/videos.ts`. `markInProgress` uses `COALESCE(started_at, ?)` (`videos.ts:221-224`) so the original pickup time is preserved across resume cycles.

#### 2.5 Crash recovery

`runner.ts:14-16` exports `resetStaleRunningSteps`, which calls `stepsRepo.resetAllRunningToPending` (`steps.ts:115-119`): `UPDATE video_steps SET status='pending' WHERE status='running'`. Worker entry point calls this on boot.

For Google Flow specifically, `gfRepo.resetAllDispatchedOnStartup` (`google-flow.ts:433-442`) flips every `dispatched` row back to `pending` at worker boot.

#### 2.6 Runner (`src/worker/runner.ts`)

`pickNextVideo(db)` resolution order (`runner.ts:50-75`):
1. Delete-requested → bypass pause/defer gates.
2. Global `queue_state == "paused"` → null.
3. In-progress, not paused, not deferred → resume.
4. Any in-progress (even paused) exists → null (one-at-a-time invariant).
5. Oldest queued, not paused, not deferred → start.

`runLoop` sleeps 0ms after `worked` and 5000ms after `idle-empty` (`runner.ts:125-128`).

---

### 3. Step Contract and Artifact Conventions

#### 3.1 The `Step` interface (`pipeline.ts:63-68`)

```ts
export interface Step {
  name: string;
  outputs: readonly string[];
  run(videoId: string, ctx: StepContext): Promise<void | DeferSignal>;
  cleanup?(videoId: string, ctx: StepContext): Promise<void>;
}
```

- `name`: canonical slug (matches workflow slug and `REAL_STEPS` key).
- `outputs`: paths **relative to `projects/<videoId>/`**. The orchestrator's default failure cleanup `rmSync`s each (`pipeline.ts:159-163`). Empty `outputs` means either nothing to delete (atomic writes) or a custom `cleanup` is provided.
- `run`: the body. Reads inputs from disk, writes outputs to disk. Returns `void` on success, throws on failure, optionally returns `DeferSignal` to yield.
- `cleanup` (optional): replaces default outputs-based cleanup on failure.

#### 3.2 `StepContext` (`pipeline.ts:23-31`)

Fields: `db`, `projectsDir`, `promptsDir`, `log`, `chat`, `ttsProvider`, `imageProvider`. The `log` function is bound per step to `appendLog(videoId, step.name, message, projectsDir)`, which appends `[<stepName>] <ISO> <message>\n` to `projects/<videoId>/pipeline.log` (`logger.ts:14-25`).

#### 3.3 Artifact-passing model

All inter-step data transfer is via the filesystem. Steps construct paths from `ctx.projectsDir + videoId + ...`. There is no typed loader, no message bus, no in-memory shared object beyond `StepContext`.

Canonical project-directory layout (derived from step output declarations):
```
projects/<videoId>/
  pipeline.log
  script/
    01_outline.md
    02_characters.md
    03_hook.md
    04_outline_structured.json    (intermediate, written by step 04)
    04_chapter_01.md … 04_chapter_NN.md
    story_so_far.md               (intermediate, written by step 04)
    full_script.md
  audio/
    narration.mp3
    narration.srt
    narration.json
    .tts_task_id                  (resume sidecar, listed in step.outputs)
  alignment/
    alignment.json
  chunks/
    chunks.json
  images/main/
    <chunk_id>.png
  videos/hook/
    <chunk_id>.mp4
  render/                         (transient, recreated by render step)
  final.mp4
```

#### 3.4 Step-export convention

Each step file exports a named `step: Step` constant. The `step.run` method is a thin shim that extracts fields from `ctx` and calls an inner `runX(videoId, deps)` function (e.g., `01-research-outline.ts:97-108`). The inner function accepts injectable deps for testing.

---

### 4. Script Creation Module — Steps 01-05 and 09

#### 4.1 Step 01: `research_outline` (`src/worker/steps/01-research-outline.ts`)

- **Reads:** `videos.title`, `videos.topic_info` (DB); settings `chapter_count`, `act_distribution`; prompt template `prompts/01_research_outline.md`; auto-loaded `_shared/` fragments.
- **Computed locally:** `act_example` (a natural-language string built from `act_distribution` + `chapter_count`, `01-research-outline.ts:79-95`).
- **LLM call:** single `chat([{role:"user", content: prompt}], { db })` (line 67).
- **Writes:** `script/01_outline.md` (line 69-71).
- **`step.outputs`:** `["script/01_outline.md"]` (line 99).

#### 4.2 Step 02: `research_characters` (`src/worker/steps/02-research-characters.ts`)

- **Reads:** `script/01_outline.md` (disk).
- **LLM call:** single `chat`.
- **Writes:** `script/02_characters.md`.
- **`step.outputs`:** `["script/02_characters.md"]`.

#### 4.3 Step 03: `write_hook` (`src/worker/steps/03-write-hook.ts`)

- **Reads:** `videos.title` (DB); `script/01_outline.md`, `script/02_characters.md` (disk).
- **LLM call:** single `chat`.
- **Writes:** `script/03_hook.md`.
- **`step.outputs`:** `["script/03_hook.md"]`.

#### 4.4 Step 04: `write_chapters` (`src/worker/steps/04-write-chapters.ts`) — the multi-artifact loop

This is the only step that produces multiple artifacts via an LLM-driven loop. It has two phases:

**Phase A — Structure extraction (`04-write-chapters.ts:70-87`):**
- If `script/04_outline_structured.json` exists on disk, read+parse it (resume).
- Otherwise, render `prompts/04_extract_structure.md` with `{{outline}}`, send to LLM.
- Apply `cleanJsonReply` (`04-write-chapters.ts:180-214`) to strip code fences and normalize newlines inside JSON strings.
- Validate parsed array's `number` set equals `[1..chapter_count]` (lines 91-101).

**Phase B — Batch chapter writing (`04-write-chapters.ts:104-173`):**
- Settings consumed: `chapter_count` (line 59), `chapter_target_words` (line 60).
- Loop in groups of `BATCH_SIZE = 3` (line 31).
- Per chapter: filename is `04_chapter_${String(c.number).padStart(2,"0")}.md`.
- Resume-skip: if **all** files in a batch already exist on disk, `continue` skips that batch.
- Build `chapters_block` by joining `CHAPTER <n>: <title>\n<summary>` entries with `\n\n`.
- Render `prompts/04_write_chapters_batch.md` with `{{outline}}`, `{{characters}}`, `{{story_so_far}}`, `{{chapter_target_words}}`, `{{chapters_block}}`.
- One LLM call per batch.
- Split reply on `---CHAPTER_BREAK---` sentinel (line 33).
- Atomic write per chapter via `writeFileAtomic` (`.tmp` → rename, `04-write-chapters.ts:223-227`).
- After each batch, second LLM call with `prompts/04_story_so_far.md` to update the rolling summary; written atomically to `script/story_so_far.md`. Resume reads existing `story_so_far.md` on entry (lines 105-108).

**`step.outputs`:** `[]` (line 235). Atomic writes guarantee any file on disk is complete; default cleanup not needed.

#### 4.5 Step 05: `assemble_script` (`src/worker/steps/05-assemble-script.ts`) — pure file concatenation

- **No LLM call.**
- Reads: `script/03_hook.md`, then `script/04_chapter_01.md` through `script/04_chapter_NN.md` driven by `chapter_count` setting (line 47-55, **not** by globbing — comment at 35-40 explains this prevents stale files leaking in).
- Joins parts with `\n\n`, then `sanitizeScript` replaces `—` (em-dash) with `, ` (lines 23-29; documented as needed because AI33 fails on em-dashes).
- **Writes:** `script/full_script.md`.
- **`step.outputs`:** `["script/full_script.md"]`.

#### 4.6 Step 09: `enrich_chunks` (`src/worker/steps/09-enrich-chunks.ts`) — per-chunk LLM enrichment

- **Reads:** `chunks/chunks.json` (typed `Chunk[]` from `src/types.ts:153`); setting `style_prompt_default`.
- **Per-chunk loop:** for each chunk, gather `{ prevText, currentText, nextText, style_prompt }`, render `prompts/09_enrich_chunk.md`, call `chat`, set `chunks[i].prompt`, reset `chunks[i].prompt_history = []`.
- **Persistence:** rewrites entire `chunks.json` after each chunk (line 69) — partial-resume safety.
- **`step.outputs`:** `[]` (line 77).

#### 4.7 Order versus numbering

Steps are ordered by their position in the workflow's `steps` array, **not** by their filename prefix. Steps 06 (voiceover), 07 (align), 08 (chunk) sit between 05 and 09, all in `SHARED_STEPS`. Step 09 runs after `chunk`, so the order is enforced by `SHARED_STEPS` not by file numbering.

---

### 5. LLM Client and Prompt System

#### 5.1 Provider interface (`src/lib/llm/types.ts`)

```ts
export interface LlmProvider {
  chat(messages: ChatMessage[], opts?: ChatOpts): Promise<string>;
}
```

`ChatMessage`: `{ role: "system" | "user" | "assistant"; content: string }`.
`ChatOpts`: `{ model?: string; db?: Database; retryDelayMs?: number }`.

#### 5.2 Registry (`src/lib/llm/index.ts`)

```ts
const providers: Record<string, LlmProvider> = { openrouter: openrouterProvider };
export function getLlmProvider(name: string): LlmProvider { /* throws on unknown */ }
```

One provider registered. The Zod schema `llm_provider: z.enum(["openrouter"])` (`settings.ts:33`) accepts only that literal.

#### 5.3 OpenRouter client (`src/lib/llm/openrouter.ts`)

- Endpoint hardcoded: `https://openrouter.ai/api/v1/chat/completions` (line 7).
- Auth: `Authorization: Bearer ${process.env.OPENROUTER_API_KEY}` (lines 27-32).
- Model: `opts.model ?? getSetting("model_name", db)` (lines 34-35). Script steps never pass `model`, so they all use the global `model_name`.
- Body: `JSON.stringify({ model, messages })`. No `temperature`, `max_tokens`, `top_p`, `cache_control`, or system-prompt blocks are sent.
- Retries: up to 3 attempts with exponential backoff (`baseDelay * 2^attempt` ms; default base 1000ms).
- Returns `json.choices[0].message.content` as a string.

No prompt-cache support.

#### 5.4 Prompt rendering (`src/lib/prompts.ts`)

Single exported function `render(promptFile, vars, promptsDir)`:
- Reads template fresh from disk every call (line 21) — operator edits take effect immediately.
- `loadSharedFragments(promptsDir)` (lines 27-39) scans `prompts/_shared/`. Each file becomes a variable keyed by basename without extension. Always loaded regardless of caller.
- Caller `vars` are spread over shared fragments; collisions favor caller (line 23).
- `substitute(template, merged)` replaces `{{identifier}}` (regex `/\{\{\s*(\w+)\s*\}\}/g`). Throws on unresolved placeholder.

#### 5.5 `prompts/` directory layout

```
prompts/
  01_research_outline.md
  02_research_characters.md
  03_write_hook.md
  04_extract_structure.md
  04_write_chapters_batch.md
  04_story_so_far.md
  09_enrich_chunk.md
  moderate_blocked_prompts.md
  _shared/
    audience_profile.md
    banned_words.md
    numbers_as_letters.md
    format_guidelines.md
  comfyui/
    default-workflow.json                   (SDXL 9-node ComfyUI workflow)
    default-hook-video-workflow.json        (operator-supplied; not bundled)
```

Prompts are not workflow-scoped. Same templates used regardless of `workflow_id`.

---

### 6. TTS Module

#### 6.1 Files in `src/lib/tts/`

- `types.ts` — `TtsProvider` interface, `TtsResult` type.
- `index.ts` — provider registry: `{ ai33: ai33Provider }`, exports `getTtsProvider`.
- `ai33.ts` — sole concrete provider.

#### 6.2 `TtsProvider` contract (`src/lib/tts/types.ts:10-19`)

```ts
export interface TtsProvider {
  synthesize(
    text: string,
    outMp3Path: string,
    opts: { db?: Database; log?: (m: string) => void }
  ): Promise<TtsResult>;
}
```

`TtsResult` (lines 3-8): `{ transcripts?: { srtPath?: string; jsonPath?: string } }`.

#### 6.3 AI33 client (`src/lib/tts/ai33.ts`)

- Base URL: `https://api.ai33.pro/v1` (line 24).
- API key: `process.env.AI33_API_KEY` (line 276).
- Voice parameters read inside the provider via `getSetting`: `voiceover_model_id`, `voice_stability`, `voice_similarity`, `voice_style`, `voice_use_speaker_boost`, `voice_speed`. Wrapped under ElevenLabs-compatible `voice_settings` key (`buildSubmitBody`, line 64).
- Submit: `POST /text-to-speech/{voiceId}?output_format=mp3_44100_128`. 3 retries with exponential backoff (`MAX_SUBMIT_ATTEMPTS = 3`).
- Poll: `GET /task/{taskId}` every 30s by default (`DEFAULT_POLL_INTERVAL_MS = 30_000`). Infinite loop. Terminal states `"done"` (returns audio/srt/json URLs) and `"error"` (throws). `progress` changes are logged.
- Sidecar: `{audioDir}/.tts_task_id` (constant `SIDECAR_NAME = ".tts_task_id"`, line 219). Atomic write via `.tmp` → `renameSync` (`writeSidecar`, line 242). Resume reads sidecar before submitting; on success deletes sidecar (line 328-329); deliberately preserves sidecar on throw (comment at lines 211-218).
- Download: MP3 to `outMp3Path`, SRT to `narration.srt`, JSON to `narration.json` (lines 311-326).

#### 6.4 Step 06: `voiceover` (`src/worker/steps/06-voiceover.ts`)

- Provider resolution (line 32): `deps.provider ?? getTtsProvider(getSetting("tts_provider", getDb()))`. Resolved at step entry, not pipeline boot. (`StepContext.ttsProvider` is passed in via the orchestrator — `pipeline.ts:201`, but the step layers another `getSetting` lookup on top. This is a divergence from the LLM/image pattern.)
- Reads: `script/full_script.md`.
- Writes: `audio/narration.mp3`, `audio/narration.srt`, `audio/narration.json`.
- `step.outputs`: 4 entries — three media files plus `audio/.tts_task_id` (the sidecar is listed so failure cleanup wipes it; comment at lines 66-69 explains the rationale).

#### 6.5 TTS settings (Zod, `src/lib/settings.ts:70-85`)

- `tts_provider` → `z.enum(["ai33"])` (single literal).
- `voice_id` → `z.string()`.
- `voiceover_model_id` → `z.enum(["eleven_multilingual_v2","eleven_turbo_v2_5","eleven_flash_v2_5","eleven_v3"])`.
- `voice_stability`/`voice_similarity`/`voice_style` → `z.coerce.number().min(0).max(1)`.
- `voice_speed` → `z.coerce.number().min(0.7).max(1.2)`.
- `voice_use_speaker_boost` → boolean transform from `"true"/"false"`.

UI: `src/app/settings/settings-form.tsx:410-477` renders the AI33 tab with these eight fields. `tts_provider` shows a `<Select>` with `options={["ai33"]}` — single-item list.

---

### 7. Image Module

#### 7.1 Files in `src/lib/image/`

- `types.ts` — `ImageProvider` interface.
- `index.ts` — registry: `{ comfyui: comfyuiProvider }`, exports `getImageProvider`.
- `comfyui.ts` — exports `comfyuiProvider` (image generation) AND `generateHookVideoBatch` (video generation, **does not** implement `ImageProvider`).

#### 7.2 `ImageProvider` contract (`src/lib/image/types.ts:3-12`)

```ts
export interface ImageProvider {
  generateBatch(
    items: { id: string; prompt: string }[],
    targetDir: string,
    opts: { db?: Database; log?: (m: string) => void }
  ): Promise<void>;
}
```

#### 7.3 Registry (`src/lib/image/index.ts:6-16`)

```ts
const providers: Record<string, ImageProvider> = { comfyui: comfyuiProvider };
```

Google Flow is **NOT** registered as an `ImageProvider`. The Google Flow image step bypasses the registry entirely.

#### 7.4 ComfyUI client (`src/lib/image/comfyui.ts`)

- Reads `comfyui_workflow_path` setting (default `"prompts/comfyui/default-workflow.json"`, `db.ts:16`) and parses the JSON.
- The default workflow is a 9-node SDXL graph. Node `6` is marked `"_histforge_prompt": true` — the prompt-injection target.
- Per-image: deep-clone template, set `findPromptNode(workflow).inputs.text = item.prompt`, set `EmptyLatentImage` width/height from `computeResolution(aspect_ratio, long_edge_px)` (`render.ts:27-45`).
- `submitPrompt` POSTs `{ prompt: workflow }` to `<baseUrl>/prompt` (line 100-122).
- `pollUntilComplete` polls `<baseUrl>/history/<promptId>` every 2000ms, throws on `status_str === "error"`, returns first image when present.
- `downloadImage` fetches `<baseUrl>/view?...` and writes synchronously.
- Skip-existing: `existsSync(outPath)` (line 372-376).
- `generateHookVideoBatch` (line 283) is the parallel function for video, reading `comfyui_hook_video_workflow_path`. It uses `pollUntilCompleteVideo` (line 210-269) which iterates output node keys to find `videos`/`gifs`/`files`/etc. arrays. Throws `ENOENT` if hook-video workflow JSON is absent.
- Error wrap: `fetch failed`/`ECONNREFUSED` → `"ComfyUI is unreachable at <url> — is it running?"` (line 394-402).

#### 7.5 Image-related settings

- `image_provider` → `z.enum(["comfyui"])` (`settings.ts:15`) — single literal.
- `comfyui_base_url` → `z.string()`.
- `comfyui_workflow_path`, `comfyui_hook_video_workflow_path` → `z.string()`.

#### 7.6 Provider-specific worker steps for images

| Slug | File | Mechanism |
|---|---|---|
| `generate_main_images_comfyui` | `generate-main-images-comfyui.ts` | Calls `provider.generateBatch(...)` via `getImageProvider(getSetting("image_provider"))`. Output: `images/main/<chunk_id>.png`. `step.outputs = ["images/main"]`. |
| `generate_main_images_google_flow` | `generate-main-images-google-flow.ts` | Calls `runGoogleFlowStep(videoId, deps, { stepName, chunkKind: "main", queueKind: "main_image", mode: "createImage", outputDir: "images/main", outputExt: ".png" })`. `step.outputs = []`. |
| `generate_hook_video_comfyui` | `generate-hook-video-comfyui.ts` | Lazy-imports `generateHookVideoBatch` from `lib/image/comfyui`. Output: `videos/hook/<chunk_id>.mp4`. `step.outputs = ["videos/hook"]`. |
| `generate_hook_video_google_flow` | `generate-hook-video-google-flow.ts` | Calls `runGoogleFlowStep(... chunkKind: "hook", queueKind: "hook_video", mode: "text", outputDir: "videos/hook", outputExt: ".mp4")`. `step.outputs = []`. |

#### 7.7 Where image prompts come from

- Step 08 (`chunk`) produces `chunks/chunks.json` from alignment data; `Chunk.prompt` is `null` initially (`08-chunk.ts:162`).
- Step 09 (`enrich_chunks`) populates `Chunk.prompt` per chunk via LLM call using `prompts/09_enrich_chunk.md`. The template instructs the LLM to produce a single visual prompt and embeds detailed content-policy guidance (`prompts/09_enrich_chunk.md:14-46`) — forbids naming real historical people, graphic violence, discrimination framing.

`Chunk.kind` (one of `"hook" | "main"`) determines which step processes which subset of chunks.

---

### 8. Video Module — Hook vs. Main, ComfyUI vs. Google Flow

#### 8.1 No video-provider registry

There is no `VideoProvider` interface, no `lib/video/` directory, and no registry equivalent to TTS/image. Video generation today exists only in two forms:
- **ComfyUI hook video** — direct call to `lib/image/comfyui.generateHookVideoBatch` (a standalone exported function in the same file as `comfyuiProvider`).
- **Google Flow hook video** — `runGoogleFlowStep` with `chunkKind:"hook", queueKind:"hook_video", mode:"text"`.

There is no "main video" step. Main chunks produce stills (`generate_main_images_*` → PNG), which are turned into per-segment zoompan video segments inside `lib/render.ts` (Stage B, `render.ts:296-338`).

#### 8.2 Hook vs. main differences

| | Hook | Main |
|---|---|---|
| Chunk filter | `Chunk.kind === "hook"` | `Chunk.kind === "main"` |
| Output | `videos/hook/<chunk_id>.mp4` | `images/main/<chunk_id>.png` |
| Google Flow `mode` | `"text"` (text-to-video) | `"createImage"` |
| ComfyUI workflow | `comfyui_hook_video_workflow_path` | `comfyui_workflow_path` |
| Render stage consumed by | Stage A (concat + last-frame extension) and Stage D (crossfade into main) | Stage B (per-segment zoompan) |

Both share the `c.prompt` field populated by step 09.

#### 8.3 Google Flow shared step helper (`src/worker/steps/google-flow-common.ts`)

`runGoogleFlowStep(videoId, deps, spec)` — sole entry point for both Google Flow image and hook-video steps. Phases:

1. **Read** `chunks/chunks.json`, filter by `spec.chunkKind`.
2. **Enqueue** (`enqueueChunks`, lines 119-157):
   - Skip if output file exists on disk.
   - Skip if `findOpenTaskForChunk` returns a row (in-flight).
   - Skip if `c.prompt == null`.
   - Else `gfRepo.enqueueTask(db, {...})` inserts a `pending` row.
   - Hard error if no pending and no existing.
3. **Wait** (`waitForFlowQueue`, `flow-wait.ts:50-119`):
   - Polls `gfRepo.countByStatusForVideo` every 5s.
   - Returns `{ok:true}` when `pending+dispatched==0`.
   - Returns `{reason:"paused"}`, `{reason:"stalled"}`, `{reason:"deleted"}`, or `{reason:"timeout"}` (24h hard cap).
   - On non-OK, returns `DeferSignal` to orchestrator.
4. **Moderation loop** (`runModerationLoop`, lines 171-220):
   - Up to `MAX_MODERATION_ITERATIONS_GUARD = 10` iterations.
   - Reads `google_flow_content_moderation_enabled` and `google_flow_content_moderation_max_rounds`.
   - For failed content-policy rows, builds `ModerationItem[]`, calls `moderateBatch` (LLM rewrite via `prompts/moderate_blocked_prompts.md`).
   - Per rewrite (transactional): `gfRepo.insertModerationEvent` + `gfRepo.requeueWithNewPrompt` (resets row to `pending`, increments `moderation_round`). Mutates `chunk.prompt` and `chunk.prompt_history` in memory; rewrites `chunks.json`.
5. **Aggregate failures** (`aggregateFailures`, lines 229-248): final check for failed rows whose output file is still missing on disk; throws if any.

---

### 9. Google Flow Coordinator

#### 9.1 Account fleet (`src/types.ts:45-55`, `src/lib/repos/google-flow.ts`)

Table `google_flow_accounts`. Columns: `id` (`acc_NN`), `name`, `token` (32-char base64url), `paused_until`, `last_seen_at`, `credits`, `credits_updated_at`, `enabled`, `created_at`, plus unused `quota_used_today`.

ID minting (`accounts/route.ts:19-27`): `MAX(SUBSTR(id, 5)::INTEGER) + 1`, zero-padded to 2 digits. Stable across deletions; gaps allowed.

Token minting: `randomBytes(24).toString('base64url')` (`accounts/route.ts:29-31`). Returned only at creation; GET responses redact to `…<last4>`.

Lease: `takeNextTaskForAccount` (`google-flow.ts:244-274`) is the only claim path. Transactional SELECT-then-UPDATE that flips `pending → dispatched`, sets `assigned_account_id`, `dispatched_at`, mints `external_task_id = "${id}_${now}"`. No explicit release — re-released by `completeTask`/`failTask`/`requeueTask`.

#### 9.2 Per-(video, account) project mapping (`google_flow_video_projects`)

PK `(video_id, account_id)`, value `flow_project_id`. `upsertFlowProjectForAccount` is `INSERT OR IGNORE` (first-writer-wins). Sent as `flowProjectId` in the next-task payload so the extension reuses an existing Flow project rather than creating a new one. `clearFlowProjectForAccount` is called when a stale-project error surfaces.

#### 9.3 Queue (`google_flow_queue`)

States: `pending → dispatched → done|failed`. `dispatched → pending` via `requeueTask`. `failed → pending` via `requeueWithNewPrompt` (moderation) or the `requeue-failed` route.

`kind`: `"main_image" | "hook_video"`.
`mode`: `"createImage" | "text" | "image" | "frames"`.

Pickup index: `idx_google_flow_queue_pickup ON (status, priority, id)` (`db.ts:154-155`).

Retry semantics: `bumpRetryCount` only fires on transient errors. Quota errors trigger `pauseAccount(account.id, now + cooldown_hours*3600)` instead of bumping retry. Content-policy errors mark `failed` immediately (no retry at queue level — moderation loop handles rewrites).

#### 9.4 Webhook routes (`src/app/api/flow/`)

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/flow/next-task/[token]` | POST | `resolveFlowAccount(requireEnabled:true)` | Claim and shape next task for extension; returns `200 {}` if nothing to dispatch or queue paused; sets `Retry-After` if account is on cooldown |
| `/api/flow/submit-result/[token]` | POST | `resolveFlowAccount` (no enable check) | Accept result URL or error envelope; downloads result via `flow-media.downloadToProjectPath` to `output_path`; routes errors via `CATEGORY_HANDLERS` (v2) or `LEGACY_HANDLERS`; always returns `200 {success:true}` |
| `/api/flow/status/[token]` | POST | `resolveFlowAccount` | Heartbeat events: `session_expired` sets `google_flow_relogin_needed`; `credits` updates account credits |
| `/api/flow/project/[token]` | POST | `resolveFlowAccount` | Records per-(video, account) Flow project ID via INSERT OR IGNORE |
| `/api/flow/accounts` | GET, POST | none (dashboard) | List redacted accounts; create new (returns full token + four URLs once) |
| `/api/flow/accounts/[id]` | PATCH, DELETE | none | Update name/enabled/paused_until; on delete, requeues all dispatched rows for that account first |
| `/api/flow/queue-summary/[videoId]` | GET | none | `FlowSummary` for dashboard |
| `/api/flow/requeue-failed/[videoId]` | POST | none | Requeue eligible failed + all dispatched rows; if a `failed` step caused the video to fail, also resets that step + clears failure + sets video back to `queued` |
| `/api/flow/clear-create-project-failed` | POST | none | Clears the `flow_create_project_failed` settings flag |

#### 9.5 Auth gate (`src/lib/flow-auth.ts`)

`resolveFlowAccount` checks: JSON parse → Zod schema → URL token == body token → DB lookup by token → bump `last_seen_at` → optional enabled check.

#### 9.6 Reaper (`src/lib/flow-watcher.ts`)

`startReaper` runs `runReaperTick` every 30s.
- **Step 1** (lines 65-94): account-level salvage — requeue dispatched rows whose account is disabled or `last_seen_at < now - DEFAULT_STALE_ACCOUNT_MINUTES (10)`.
- **Step 2** (lines 99-113): per-dispatch age timeout — requeue rows older than `dispatchTimeoutMinutes` (default 30, from setting).
- **Step 3** (lines 115-135): if `anyAccountAvailable`, wake up `videos.deferred_until` for videos that still have `pending` queue rows.

#### 9.7 Allowed result hosts (`src/lib/flow-media.ts`)

`isAllowedResultHost`: `*.googleusercontent.com`, `storage.googleapis.com`, `flow-content.google`, `fife.*.googleapis.com`, `data:` URLs. Any other host rejected.

Download flow: `downloadToProjectPath(videoId, output_path, resultUrl, projectsDir)` — atomic `.tmp` → final path.

---

### 10. Final Render Stage (`src/lib/render.ts`)

`render(videoId, deps)` — five sequential FFmpeg stages (`render.ts:216-404`):

- **Stage A — Hook concat** (lines 247-294): `ffmpeg -f concat` joins all `videos/hook/<id>.*` clips → `hook_concat.mp4`. Then extracts last frame, loops it for `CROSSFADE_SECONDS = 1.0` → `hook_tail.mp4`. Concats into `hook_final.mp4`.
- **Stage B — Per-segment renders** (lines 296-338): For each main chunk, renders `images/main/<id>.*` with a zoompan filter (`zoompan=z='1.0+(1.275-1.0)*on/<frames>'`) over the chunk's audio duration + crossfade overhang. Falls back to a black `MISSING: <id>` placeholder if image absent.
- **Stage C — Crossfade chain** (lines 340-356): Chains all main segments with `xfade=transition=fade:duration=1` → `main_concat.mp4`.
- **Stage D — Hook→main crossfade** (lines 358-389): Normalizes both to target resolution/SAR/pix_fmt, applies `xfade` at `hook_nominal_duration` → `video_only.mp4`.
- **Stage E — Audio mux** (lines 391-403): `ffmpeg -i video_only.mp4 -i audio/narration.mp3 -c:v copy -c:a aac -b:a 192k -shortest final.mp4`.

Settings consumed: `aspect_ratio`, `long_edge_px`, `framerate` (read in `14-render.ts:27-29`).

`exec` is `execFileSync("ffmpeg", ["-y", ...args])` — `-y` auto-overwrites.

`render/` directory is wiped and recreated at the start (`render.ts:226-227`).

---

### 11. Settings System

#### 11.1 Storage and access (`src/lib/settings.ts`)

- Single table `settings(key TEXT PK, value TEXT NOT NULL)` — all values stored as strings.
- `getSetting<K>(key, db?)` (`settings.ts:113-125`): asserts known key, fetches row, throws if not seeded, parses with `SETTING_SCHEMAS[key]`.
- `getAllSettings(db?)` (`settings.ts:129-147`): returns typed `AllSettings = { [K in SettingKey]: SettingValue<K> }`.
- `setSetting<K>(key, value, db?)` (`settings.ts:149-163`): `String(value)`, validate via Zod, `INSERT ... ON CONFLICT(key) DO UPDATE`.

`PATCH /api/settings` (`settings/route.ts:31-74`) wraps all updates in `db.transaction` — cross-field validation (e.g., act_distribution sum vs. chapter_count) rolls back the whole batch.

#### 11.2 Zod schema map by category (`src/lib/settings.ts:12-100`)

| Category | Keys |
|---|---|
| LLM / Content | `model_name`, `style_prompt_default`, `llm_provider` (enum: `"openrouter"`), `chapter_count`, `act_distribution`, `chapter_target_words` |
| TTS (AI33) | `tts_provider` (enum: `"ai33"`), `voice_id`, `voiceover_model_id` (4-value enum), `voice_stability`/`voice_similarity`/`voice_style` (0..1), `voice_speed` (0.7..1.2), `voice_use_speaker_boost` (boolean) |
| Image (ComfyUI) | `image_provider` (enum: `"comfyui"`), `comfyui_base_url`, `comfyui_workflow_path`, `comfyui_hook_video_workflow_path` |
| Render | `aspect_ratio` (enum: 4 values), `long_edge_px`, `framerate` (enum: `"30"\|"60"`) |
| Google Flow models | `google_flow_image_model` (enum: 3 values), `google_flow_video_model` (enum: 5 values), `google_flow_aspect_ratio` (enum: 2 values) |
| Google Flow accounts/dispatch | `google_flow_account_cooldown_hours`, `google_flow_max_retries`, `google_flow_dispatch_timeout_minutes`, `google_flow_relogin_needed`, `flow_create_project_failed` |
| Google Flow moderation | `google_flow_content_moderation_enabled`, `google_flow_content_moderation_max_rounds`, `google_flow_content_moderation_model` |
| Queue control | `queue_state` (enum: `"running"\|"paused"`) |

#### 11.3 Settings UI tabs (`src/app/settings/settings-form.tsx`)

Five tabs (`TAB_FIELDS` map at lines 49-87):

| Tab | Keys grouped here |
|---|---|
| `comfyui` | `image_provider`, `comfyui_base_url`, `comfyui_workflow_path`, `comfyui_hook_video_workflow_path` |
| `google-flow` | Models + aspect ratio + Advanced (cooldown, retries, dispatch timeout, content moderation) + embedded `<GoogleFlowAccounts>` table |
| `openrouter` | `llm_provider`, `model_name`, `style_prompt_default` |
| `ai33` | All voice settings |
| `render` | Aspect ratio, resolution, framerate, chapter count, act distribution, target words |

PATCH submits only the dirty diff (`dirtyDiff` at lines 93-104).

`GoogleFlowAccounts` (`src/app/settings/google-flow-accounts.tsx`) renders inside the `google-flow` tab; columns: Name (inline edit), Token (truncated), Enabled, Credits, Paused, Seen, Actions (Pause 4h / Pause indefinitely / Resume / Delete). Add account dialog shows the minted token + four URLs once.

#### 11.4 Per-video settings

There is no per-video settings table or column beyond the workflow-id and lifecycle fields. All provider parameters (voice, model, ComfyUI URL, Google Flow models, content-moderation rounds) are global.

---

### 12. Database Schema (full table inventory)

Defined inline in `src/lib/db.ts:90-177`. WAL mode, foreign keys on.

| Table | PK | Indexes | Notes |
|---|---|---|---|
| `videos` | `id` | none | columns described in section 2.4; `paused` and `deferred_until` added via additive migrations (`db.ts:184-204`) |
| `video_steps` | `(video_id, step_name)` | none | `status`, `started_at`, `finished_at` |
| `settings` | `key` | none | TEXT/TEXT |
| `google_flow_accounts` | `id` | UNIQUE on `token` | account fleet |
| `google_flow_queue` | `id` | `idx_google_flow_queue_pickup(status, priority, id)` | the queue; `moderation_round` added via additive migration (`db.ts:210-219`) |
| `google_flow_video_projects` | `(video_id, account_id)` | none | per-pair Flow project mapping |
| `moderation_events` | `id` | `idx_moderation_events_video_created(video_id, created_at)` | append-only history |

Foreign keys with `ON DELETE CASCADE`: `google_flow_queue.video_id`, `google_flow_video_projects.video_id`, `moderation_events.video_id`. `google_flow_queue.assigned_account_id` is `ON DELETE SET NULL`.

`workflow_id` on `videos` is a TEXT column with no FK — the workflow registry lives only in code.

---

### 13. Workflow UI Surface (Add/Edit Modal + Tables)

#### 13.1 Add/Edit Video Modal (`src/app/videos/add-video-modal.tsx`)

Three captured fields:
- `title` (required)
- `topic_info` (required, 6-row textarea)
- `workflow_id` (required, `<Select>` populated from `workflows` prop)

The workflow `<Select>` renders one `<SelectItem>` per workflow from `WORKFLOWS` (numbered `1. label`, `2. label`). No default pre-selection. In edit mode, pre-fills with current `workflow_id`.

POST `/api/videos` calls `getWorkflowById` server-side to reject unregistered IDs (`videos/route.ts:56-63`). PATCH `/api/videos/[id]` is allowed only if status is `"new"` or `"queued"`.

No language field. No length-target field. No per-video provider override.

#### 13.2 Videos List Page

Three sections from `useVideoPoller`:
- **Topics** — status `new`
- **Video queue** — status `queued | in_progress | failed`
- **Finished videos** — status `done`

The Video queue table (`video-queue-table.tsx`) columns:
- **Title**, **Workflow** (rendered via `workflowLabels()` lookup of `workflows` prop — `shortLabel` in cell, `label` in `title` attribute, lines 42-45), **Status**, **Step**, **Time**, **Actions**.

Status cell has special-case labels: `<DeletingLabel>`, `<PausingLabel>` (mid-flight after pause requested), `<PausedLabel>`, `<StatusBadge status>`.

Polling interval: 5000ms (`use-video-poller.ts:7`).

#### 13.3 No workflow-construction UI

There is no UI today for creating, editing, or composing workflows. Workflows are static code in `src/worker/workflows/index.ts`.

---

### 14. Repository Layer (`src/lib/repos/`)

| File | Entity | Public functions (selection) |
|---|---|---|
| `videos.ts` | Video | `findById`, `existsById`, `list`, `createNewVideo`, `setStatus`, `updateVideoDraft`, `setDeleteRequested`, `transitionNewToQueued`, `transitionAllNewToQueued`, `setCurrentStep`, `markFailed`, `markDone`, `clearFailure`, `resetToQueued`, `markInProgress`, `findOldestQueuedId`, `findInProgressId`, `findDeleteRequestedId`, `anyInProgressExists`, `readDeleteRequested`, `setDeferredUntil`, `clearDeferredUntil`, `setPaused`, `clearPaused`, `readPaused`, `deleteVideoFullyRemoved` |
| `steps.ts` | VideoStep | `findByVideo` (orphan-safe sort by workflow order), `getStatus`, `upsertPending`, `markRunning`, `markDone`, `markFailed`, `resetToPending`, `resetAllRunningToPending`, `deleteAllForVideo`, `runtimeSnapshots` |
| `google-flow.ts` | Accounts, Queue, VideoProjects, ModerationEvents | `listAccounts`, `findAccountById`, `findAccountByToken`, `insertAccount`, `deleteAccount`, `setAccountEnabled`, `pauseAccount`, `resumeAccount`, `updateAccountLastSeen`, `updateAccountCredits`, `firstAccountPausedUntil`, `anyAccountAvailable`, `enqueueTask`, `findTaskById`, `findTaskByExternalId`, `findOpenTaskForChunk`, `takeNextTaskForAccount`, `completeTask`, `failTask`, `bumpRetryCount`, `requeueTask`, `countByStatusForVideo`, `listFailedForVideo`, `listFailedContentPolicyForVideo`, `requeueWithNewPrompt`, `listDispatchedForVideo`, `resetAllDispatchedOnStartup`, `listStaleDispatched`, `findFlowProjectForAccount`, `upsertFlowProjectForAccount`, `clearFlowProjectForAccount`, `listFlowProjectsForVideo`, `insertModerationEvent`, `listModerationEventsForVideo` |

---

### 15. API Routes (excluding `api/flow/`)

| Route | Method | Notes |
|---|---|---|
| `/api/health` | GET | Liveness |
| `/api/settings` | GET | Returns `AllSettings` |
| `/api/settings` | PATCH | Transactional batch update with cross-field validation |
| `/api/videos` | GET | Returns `VideoListItem[]` + `queueState` + `flowCreateProjectFailed` |
| `/api/videos` | POST | Validates against workflow registry; status starts `new` |
| `/api/videos/[id]` | GET | Returns `{video, steps, artifacts, workflow_label, queueState}` |
| `/api/videos/[id]` | PATCH | Edit draft fields; allowed only for `new`/`queued` |
| `/api/videos/[id]` | DELETE | `new` → DB delete; `queued/failed` → dir + DB; `in_progress` → flag delete_requested (202); `done` → 400 |
| `/api/videos/[id]/start` | POST | `new → queued` |
| `/api/videos/start-all` | POST | Bulk `new → queued` |
| `/api/videos/[id]/pause` | POST | Sets `paused=1` on queued/in_progress |
| `/api/videos/[id]/resume` | POST | Clears paused |
| `/api/videos/[id]/retry` | POST | Failed only: reset `failed_step` to pending, clear failure, status `queued` |
| `/api/videos/[id]/restart` | POST | Failed/done only: delete project dir + step rows, reset to `queued` |
| `/api/videos/[id]/files/[...path]` | GET | Path-traversal-safe file serving |
| `/api/queue/pause`, `/api/queue/start` | POST | Toggle global `queue_state` setting |

---

## Architecture Patterns Found

These patterns are observed in the codebase. They are recorded here as facts about the current architecture.

### Pattern 1: Provider registry shape (used by LLM, TTS, image)

All three modules follow the same shape:
- A `types.ts` file with the abstract interface.
- An `index.ts` file with `const providers: Record<string, Provider> = {...}` and `getXProvider(name): Provider`.
- A single setting (`llm_provider`, `tts_provider`, `image_provider`) of type `z.enum([<one literal>])`.
- Resolution at pipeline boot in `resolveDeps` (`pipeline.ts:199-203`), then injection into every step via `StepContext.{chat, ttsProvider, imageProvider}`.

Currently each registry contains exactly one entry. Adding a new entry requires:
1. Implement the interface in `src/lib/<module>/<provider>.ts`.
2. Register in `src/lib/<module>/index.ts`.
3. Add the new literal to the Zod enum in `src/lib/settings.ts`.
4. Add an option to the UI `<Select>` in `src/app/settings/settings-form.tsx`.

### Pattern 2: Workflow as flat slug list, providers chosen at workflow registration time

The `Workflow.steps` array is a flat list of step slugs. Provider choice for image and video is encoded by selecting either `generate_main_images_comfyui` or `generate_main_images_google_flow` (and the matching hook step) at workflow-definition time. There is no per-step provider selector inside a workflow.

The Google Flow path bypasses the `image_provider` registry entirely — it is its own sub-system that writes directly to `<output_path>` via webhook-delivered files.

### Pattern 3: Step contract — `name`, `outputs`, `run`, optional `cleanup`

Every step is a Step object with these four fields. `step.outputs` declares paths relative to `projects/<videoId>/`; default cleanup is `rmSync` over each. Steps that need partial state preserved on failure either declare empty `outputs` (atomic-write convention) or provide a custom `cleanup`.

### Pattern 4: Filesystem as the artifact bus

Inter-step communication is exclusively through files in `projects/<videoId>/`. There is no message bus, typed loader, or in-memory shared state beyond `StepContext` (which carries only deps, not data). Each step encodes the input paths it needs into its body.

### Pattern 5: `DeferSignal` for queue-bound waits

Steps that depend on external work (Google Flow accounts becoming available, video pause requested) return `{ deferred: true, retryAfter: <unix_seconds> }`. The orchestrator stamps `videos.deferred_until` and exits. The runner re-picks the video when `deferred_until <= now`. Step status remains `running` during defer — re-entry re-executes the step body, which is responsible for its own idempotency.

### Pattern 6: Resume via on-disk markers

- `write_chapters` resumes by checking `existsSync` on each chapter file before its batch.
- `voiceover` resumes by reading `audio/.tts_task_id` (sidecar listed in `step.outputs` so failure cleanup wipes it).
- Google Flow steps resume via the in-DB queue: `findOpenTaskForChunk` plus on-disk output check before enqueuing.
- `enrich_chunks` rewrites `chunks.json` after each chunk so a partial run is not lost.

### Pattern 7: All settings global, validated by Zod, stored as strings

No per-video, per-workflow, or per-step settings exist. All settings are global rows in the single `settings` table. The Zod schema acts as both the type system and validation layer. Cross-field rules are enforced at the API layer in transactions (e.g., `act_distribution + chapter_count`).

### Pattern 8: Boot-time invariant validators

Both `validateWorkflowSteps` and `validateStepArtifactRules` run at module-load time inside `src/worker/steps/index.ts`. The pattern is "fail at startup, not mid-run."

### Pattern 9: Per-step inner function + thin shim

Every step file exports a `step` constant whose `run` method extracts fields from `ctx` and forwards to a private `runX(videoId, deps)` function with explicit dep injection. Tests construct fake `deps` and call `runX` directly; production calls `step.run` with the full `ctx`.

### Pattern 10: Dual hook pipeline

The hook section of the video is a fundamentally different artifact (mp4 clips) from the main section (still images turned into zoompan segments at render time). Two completely separate code paths produce them — there is no unified "video element" abstraction. The render stage mixes them into one final mp4 via crossfade.

---

## Code References

### Workflow Registry & Pipeline
- `src/worker/workflows/index.ts:11-16` — `Workflow` interface
- `src/worker/workflows/index.ts:18-28` — `SHARED_STEPS`
- `src/worker/workflows/index.ts:30-57` — `WORKFLOWS` array
- `src/worker/workflows/index.ts:59-61` — `getWorkflowById`
- `src/worker/pipeline.ts:23-31` — `StepContext`
- `src/worker/pipeline.ts:63-68` — `Step` interface
- `src/worker/pipeline.ts:70-77` — `isDeferSignal`
- `src/worker/pipeline.ts:116-130` — `buildStepContext`
- `src/worker/pipeline.ts:137-173` — `recordStepFailure`
- `src/worker/pipeline.ts:190-242` — `resolveDeps`
- `src/worker/pipeline.ts:244-334` — `runPipeline`
- `src/worker/runner.ts:50-75` — `pickNextVideo`
- `src/worker/runner.ts:96-118` — `tickOnce`
- `src/worker/runner.ts:146-161` — `runLoop`
- `src/worker/steps/index.ts:54-93` — boot validators

### Script Creation
- `src/worker/steps/01-research-outline.ts` — outline; computes `act_example`
- `src/worker/steps/02-research-characters.ts` — characters
- `src/worker/steps/03-write-hook.ts` — hook
- `src/worker/steps/04-write-chapters.ts` — chapter loop, structure extraction, story-so-far rolling summary
- `src/worker/steps/04-write-chapters.ts:31` — `BATCH_SIZE = 3`
- `src/worker/steps/04-write-chapters.ts:33` — `CHAPTER_BREAK = "---CHAPTER_BREAK---"`
- `src/worker/steps/04-write-chapters.ts:180-214` — `cleanJsonReply`
- `src/worker/steps/04-write-chapters.ts:219-227` — `writeFileAtomic`
- `src/worker/steps/05-assemble-script.ts:23-29` — em-dash sanitization
- `src/worker/steps/09-enrich-chunks.ts` — per-chunk enrichment loop

### LLM & Prompts
- `src/lib/llm/types.ts:3-20` — `ChatMessage`, `ChatOpts`, `LlmProvider`
- `src/lib/llm/index.ts:6-16` — registry
- `src/lib/llm/openrouter.ts:7` — endpoint
- `src/lib/llm/openrouter.ts:34-77` — model resolution, retry loop
- `src/lib/prompts.ts:16-51` — `render`, `loadSharedFragments`, `substitute`

### TTS
- `src/lib/tts/types.ts:3-19` — interface
- `src/lib/tts/index.ts:6-14` — registry
- `src/lib/tts/ai33.ts:24-27` — constants
- `src/lib/tts/ai33.ts:64-77` — `buildSubmitBody`
- `src/lib/tts/ai33.ts:79-119` — `submitTask`
- `src/lib/tts/ai33.ts:122-209` — `pollUntilReady`
- `src/lib/tts/ai33.ts:219-260` — sidecar I/O
- `src/lib/tts/ai33.ts:271-336` — `synthesize`
- `src/worker/steps/06-voiceover.ts:25-77` — voiceover step

### Image
- `src/lib/image/types.ts:3-12` — `ImageProvider`
- `src/lib/image/index.ts:6-16` — registry
- `src/lib/image/comfyui.ts:34-49` — `findPromptNode`
- `src/lib/image/comfyui.ts:52-62` — `findLatentNode`
- `src/lib/image/comfyui.ts:65-98` — output-node finders
- `src/lib/image/comfyui.ts:100-122` — `submitPrompt`
- `src/lib/image/comfyui.ts:130-183` — `pollUntilComplete`
- `src/lib/image/comfyui.ts:185-202` — `downloadImage`
- `src/lib/image/comfyui.ts:210-269` — `pollUntilCompleteVideo`
- `src/lib/image/comfyui.ts:283-337` — `generateHookVideoBatch`
- `src/lib/image/comfyui.ts:347-402` — `generateBatch`
- `prompts/comfyui/default-workflow.json` — bundled SDXL workflow
- `src/worker/steps/generate-main-images-comfyui.ts` — ComfyUI main images step
- `src/worker/steps/generate-hook-video-comfyui.ts` — ComfyUI hook video step

### Google Flow
- `src/worker/steps/google-flow-common.ts:66-108` — `runGoogleFlowStep`
- `src/worker/steps/google-flow-common.ts:119-157` — `enqueueChunks`
- `src/worker/steps/google-flow-common.ts:171-220` — `runModerationLoop`
- `src/worker/steps/google-flow-common.ts:229-248` — `aggregateFailures`
- `src/worker/steps/generate-main-images-google-flow.ts:19-29` — main images spec
- `src/worker/steps/generate-hook-video-google-flow.ts:19-29` — hook video spec
- `src/lib/flow-wait.ts:50-119` — `waitForFlowQueue`
- `src/lib/flow-watcher.ts:53-136` — reaper tick
- `src/lib/flow-auth.ts` — `resolveFlowAccount`
- `src/lib/flow-error-classify.ts:39-106` — error classification
- `src/lib/flow-media.ts:73-134` — `downloadToProjectPath`
- `src/lib/repos/google-flow.ts:146-184` — `enqueueTask`
- `src/lib/repos/google-flow.ts:244-274` — `takeNextTaskForAccount`
- `src/lib/repos/google-flow.ts:317-326` — `requeueTask`
- `src/lib/repos/google-flow.ts:433-442` — `resetAllDispatchedOnStartup`
- `src/app/api/flow/next-task/[token]/route.ts:42-130` — next-task dispatch
- `src/app/api/flow/submit-result/[token]/route.ts:176-285` — error routing + `acceptResult`
- `src/app/api/flow/accounts/route.ts:19-100` — account CRUD

### Render
- `src/lib/render.ts:27-45` — `computeResolution`
- `src/lib/render.ts:216-404` — `render`
- `src/worker/steps/14-render.ts:27-37` — render step entry

### Settings & Schema
- `src/lib/db.ts:11-46` — `DEFAULT_SETTINGS`
- `src/lib/db.ts:88-89` — pragmas
- `src/lib/db.ts:90-177` — schema DDL
- `src/lib/db.ts:184-219` — additive ALTER migrations
- `src/lib/db.ts:230-257` — data fixups for upgraded DBs
- `src/lib/settings.ts:12-100` — Zod schemas
- `src/lib/settings.ts:113-163` — `getSetting`, `getAllSettings`, `setSetting`

### UI
- `src/app/videos/add-video-modal.tsx:26-161` — Add/Edit modal
- `src/app/videos/video-queue-table.tsx:42-112` — workflow column + status cell logic
- `src/app/settings/settings-form.tsx:31-87` — tabs + `TAB_FIELDS`
- `src/app/settings/google-flow-accounts.tsx` — accounts management
- `src/app/api/videos/route.ts:42-63` — POST validation against workflow registry
- `src/app/api/videos/[id]/route.ts:69-97` — PATCH guard for `new`/`queued`

### Repos
- `src/lib/repos/videos.ts` — full video lifecycle
- `src/lib/repos/steps.ts` — step lifecycle
- `src/lib/repos/google-flow.ts` — accounts, queue, projects, moderation events
