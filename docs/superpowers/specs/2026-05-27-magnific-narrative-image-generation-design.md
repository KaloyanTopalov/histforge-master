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
gets its own **Project** in the `/app/projects` area, named after the
video title, and all of that video's generated images land in it.

> **Revised 2026-05-28 after a live probe.** The original draft modeled the
> per-video unit on a `/app/projects/work` "Create" popover with create-new
> menu options that a live probe found do not exist. The real per-video unit
> is a Magnific **Project** (URL `/app/projects/<uuid>`, id is a UUID v4),
> and generation is scoped to the **current Project** (there is no
> per-generation "save here" picker). The sections below are rewritten
> against the real model; the server-side plumbing (worker step, provider,
> routes, tests) is unchanged apart from the `magnific_folder_id` →
> `magnific_project_id` rename. Evidence: the
> `project-magnific-narrative-folder-model-disproven` memory and the
> `probe/magnific-folder-context` branch artifacts.

Character-reference identity lock is **deferred to v2** — explicitly
out of scope here. (The probe confirmed the generator exposes Style /
Character / Add reference slots — `[data-cy="reference-style-placeholder"]`,
`reference-character-placeholder`, `reference-add-button`, up to 14 inputs —
which is the DOM hook the v2 character-lock spec will build on.)

## Scope

### In scope

1. **New `magnific_queue` mode `image-batch`** (`no_timeout=0`, reaper
   applies normal dispatch-age timeouts).
2. **New extension executor + content script** for `image-batch`:
   ensure-project-exists → set + VERIFY current Project → launch the image
   generator → turn off the smart-prompt toggle → fill prompt → select
   Nano Banana 2 model → Generate → wait for one new `img[src*=cdnpk.net]`
   (diff on the numeric render id, not the filename) → harvest URL → submit.
3. **`MagnificImageProvider.generateBatch`** actually enqueues queue
   rows instead of throwing; coordinates per-chunk dispatch and awaits
   completion via the existing `waitForMagnificQueue` pattern.
4. **New worker step `generate_images_magnific`** (sibling of
   `generate_images_google_flow`) wired into the orchestrator's
   `resolveDeps` for narrative snapshots whose `image_provider` is
   `magnific`.
5. **Database migration:** new nullable column
   `videos.magnific_project_id TEXT NULL` to cache the Magnific Project
   UUID after first creation, so subsequent rows for the same video skip
   the create step.
6. **Workflow registry entry** `narrative-magnific-nano-banana` with
   `image_provider='magnific'` and the existing narrative chunker/step
   list otherwise. Enabled by default.
7. **`next-task` route enhancement:** add `video_title` and
   `magnific_project_id` to the per-row payload so the extension can
   ensure-project-exists without a separate API call.
8. **Settings:** confirm `magnific_image_model` accepts the Nano Banana 2
   slug (free-text string per the existing schema). The probe confirmed
   the model picker displays **"Google Nano Banana 2"** (picker item
   `[data-cy="ai-model-item-slim-imagen-nano-banana-2-flash"]`).
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
   magnific_project_id ─┐  (cached after first Project creation; UUID v4)
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
                        payload:{prompt, video_title, magnific_project_id, model}})
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
         1. ensureProject(video_title, magnific_project_id)
            - if project_id supplied: navigate to /app/projects/<uuid>
            - else: create Project (new-project-card → name modal →
              "Create"), harvest the UUID from the URL, post it back
              via submit-result
         2. set + VERIFY current Project — read
            [data-cy=header-current-project-link]; if it doesn't match the
            target UUID, do NOT generate → submit-result
            error="wrong_project_active", row → failed
         3. launch generator: [data-cy=topbar-start-creating-button] →
            [data-cy=registered-tool-ai-image-generator]
         4. turn OFF [data-cy=smart-prompt-toggle]; fillPrompt(prompt)
            into [data-cy=image-prompt-input] (contenteditable div)
         5. selectModel → [data-cy=tti-mode-selector-v3-trigger] →
            [data-cy=ai-model-item-slim-imagen-nano-banana-2-flash]
         6. clickGenerate → button[data-cy=generate-button]
         7. waitForNewCdnpkVariation (snapshot-then-diff on the numeric
            render id in pikaso.cdnpk.net/.../<numericId>/render.png)
         8. submit-result with resultUrl + (first-time only) magnific_project_id
                        │
                        ▼
       /api/magnific/submit-result/[token]
       - downloads variation to projects/<video_id>/images/<chunk_id>.png
       - if magnific_project_id present in body: persist to videos row
       - flips row to submitted
                        │
                        ▼
       waitForMagnificQueue returns; step finishes
