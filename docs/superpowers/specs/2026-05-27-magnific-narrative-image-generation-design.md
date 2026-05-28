# Design: Magnific Nano Banana 2 narrative image provider

**Date:** 2026-05-27
**Author:** brainstorm + design session (Claude + user)
**Status:** Pending implementation plan
**Related skill:** `domain-magnific-coordinator`
**Branch base:** `master` (post-pacing merge)

## Context

The narrative pipeline's `generate_images` step currently dispatches via
the `image_provider` pinned on the workflow snapshot — `comfyui` or
`google_flow`. Magnific is wired only for the music-video kind via the
HITL `magnific_queue` flow; `magnificImageProviderStub.generateBatch`
throws "should not be reached."

The operator wants narrative image generation routed through Magnific to
use **Google Nano Banana 2** under their unlimited Magnific subscription,
bypassing Google Flow's account-fleet quota. Magnific exposes Nano
Banana 2 as one of its text-to-image models; throughput in the
operator's setup is ~3-4s per image serial (one image per Generate
click), which gives ~50 minutes for a 2-hour video — roughly tied with
Google Flow when Flow is not quota-blocked, and strictly better when it
is.

The operator also wants per-video organization in Magnific: each video
gets its own folder in the `/app/projects/work` area, named after the
video title, and all of that video's generated images land in it.

Character-reference identity lock is **deferred to v2** — explicitly
out of scope here.

## Scope

### In scope

1. **New `magnific_queue` mode `image-batch`** (`no_timeout=0`, reaper
   applies normal dispatch-age timeouts).
2. **New extension executor + content script** for `image-batch`:
   create-folder-if-missing → enter folder → fill prompt → optionally
   select Nano Banana 2 model → Generate → wait for one new
   `img[src*=cdnpk.net]` → harvest URL → submit.
3. **`MagnificImageProvider.generateBatch`** actually enqueues queue
   rows instead of throwing; coordinates per-chunk dispatch and awaits
   completion via the existing `waitForMagnificQueue` pattern.
4. **New worker step `generate_images_magnific`** (sibling of
   `generate_images_google_flow`) wired into the orchestrator's
   `resolveDeps` for narrative snapshots whose `image_provider` is
   `magnific`.
5. **Database migration:** new nullable column
   `videos.magnific_folder_id TEXT NULL` to cache the Magnific folder
   identifier after first creation, so subsequent rows for the same
   video skip the create step.
6. **Workflow registry entry** `narrative-magnific-nano-banana` with
   `image_provider='magnific'` and the existing narrative chunker/step
   list otherwise. Enabled by default.
7. **`next-task` route enhancement:** add `video_title` and
   `magnific_folder_id` to the per-row payload so the extension can
   ensure-folder-exists without a separate API call.
8. **Settings:** confirm `magnific_image_model` accepts a Nano Banana 2
   slug (free-text string per the existing schema; verify the slug
   Magnific's model picker displays — likely `Nano Banana 2` or
   `Gemini Nano Banana 2`).
9. **Dashboard progress panel** mirroring `FlowProgressPanel`, gated on
   `image_provider === 'magnific'` for the video's workflow snapshot.

### Out of scope

- **Character-reference identity lock.** Per operator decision — added in
  a follow-up spec. The first Magnific narrative runs will have visibly
  worse character consistency than Google Flow runs that use
  `imageInputs`; the operator accepts this for v1.
- **Multi-tab parallel Magnific.** Single Chrome tab, serial dispatch.
  Throughput is ~50min per 2-hour video, which the operator considers
  acceptable.
- **Best-of-N variation pick.** Nano Banana 2 returns 1 image per
  Generate click, so the auto-pick is trivial — harvest the single new
  variation.
- **Retries on Magnific failures.** Per the domain skill's "no
  auto-requeue" rule — failed rows surface as failed; operator retries
  from the dashboard.
- **Replacing Google Flow.** Both providers remain available. The
  operator picks per-video via workflow_id.
- **Magnific moderation loop.** Magnific doesn't refuse prompts the way
  Flow does; no moderation_round equivalent.
- **Music-video Magnific flow changes.** Image-hitl and image-to-video
  modes keep their existing behavior; `image-batch` is a parallel third
  mode.

## Architecture

```
videos table
   image_provider='magnific' (via workflow snapshot)
   magnific_folder_id ──┐  (cached after first folder creation)
                        │
                        ▼
       src/worker/steps/generate-images-magnific.ts
       calls MagnificImageProvider.generateBatch
                        │
                        ▼
       src/lib/image/magnific.ts
       generateBatch(chunks, video):
         for each chunk:
           enqueueTask({mode:'image-batch', video_id, chunk_id,
                        payload:{prompt, video_title, magnific_folder_id, model}})
         await waitForMagnificQueue(video_id)
                        │
                        ▼
       Extension polls /api/magnific/next-task/[token]
                        │
                        ▼
       Service worker dispatches to image-batch executor
                        │
                        ▼
       extensions/magnific-ext/src/executors/image-batch.js
       (sibling of image-hitl.js + image-to-video.js)
         1. ensureFolder(video_title, magnific_folder_id)
            - if folder_id supplied: navigate to /app/projects/work/<id>
            - else: create folder, harvest id, post back via submit-result
         2. openCreatePopover → click [data-cy=creating-popover-new-image]
         3. fillPrompt(prompt) via shared setNativeValue
         4. selectModel(magnific_image_model) via existing model picker
         5. clickGenerate
         6. waitForNewCdnpkVariation (snapshot-then-diff)
         7. submit-result with resultUrl + (first-time only) magnific_folder_id
                        │
                        ▼
       /api/magnific/submit-result/[token]
       - downloads variation to projects/<video_id>/images/<chunk_id>.png
       - if magnific_folder_id present in body: persist to videos row
       - flips row to submitted
                        │
                        ▼
       waitForMagnificQueue returns; step finishes
```

## Data model changes

### Migration: `src/lib/db.ts`

```sql
ALTER TABLE videos ADD COLUMN magnific_folder_id TEXT NULL;
```

Idempotent via the existing pragma-checked pattern. No default seed.

### `magnific_queue` mode enum

Extend `MagnificQueueMode` in `src/lib/repos/magnific.ts` to include
`image-batch` alongside `image-hitl` and `image-to-video`. The repo's
mode-keyed lookups (`findOpenTaskForVideo`, etc.) need no change — they
already take mode as a parameter. The cross-mode coexistence note in
the skill applies: `image-batch` rows can coexist with future
`image-hitl` or `image-to-video` rows on the same video, though for
narrative videos only `image-batch` rows will ever exist.

### `videos` interface (`src/types.ts`)

```ts
export interface Video {
  // ... existing fields
  magnific_folder_id: string | null;
}
```

### Settings

No schema change. `magnific_image_model` is already `z.string()`. The
v1 default stays whatever it is today; the operator sets the Nano
Banana 2 slug via Settings → Magnific. If the slug needs validation
later, it can graduate to an enum.

## Extension changes (`extensions/magnific-ext/`)

### New executor: `src/executors/image-batch.js`

Sibling of `image-hitl.js`. Registers under the `image-batch` mode in
`src/executors/index.js`. Lifecycle:

1. **Receive task** with payload `{prompt, video_title,
   magnific_folder_id, model, chunk_id}`.
2. **Ensure folder.** If `magnific_folder_id` is non-null, navigate to
   `/app/projects/work/<id>` (URL pattern verified at implementation).
   Else:
   - Navigate to `/app/projects/work`.
   - Click the "Create" button (text-based query — no `data-cy`).
   - Wait for popover, click `button[data-cy="creating-popover-new-folder"]`.
   - Wait for "New folder" modal, fill the name input with `video_title`.
   - Click the modal's blue "Create" button (text + class chain query).
   - Wait for folder tile to appear in grid, navigate into it.
   - Harvest the folder id from the URL (likely `/app/projects/work/<id>`)
     and stash it on the in-progress task — submit-result will include
     it in the body.
3. **Start image generation from inside folder.** Click "Create" again
   → click `button[data-cy="creating-popover-new-image"]` (pattern
   match — verify at implementation; the screenshot only confirmed
   the data-cy for "Folder", but the sibling "Image" button has the
   same `creating-popover-new-*` shape).