```

## Data model changes

### Migration: `src/lib/db.ts`

```sql
ALTER TABLE videos ADD COLUMN magnific_project_id TEXT NULL;
```

Idempotent via the existing pragma-checked pattern. No default seed.

> **`magnific_project_id` is a Magnific Project UUID v4** (URL
> `/app/projects/<uuid>`). Magnific's hierarchy is **Project → Folders →
> assets**; we use **one Project per video** for isolation. Magnific's
> sub-folder layer is a *manual* organization feature we do **not** use —
> the image generator scopes output to the current *Project* and cannot
> target a sub-folder.

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
  magnific_project_id: string | null; // Magnific Project UUID v4
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
`src/executors/index.js`. Lifecycle (selectors confirmed live 2026-05-28):

1. **Receive task** with payload `{prompt, video_title,
   magnific_project_id, model, chunk_id}`.
2. **Ensure Project.** If `magnific_project_id` is non-null, navigate to
   `/app/projects/<uuid>`. Else:
   - Navigate to `/app/projects/work`.
   - Dismiss the cookie-consent banner if present (it can intercept clicks).
   - Click the create-project entry `[data-cy="new-project-card"]` (or the
     sidebar `[data-cy="v3-create-project-button"]`).
   - In the "New Project" modal (note: **not** a `[role=dialog]`), fill the
     name input `input[placeholder*="Enter a name for your project"]` with
     `video_title`. Access defaults to "Private" — leave it.
   - Click the modal's primary **"Create"** button — text-based, it has
     **no `data-cy`** (distinct from the header
     `[data-cy="projects-work-header-create-button"]`).
   - Magnific navigates into the new Project at `/app/projects/<uuid>`.
     Harvest the UUID from the URL and stash it on the in-progress task —
     submit-result will include it in the body.
3. **Set + VERIFY current Project (load-bearing).** Read
   `[data-cy="header-current-project-link"]`; if its target does not match
   the task's Project UUID, switch via
   `[data-cy="project-tree-dropdown-trigger"]`. If it still does not match,
   **do NOT generate** — submit-result with `error="wrong_project_active"`,
   row → failed. Generation is scoped to the *current* Project; skipping
   this risks dumping one video's images into another's Project.
4. **Launch the image generator from inside the Project.** Click
   `[data-cy="topbar-start-creating-button"]` → click
   `[data-cy="registered-tool-ai-image-generator"]`. This lands on the
   global `/app/ai-image-generator`, but the current-Project context
   carries over from the Project you launched from — re-read
   `header-current-project-link` after the generator loads to be safe.
5. **Turn OFF the smart-prompt toggle.** `[data-cy="smart-prompt-toggle"]`
   ("AI prompt") is **ON by default** and rewrites/expands the prompt —
   bad for literal storyboard prompts. Toggle it off before filling.
6. **Fill prompt** via `[data-cy="image-prompt-input"]`. **Note:** this is
   a **contenteditable `<div>`**, not a textarea/input — `setNativeValue`
   does not apply; set `textContent` + dispatch `InputEvent('input')`, i.e.
   `fillPrompt`'s contenteditable branch in `content-shared.js`.
7. **Select model** via `[data-cy="tti-mode-selector-v3-trigger"]`
   (defaults to "Auto") → click
   `[data-cy="ai-model-item-slim-imagen-nano-banana-2-flash"]` (display
   "Google Nano Banana 2"); type into the picker's search first if the item
   isn't visible. Nano Banana 2 defaults to **1 image** per Generate.
8. **Click Generate** via `button[data-cy="generate-button"]`.
9. **Wait for new variation.** Snapshot-then-diff on `img[src*=cdnpk.net]`
   with the existing 200px size floor. Results are served from
   `pikaso.cdnpk.net/.../<numericId>/render.png` — **diff on the numeric
   path segment, NOT the filename** (every result is `render.png`, so a
   basename diff matches nothing new).
10. **Submit result.** POST to `/api/magnific/submit-result/[token]` with
    `{resultUrl, magnific_project_id?}`. The `magnific_project_id` field is
    present only on the *first* row per video (when the extension just
    created the Project).

### Shared primitives reused

- `content-shared.js` helpers: `editableFrom`, `waitFor`,
  `dumpDataCyAttributes`, `fillPrompt`. **`fillPrompt` already handles the
  contenteditable case** — `image-prompt-input` is a `<div>`, so it takes
  the `textContent` + `InputEvent` branch, not the `setNativeValue`
  textarea/input branch.
- Variation harvester pattern from `content-magnific-i2v.js`, **adapted to
  diff on the numeric render id** (`pikaso.cdnpk.net/.../<numericId>/render.png`)
  rather than the URL string, since every result shares the `render.png`
  basename.
- Model picker pattern from `content-magnific.js`, targeting the
  `[data-cy="ai-model-item-slim-imagen-nano-banana-2-flash"]` item.

No new shared helpers should be needed.

### Manifest changes

The current `host_permissions` entry `https://www.magnific.com/*`
already covers `/app/projects/work`. No manifest change required.