4. **Fill prompt** via existing `[data-cy=image-prompt-input]` + the
   `setNativeValue` helper from `content-shared.js`.
5. **Select model** via existing `[data-cy=tti-mode-selector-v3-trigger]`
   + prefix-match against the model setting value. This reuses the
   logic from `content-magnific.js`.
6. **Click Generate** via existing `button[data-cy=generate-button]`.
7. **Wait for new variation.** Snapshot-then-diff on
   `img[src*=cdnpk.net]` with the existing 200px size floor. Reuses
   the harvester from `content-magnific-i2v.js`.
8. **Submit result.** POST to `/api/magnific/submit-result/[token]` with
   `{resultUrl, magnific_folder_id?}`. The `magnific_folder_id` field
   is present only on the *first* row per video (when the extension
   just created the folder).

### Shared primitives reused

- `content-shared.js` helpers: `setNativeValue`, `editableFrom`,
  `waitFor`, `dumpDataCyAttributes`, `fillPrompt`.
- Variation harvester pattern from `content-magnific-i2v.js`.
- Model picker pattern from `content-magnific.js`.

No new shared helpers should be needed.

### Manifest changes

The current `host_permissions` entry `https://www.magnific.com/*`
already covers `/app/projects/work`. No manifest change required.

### Diagnostic logging

The executor emits `step=create-folder status=...`, `step=enter-folder
status=...`, `step=open-image-popover status=...`,
`step=fill-prompt status=...`, etc. on the same logging contract as
the existing executors. On a selector miss, dump the visible
`[data-cy]` inventory + a screenshot of failing context so the
operator can patch the selector list.

## Server-side changes

### Worker step: `src/worker/steps/generate-images-magnific.ts`

Sibling of `generate-images-google-flow.ts`. Structure:

```ts
export const step: Step = {
  name: "generate_images_magnific",
  module: "image",
  label: "Generate images via Magnific",
  inputs: ["chunks/chunks.json"],
  outputs: ["images/"],
  run: async (videoId, ctx) => {
    const video = videosRepo.findById(ctx.db, videoId);
    const chunks = JSON.parse(readFileSync(chunksPath, "utf-8"));
    const imageChunks = chunks.filter(c => c.kind === "image");
    await ctx.imageProvider.generateBatch(imageChunks, { videoId, video, ctx });
  },
};
```

The `imageProvider` is resolved by the orchestrator's `resolveDeps`
based on the workflow snapshot's `image_provider`; for snapshots that
pin `magnific`, the resolver returns the real `MagnificImageProvider`
(see below), not the stub.

### `MagnificImageProvider` (`src/lib/image/magnific.ts`)

Replace the throw with a real implementation:

```ts
class MagnificImageProvider implements ImageProvider {
  async generateBatch(chunks, { videoId, video, ctx }) {
    for (const chunk of chunks) {
      enqueueTask(ctx.db, {
        mode: "image-batch",
        video_id: videoId,
        chunk_id: chunk.id,
        payload: {
          prompt: chunk.prompt,
          video_title: video.title,
          magnific_folder_id: video.magnific_folder_id, // null on first row
          model: getSetting("magnific_image_model", ctx.db),
        },
      });
    }
    await waitForMagnificQueue(ctx.db, videoId, "image-batch", ctx.signal);
  }
}
```

`waitForMagnificQueue` already exists in the music-video flow with the
mode-keyed shape. The "image-batch" mode plugs in cleanly.

### Workflow registry: `narrative-magnific-nano-banana`

New row in `seedDefaultWorkflows` (or a `INSERT OR IGNORE` migration if
the seed is operator-edited):

```ts
{
  id: "narrative-magnific-nano-banana",
  label: "Narrative — Magnific (Nano Banana 2)",
  kind: "narrative",
  enabled: 1,
  script_llm_provider: "openrouter", // or claude_cli; mirrors the existing narrative workflows
  tts_provider: "elevenlabs",
  image_provider: "magnific",
  video_provider: null,
  music_provider: null,
  upscaler_provider: null,
  chunker_step: "chunk_images_only",
  steps: [
    "research_outline", "write_hook", "write_chapters",
    "write_story_so_far", "assemble_script",
    "voiceover", "align",
    "chunk_images_only", "generate_visual_prompts",
    "generate_images_magnific",
    "render",
    "cleanup",
  ],
}
```

### `next-task` route enhancement

`src/app/api/magnific/next-task/[token]/route.ts` already projects
queue payloads to the wire format. Add `video_title` and
`magnific_folder_id` to the projection for `image-batch` rows:

```ts
if (task.mode === "image-batch") {
  const video = videosRepo.findById(db, task.video_id);
  payload.video_title = video.title;
  payload.magnific_folder_id = video.magnific_folder_id;
}
```

### `submit-result` route enhancement

`src/app/api/magnific/submit-result/[token]/route.ts` accepts an
optional `magnific_folder_id` field for `image-batch` results. When
present, persist to the videos row via a new `setMagnificFolderId(db,
id, folderId)` helper. Idempotent — subsequent rows for the same
video that include the same `magnific_folder_id` are no-ops.

### Provider stub deprecation

`magnificImageProviderStub` is replaced by the real implementation. The
`magnific-music-video-magnific-suno` workflow snapshot's behavior is
unchanged because music-video steps dispatch through the queue
directly, not via `generateBatch` — see the skill's "provider stubs"
note. The stub-removal is a follow-up cleanup, not a v1 blocker.

## UI changes

### Dashboard progress panel

New `MagnificProgressPanel` component mirroring `FlowProgressPanel`,
gated on the video's workflow snapshot having
`image_provider === 'magnific'`. Displays:

- Folder created (yes/no, name)
- Queue depth (pending / dispatched / submitted / failed counts)
- Per-row status with chunk_id and current step
- Failed-row inline retry button

Hooks into the existing `/api/magnific/queue-summary/[videoId]`
endpoint with a small extension to surface folder state.

### Settings → Magnific tab

Existing tab gains a one-line note under `magnific_image_model`:

> For narrative videos, set this to your preferred Magnific text-to-image
> model (e.g. `Nano Banana 2`). The extension's model picker prefix-matches
> against this string.

No new field — the existing `magnific_image_model` setting carries the
slug.

## Error handling

| Failure | Surface | Behavior |
|---|---|---|
| Folder creation fails (selector miss) | Extension | Selector dump logged; submit-result with `error="folder_create_failed"`; queue row → failed; operator retries |
| Folder navigation fails (cached id stale because folder deleted in Magnific) | Extension | Detect via post-nav URL check; clear `magnific_folder_id` server-side via submit-result with `{magnific_folder_id: null, error: "folder_missing"}`; retry creates new folder |
| Image generation fails / variation never appears | Extension | Timeout via existing waitFor pattern; submit-result with error; row → failed |
| Magnific session expires mid-batch | Extension SW | Existing `session_expired` status event flips `magnific_relogin_needed`; queue rows after that point fail until operator re-logs in |
| Model picker can't find Nano Banana 2 | Extension | Existing prefix-match dump pattern; row → failed with diagnostic |
| New Image popover option's data-cy doesn't match the assumed pattern | Extension | Fallback: text-based query for "Image" button inside the popover |

No auto-retry. Per the domain skill, Magnific failures are operator-
actionable (dashboard retry) or terminal.

## Testing strategy

1. **`__tests__/unit/extensions/magnific-ext/content-image-batch.test.ts`** (new) —
   image-batch content script: folder creation flow, folder navigation by
   cached id, prompt fill, model selection, variation harvest. Mirror
   the existing `content-magnific.test.ts` / `content-magnific-i2v.test.ts`
   structure. Use jsdom + the existing test fixtures.

2. **`__tests__/unit/lib/image/magnific.test.ts`** (extend existing or new) —
   `MagnificImageProvider.generateBatch` enqueues one row per chunk
   with the right payload shape; awaits `waitForMagnificQueue`.

3. **`__tests__/api/magnific/next-task/route.test.ts`** (extend) —
   image-batch rows surface `video_title` + `magnific_folder_id` in the
   response payload.