### Diagnostic logging

The executor emits `step=ensure-project status=...`, `step=verify-project
status=...`, `step=launch-generator status=...`, `step=smart-prompt-off
status=...`, `step=fill-prompt status=...`, `step=select-model status=...`,
`step=generate status=...`, etc. on the same logging contract as the
existing executors. On a selector miss, dump the visible `[data-cy]`
inventory + a screenshot of failing context so the operator can patch the
selector list.

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
          magnific_project_id: video.magnific_project_id, // null on first row
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
`magnific_project_id` to the projection for `image-batch` rows:

```ts
if (task.mode === "image-batch") {
  const video = videosRepo.findById(db, task.video_id);
  payload.video_title = video.title;
  payload.magnific_project_id = video.magnific_project_id;
}
```

### `submit-result` route enhancement

`src/app/api/magnific/submit-result/[token]/route.ts` accepts an
optional `magnific_project_id` field for `image-batch` results (and the
`error="wrong_project_active"` / `error="project_create_failed"` failure
cases). When present, persist to the videos row via a new
`setMagnificProjectId(db, id, projectId)` helper. Idempotent — subsequent
rows for the same video that include the same `magnific_project_id` are
no-ops.

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

- Project created (yes/no, name + UUID)
- Queue depth (pending / dispatched / submitted / failed counts)
- Per-row status with chunk_id and current step
- Failed-row inline retry button

Hooks into the existing `/api/magnific/queue-summary/[videoId]`
endpoint with a small extension to surface Project state.

### Settings → Magnific tab

Existing tab gains a one-line note under `magnific_image_model`:

> For narrative videos, set this to your preferred Magnific text-to-image
> model (e.g. `Google Nano Banana 2`, picker item
> `[data-cy="ai-model-item-slim-imagen-nano-banana-2-flash"]`). The
> extension's model picker prefix-matches the display name against this
> string.

No new field — the existing `magnific_image_model` setting carries the
slug.

## Error handling