4. **`__tests__/api/magnific/submit-result/route.test.ts`** (extend) —
   `magnific_folder_id` in the body persists to videos row; null clears.

5. **`__tests__/unit/worker/steps/generate-images-magnific.test.ts`** (new) —
   step reads chunks, filters image-kind, dispatches via
   `imageProvider.generateBatch`, completes.

6. **`__tests__/unit/lib/workflows.test.ts`** (extend) —
   `narrative-magnific-nano-banana` resolves with the right step list
   and image_provider.

7. **`__tests__/components/videos/[id]/magnific-progress-panel.test.tsx`** (new) —
   panel renders queue counts; failed row retry button calls the right
   endpoint.

## File-level deliverables

- `src/types.ts` — `Video` gains `magnific_folder_id`.
- `src/lib/db.ts` — ALTER TABLE migration; new workflow seed.
- `src/lib/repos/magnific.ts` — `MagnificQueueMode` extended with
  `image-batch`.
- `src/lib/repos/videos.ts` — `setMagnificFolderId` helper.
- `src/lib/image/magnific.ts` — real `MagnificImageProvider.generateBatch`.
- `src/lib/workflows.ts` — registry entry (or seed).
- `src/worker/steps/generate-images-magnific.ts` — new step.
- `src/worker/pipeline.ts` — register the new step.
- `src/app/api/magnific/next-task/[token]/route.ts` — payload projection.
- `src/app/api/magnific/submit-result/[token]/route.ts` — folder-id persistence.
- `src/app/videos/[id]/magnific-progress-panel.tsx` — new component.
- `src/app/videos/[id]/video-detail-client.tsx` — mount the new panel.
- `extensions/magnific-ext/manifest.json` — register the new executor
  script (no host change).
- `extensions/magnific-ext/src/executors/image-batch.js` — new executor.
- `extensions/magnific-ext/src/executors/index.js` — register.
- `extensions/magnific-ext/content-image-batch.js` — content script.
- All `__tests__/...` files listed above.

## Rollout / risk

- **Backwards compatibility:** New workflow, new queue mode, new
  column. Existing videos / workflows / queue rows untouched. The
  music-video Magnific flow is unaffected.
- **Selector fragility:** Three new selectors load-bear on Magnific's
  DOM (Create popover trigger, New Image option, modal Create button).
  All three have fallback queries (text-based or class-chain). If
  Magnific renames any data-cy in a future release, the diagnostic
  dump pattern surfaces it within one failed row.
- **No multi-tab parallelism:** Single-tab serial. Throughput estimate
  ~50min per 2-hour narrative video. Acceptable for the operator's
  v1 use case.
- **Character consistency regression:** Magnific narrative output
  will look visibly inconsistent across shots vs. the Flow path that
  uses `imageInputs`. v2 character-reference spec addresses this;
  operator accepts the v1 gap explicitly.
- **Magnific session expiry:** A multi-hour unattended run dies if
  the session times out. Existing `session_expired` handling flips
  the banner but does not auto-recover. Mitigation: operator monitors
  long runs; v2 may add session-pinging.
- **PR shape:** All commits prefixed `magnific-narrative:`. Estimated
  ~12-14 files touched + ~6 test files. Single PR off `master`
  post-pacing-merge.

## Implementation method

TDD per the existing pattern: red-green-refactor on each test in the
testing section, ordered:

1. Schema + types + workflow registry (foundation).
2. `MagnificImageProvider.generateBatch` + the worker step (server-side
   plumbing without the extension half).
3. `next-task` + `submit-result` payload enhancements.
4. Extension executor + content script (driven by the existing
   test-fixtures pattern with jsdom-mocked Magnific DOM).
5. Dashboard panel.

Manual smoke after each layer:

- After (2): assert queue rows materialize correctly via a real PATCH
  → worker pickup → row inspection.
- After (4): end-to-end against the live Magnific UI on one short
  test video (e.g. 60s narrative with 7-8 images). Verify the folder
  is created, images land inside, and the harvest URL matches.

PR title: `magnific-narrative: per-video Magnific Nano Banana 2 image
generation with folder isolation`.