| Failure | Surface | Behavior |
|---|---|---|
| Project creation fails (selector miss) | Extension | Selector dump logged; submit-result with `error="project_create_failed"`; queue row → failed; operator retries |
| Project navigation fails (cached UUID stale because Project deleted in Magnific) | Extension | Detect via post-nav URL check; clear `magnific_project_id` server-side via submit-result with `{magnific_project_id: null, error: "project_missing"}`; retry creates a new Project |
| **Wrong Project active at generate time** | Extension | After set-current-Project, `[data-cy=header-current-project-link]` does not match the task UUID → **do NOT generate**; submit-result with `error="wrong_project_active"`; row → failed (prevents polluting another video's Project) |
| Image generation fails / variation never appears | Extension | Timeout via existing waitFor pattern; submit-result with error; row → failed |
| Magnific session expires mid-batch | Extension SW | Existing `session_expired` status event flips `magnific_relogin_needed`; queue rows after that point fail until operator re-logs in |
| Model picker can't find Nano Banana 2 | Extension | Existing prefix-match dump pattern (target `[data-cy=ai-model-item-slim-imagen-nano-banana-2-flash]`); row → failed with diagnostic |

No auto-retry. Per the domain skill, Magnific failures are operator-
actionable (dashboard retry) or terminal.

## Testing strategy

1. **`__tests__/unit/extensions/magnific-ext/content-image-batch.test.ts`** (new) —
   image-batch content script: Project creation flow, Project navigation by
   cached UUID, current-Project verify-gate, prompt fill, model selection,
   variation harvest. Mirror
   the existing `content-magnific.test.ts` / `content-magnific-i2v.test.ts`
   structure. Use jsdom + the existing test fixtures.

2. **`__tests__/unit/lib/image/magnific.test.ts`** (extend existing or new) —
   `MagnificImageProvider.generateBatch` enqueues one row per chunk
   with the right payload shape; awaits `waitForMagnificQueue`.

3. **`__tests__/api/magnific/next-task/route.test.ts`** (extend) —
   image-batch rows surface `video_title` + `magnific_project_id` in the
   response payload.

4. **`__tests__/api/magnific/submit-result/route.test.ts`** (extend) —
   `magnific_project_id` in the body persists to videos row; null clears.

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

- `src/types.ts` — `Video` gains `magnific_project_id`.
- `src/lib/db.ts` — ALTER TABLE migration; new workflow seed.
- `src/lib/repos/magnific.ts` — `MagnificQueueMode` extended with
  `image-batch`.
- `src/lib/repos/videos.ts` — `setMagnificProjectId` helper.
- `src/lib/image/magnific.ts` — real `MagnificImageProvider.generateBatch`.
- `src/lib/workflows.ts` — registry entry (or seed).
- `src/worker/steps/generate-images-magnific.ts` — new step.
- `src/worker/pipeline.ts` — register the new step.
- `src/app/api/magnific/next-task/[token]/route.ts` — payload projection.
- `src/app/api/magnific/submit-result/[token]/route.ts` — project-id persistence.
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
- **Selector fragility:** The executor load-bears on Magnific's v3 DOM
  hooks — `new-project-card`, the no-`data-cy` modal "Create" button,
  `header-current-project-link`, `project-tree-dropdown-trigger`,
  `topbar-start-creating-button`, `registered-tool-ai-image-generator`,
  `smart-prompt-toggle`, `image-prompt-input`,
  `tti-mode-selector-v3-trigger`,
  `ai-model-item-slim-imagen-nano-banana-2-flash`, `generate-button`. All
  were confirmed live on 2026-05-28, but Magnific ships UI changes; the
  diagnostic `[data-cy]` dump surfaces a rename within one failed row.
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
  test video (e.g. 60s narrative with 7-8 images). Verify the Project
  is created, the current-Project verify-gate passes, images land inside
  the Project, and the harvest URL matches.

PR title: `magnific-narrative: per-video Magnific Nano Banana 2 image
generation with Project isolation`.
