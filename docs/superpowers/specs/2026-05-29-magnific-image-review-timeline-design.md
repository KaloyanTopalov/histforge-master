# Design: Magnific narrative image review timeline

**Date:** 2026-05-29
**Author:** design session (Claude + user)
**Status:** Pending implementation plan
**Related specs:**
- `2026-05-27-magnific-narrative-image-generation-design.md` (the producer this view consumes)
- `2026-05-27-magnific-playwright-runtime-design.md` (the runtime executing dispatches)
**Branch base:** `master` (post-PR #12 merge — see Rollout)

## Context

S1–S4 of the magnific-narrative arc shipped the producer: HistForge enqueues image-batch rows, the Playwright runtime drives Magnific, Nano Banana 2 generates 16:9 images, they land in a per-video Project, and files are downloaded to `projects/<videoId>/images/<chunkId>.png`. Three carry-forwards remain:

1. **Failure→render gap** (S2): `generate_images` returns success even when some image-batch rows ended `failed`. The pipeline can proceed to render with missing or bad images.
2. **Row-1 cold-tab failure**: first dispatch on a fresh `/app/projects/work` tab fails at `await-row`. Recoverable via resume idempotency, but requires an operator-visible retry path.
3. **No operator review surface**: a 20-30 min narrative video has 200-300 generated images. Currently the operator has no way to see which images failed, which look wrong, or to regenerate individual images without re-running the whole step.

S5 addresses all three by building the image review timeline that was originally scoped as a small `MagnificProgressPanel`. The operator decision to scale narrative to 20-30 min videos (~200-300 images per video) changes the panel from a status indicator into a primary operator workflow surface.

## Scope

### In scope

1. **New `ImageReviewTimeline` component** mounted on the video detail page when the workflow's `image_provider === 'magnific'`. Replaces the originally-scoped `MagnificProgressPanel`.
2. **Virtualized thumbnail grid.** Renders only visible thumbnails (window-based virtualization) to remain responsive at 300+ images.
3. **Per-thumbnail visual status:** `done` (no border), `failed` (red border + ❌ overlay), `pending` (gray + spinner), `dispatched` (gray + dim). Status read from `magnific_queue` rows.
4. **Count summary** at the top of the timeline: `N done, M failed, K pending` — visible without scrolling.
5. **"Jump to next failed" button** — scrolls the timeline to the next thumbnail with `failed` status, looping to top.
6. **Click thumbnail → fullscreen preview** showing the image at native resolution with the prompt that generated it, the chunk_id, and a "Regenerate this image" button.
7. **Per-image regenerate:** new API endpoint `POST /api/videos/[id]/regenerate-image` accepting `chunk_id`. Behavior: deletes the existing output file (`projects/<videoId>/images/<chunkId>.png`), failed-or-deletes any existing image-batch row for that chunk's `output_path`, enqueues a fresh image-batch row. The next worker pickup dispatches it. The timeline reflects the status change via the live-update poll.
8. **Live updates during generation.** Timeline polls `/api/magnific/queue-summary/[videoId]` every 3 seconds while there are pending/dispatched rows. New thumbnails appear as `done` rows land; status indicators flip in place. Stops polling when all rows are terminal (done/failed).
9. **Render-gate awareness.** Above the timeline, a "Ready to render" indicator that's green only when *all* image chunks have a `done` row and the file exists on disk. Red with explanatory text when any image is missing/failed/pending. This addresses the S2 failure→render gap by surfacing it visually before the operator clicks render.

### Out of scope

- **Per-image prompt editing.** Operator can regenerate with the same prompt (handles generation flakes) but cannot edit the prompt to fix a bad-prompt image in v1. If prompts are systemically bad, the operator fixes them upstream (script step) and re-runs `generate_visual_prompts` + `generate_images`. v2 spec addresses inline prompt editing.
- **Side-by-side comparison / alternate variations.** Nano Banana 2 returns 1 image per click; multi-variation pick is a v2 concern.
- **Filtering by status.** "Show only failed" is a one-button "Jump to next failed" instead. Filters add to v2 if operators ask for them after real use.
- **Bulk operations.** No "regenerate all failed" or "regenerate selected." Each retry is per-image, click-to-trigger. If 50 images failed, the operator clicks 50 times (or runs the worker step with resume idempotency, which already handles this case). Bulk UI is a v2 concern.
- **Image inspection / annotation.** No notes, no flagging, no rating per image. Pure binary "is this acceptable" → regenerate or keep.
- **Other providers.** This timeline is Magnific-narrative specific. Google Flow + ComfyUI image runs use their existing progress panels; S5 does not touch them.
- **Editing the script or prompts mid-run.** The script step and `generate_visual_prompts` step are upstream of `generate_images`; S5 is downstream of all of them.

## Architecture

```
videos table
  workflow_id resolves to image_provider='magnific'
                        │
                        ▼
src/app/videos/[id]/page.tsx
  conditionally mounts <ImageReviewTimeline videoId={id}/>
                        │
                        ▼
ImageReviewTimeline
  ├── fetches /api/videos/[id]/image-timeline (initial load: chunks + queue rows + file existence)
  ├── polls /api/magnific/queue-summary/[id] every 3s while pending/dispatched > 0
  ├── renders count summary + jump-to-failed + virtualized grid (react-window or similar)
  ├── click thumbnail → opens <ImagePreviewModal/>
  │     ├── shows image at native size + prompt + chunk_id
  │     └── "Regenerate" → POST /api/videos/[id]/regenerate-image {chunk_id}
  └── render-gate indicator (computed client-side from timeline state)

API surface (3 endpoints, 1 new + 1 new + 1 existing-extended):
  GET  /api/videos/[id]/image-timeline   — NEW. Returns array of {chunk_id, prompt, status, file_url?, error?}.
  POST /api/videos/[id]/regenerate-image — NEW. Body {chunk_id}. Deletes file + row, enqueues fresh row.
  GET  /api/magnific/queue-summary/[id]  — EXISTING, extended to include per-chunk_id status if not already.
```

## Data model changes

**No new tables, no new columns.** The timeline is a read+write view over existing state:

- Chunks come from `projects/<videoId>/chunks/chunks.json` (already produced by `chunk_images_only`).
- Per-chunk prompts come from the visual prompts written by `generate_visual_prompts` (already produced).
- Per-chunk status comes from `magnific_queue` rows joined on `output_path` matching `images/<chunkId>.png`.
- File-on-disk check is `existsSync(projects/<videoId>/images/<chunkId>.png)`.

This is the same source-of-truth set that `MagnificImageProvider.generateBatch`'s resume idempotency uses (S2). The timeline reuses that logic.

## API routes

### `GET /api/videos/[id]/image-timeline` (new)

Returns:

```ts
{
  videoId: string,
  chunks: Array<{
    chunk_id: string,
    prompt: string,
    status: "done" | "failed" | "pending" | "dispatched" | "not_started",
    file_url: string | null,      // /projects/<id>/images/<chunkId>.png if exists, else null
    error: string | null,         // failed row's reason, if any
    queue_row_id: number | null,  // for debugging / future ops
  }>,
  ready_to_render: boolean,       // true iff every chunk has status="done" AND file_url
  counts: { done: number, failed: number, pending: number, dispatched: number, not_started: number },
}
```

Auth follows the existing video-detail route pattern.

### `POST /api/videos/[id]/regenerate-image` (new)

Body:
```ts
{ chunk_id: string }
```

Behavior:
1. Validate the chunk_id exists in `chunks.json` for this video.
2. Delete the file at `projects/<videoId>/images/<chunkId>.png` if present.
3. Find any existing `magnific_queue` row for this video where `output_path = "images/<chunkId>.png"`. If found, mark it `failed` (terminal). Do not delete the row — keep it for audit. Add a column-less marker via the `error` field: `error="superseded_by_regenerate"`.
4. Enqueue a fresh image-batch row with the same prompt and output_path.
5. Return `{ success: true, new_queue_row_id: <id> }`.

Worker picks it up on the next tick. Timeline polling reflects the status change.

Auth follows the existing video-detail mutation pattern.

### `GET /api/magnific/queue-summary/[id]` (existing, may need extension)

Confirm in plan-mode whether the existing endpoint surfaces per-chunk status. If yes, reuse. If no, extend to include per-`output_path` row state so the timeline can update individual thumbnails without re-fetching `image-timeline` on every poll.

## UI components

### `src/app/videos/[id]/image-review-timeline.tsx` (new)

Top-level component. Props: `{ videoId: string }`.

Structure:
- `<TimelineHeader>` — count summary + jump-to-failed button + render-gate indicator
- `<VirtualizedThumbnailGrid>` — uses `react-window` (or equivalent already in the project — check first). Each cell is a `<Thumbnail>` (image + status overlay). Clicking opens the preview modal.
- `<ImagePreviewModal>` — appears on thumbnail click. Shows large image + prompt + chunk_id + "Regenerate" button + close.

State:
- `chunks: ChunkTimelineEntry[]` — from `/api/videos/[id]/image-timeline`
- `pollingActive: boolean` — true when any chunk is pending/dispatched
- `selectedChunkId: string | null` — for the modal

Polling:
- `useEffect`: poll every 3s while `pollingActive`. Stop when no rows are pending/dispatched. Resume polling for 10s after a regenerate click (to catch the new row going from pending → dispatched → done).
- Pause polling when `document.visibilityState === "hidden"` (mirrors the runtime-status pill pattern from earlier work).

### `src/app/videos/[id]/video-detail-client.tsx` (modified)

Conditionally mount `<ImageReviewTimeline videoId={id}/>` when:
- The video's workflow snapshot has `image_provider === 'magnific'`
- The video has progressed past `chunk_images_only` (chunks.json exists)

Otherwise, leave existing UI unchanged. Other providers' panels are untouched.

### `src/app/videos/[id]/thumbnail.tsx` (new)

Small reusable component. Props: `{ chunk: ChunkTimelineEntry, onClick: () => void }`. Renders:
- The image if `file_url`, else a placeholder
- Status overlay: `failed` → red border + ❌ icon, `pending` → gray + spinner, `dispatched` → gray + dim, `done` → no overlay, `not_started` → light gray placeholder
- A small chunk index label (e.g. "1/287") for navigation context

## Render-gate indicator behavior

Above the timeline, a single banner:

- **All done:** green check + "Ready to render — 287/287 images generated." Render button enabled.
- **Some failed:** red banner + "3 images failed — fix before rendering" with "Jump to next failed" pre-focused. Render button **disabled** with a tooltip explaining why.
- **Some pending:** yellow banner + "Generating — 234/287 images done. Render available when complete." Render button disabled.
- **All not_started:** neutral banner + "Generate images first" with a link to start the step.

This addresses S2's deferred decision: the operator literally cannot click render with missing images. The check is at the UI layer (disable + tooltip) AND at the render-step layer (precheck — see below).

### Render-step precheck (server-side enforcement)

Add a precheck at the start of the `render` step: count expected images (from `chunks.json`) vs. present files. If missing, throw `RenderPrecheckError` with a clear message naming the missing chunk_ids. This is the server-side belt-and-suspenders for the client-side gate above; an operator who somehow bypasses the disabled button (direct API call, scripted automation) still can't render incomplete output.

The `RenderPrecheckError` surfaces in the standard step-error UI; the operator returns to the timeline to fix.

## Error handling

| Failure | Surface | Behavior |
|---|---|---|
| `/image-timeline` 500 | Timeline | Shows error banner with retry button; does not crash the rest of video-detail |
| `/regenerate-image` failed (chunk_id not found) | Modal | Inline error in modal; does not close; operator can dismiss |
| Poll fails | Timeline | Silent retry next tick; no banner unless 3 consecutive fails (then show "Connection issue, retrying...") |
| Regenerate enqueued but worker not running | Timeline | New row appears as `pending`, never advances. After 60s, surfaces "Worker may be stopped — check pipeline status" hint |
| Image file exists but `done` row missing | Timeline | Shown as `done` with `file_url` (file is the source of truth); reconciles to a row on next regenerate if needed |
| `done` row exists but file missing | Timeline | Shown as `failed` with error "file_missing — regenerate"; mismatched-state recovery |
| Render-step precheck fails | Step error UI | Lists missing chunk_ids; operator returns to timeline |

## Testing strategy

1. **`__tests__/api/videos/[id]/image-timeline/route.test.ts` (new)** — `GET` returns the right shape for: all done, mixed, all not-started; counts compute correctly; `ready_to_render` only true when every chunk has done+file.

2. **`__tests__/api/videos/[id]/regenerate-image/route.test.ts` (new)** — `POST` with valid chunk_id deletes file (if exists), supersedes existing row, enqueues fresh; invalid chunk_id returns 400; idempotent on rapid double-click (returns the existing fresh row).

3. **`__tests__/components/videos/[id]/image-review-timeline.test.tsx` (new)** — renders count summary; jump-to-failed scrolls to next failed; thumbnail click opens modal; regenerate click POSTs the right endpoint; polling pauses on hidden tab; status overlays render per-state.

4. **`__tests__/components/videos/[id]/thumbnail.test.tsx` (new)** — per-state visual rendering (failed shows red border + ❌; pending shows spinner; etc.).

5. **`__tests__/unit/worker/steps/render.test.ts` (extend)** — RenderPrecheckError thrown when image files missing; clear message names the missing chunk_ids.

6. **Smoke (extend existing magnific-narrative-smoke or new)** — after a successful smoke run, GET `/api/videos/[testVideoId]/image-timeline` and assert counts match what the smoke produced; assert `ready_to_render=true` after all rows complete; gated by `RUN_MAGNIFIC_NARRATIVE=1` (no live browser needed).

No live-browser smoke for S5 — the timeline is server-data-driven, jsdom + server-smoke covers it.

## File-level deliverables

- `src/app/api/videos/[id]/image-timeline/route.ts` — new GET endpoint.
- `src/app/api/videos/[id]/regenerate-image/route.ts` — new POST endpoint.
- `src/app/videos/[id]/image-review-timeline.tsx` — new top-level component.
- `src/app/videos/[id]/thumbnail.tsx` — new sub-component.
- `src/app/videos/[id]/image-preview-modal.tsx` — new modal.
- `src/app/videos/[id]/video-detail-client.tsx` — conditional mount of the timeline.
- `src/lib/repos/magnific.ts` — possibly a `supersedeRowsByOutputPath` helper for regenerate-image (or inline the logic).
- `src/lib/image/magnific.ts` — possibly extracted `enqueueOneImageBatchRow` helper for regenerate-image reuse.
- `src/worker/steps/render.ts` (or wherever the render step lives) — `RenderPrecheckError` + the precheck.
- `package.json` — `react-window` (or whichever virtualization lib) if not already present.
- All `__tests__/...` listed above.

Estimated ~10-12 production files + ~6 test files. Single PR off master post-#12 merge.

## Rollout / risk

- **Backwards compatibility:** new endpoints, new component conditionally mounted, no schema changes, no existing-route behavior changes. Other providers' UIs untouched.
- **Virtualization correctness:** the load-bearing UX claim. If virtualization misbehaves at 300 thumbnails (scroll glitches, off-screen rows not rendering on jump-to-failed, key collisions), the feature is unusable at the operator's actual scale. Manual test pass during S5's final session: load a real 200+ image video, scroll-test, jump-to-failed, click a far-offscreen thumbnail.
- **Polling cost:** 3s polling on every video-detail view means more DB load. Mitigations: pause on hidden tab, stop when terminal, dedupe identical responses client-side. If real-world load is a concern, add a server-side ETag/304 path.
- **Regenerate idempotency:** double-clicking regenerate must not enqueue two rows. Handled by the supersede-existing-row logic + a brief client-side debounce.
- **Render-precheck false positives:** the precheck depends on `chunks.json` being the canonical chunk list. If a chunk was deleted manually or the chunker re-ran with different output, the precheck might count the wrong number. Acceptable v1 risk; operator can manually override by re-running `chunk_images_only` to canonicalize.
- **PR shape:** all commits prefixed `image-timeline:`. Estimated ~10-12 production files + 6 test files. Single PR off master.

## Implementation method

Session boundaries (operator confirms in implementation plan-mode pass):

- **Session 1: API foundation.** `image-timeline` GET endpoint + `regenerate-image` POST endpoint + tests. Pure server-side, no UI yet. Verifiable via curl.
- **Session 2: Thumbnail + modal components.** `<Thumbnail>` + `<ImagePreviewModal>` in isolation with jsdom tests. No timeline mounting yet.
- **Session 3: Timeline component + virtualization.** `<ImageReviewTimeline>` with virtualized grid, count summary, jump-to-failed. Polling logic + visibility-aware pause. jsdom tests.
- **Session 4: Mount + render-precheck + server smoke.** Conditional mount in `video-detail-client.tsx`. Render-step precheck + `RenderPrecheckError`. Extend the server-side smoke to assert timeline shape. PR open.

Manual smoke after Session 4: the operator runs one real 60-90s narrative video with 10-15 images through the full pipeline. Validates: timeline renders, status updates live during generation, regenerate-one works, render-gate prevents rendering when an image is failed, render works when all done. This is the test video referenced in the rollout — not a Claude-Code-driven smoke, but the operator running a real video they'd publish anyway.

Final pre-PR: `npm run lint`, `npm run test`, `npm run build`. All clean.

PR title: `image-timeline: per-video image review with click-to-regenerate and render-gate`.

## Carry-forward absorbed by this spec

- **S2 failure→render gap** → resolved by the render-gate indicator + server-side render-precheck.
- **S4 row-1 cold-tab failure** → resolved operationally by per-image regenerate (one click to retry the failed row; resume idempotency means it Just Works). The underlying cold-tab DOM issue remains a documented carry-forward for a future small session, but the operator workflow is unblocked.
- **S4 delete-cleanup unverified** → unrelated to this spec; remains a smoke-test carry-forward.

## Open questions to settle in plan-mode (Session 1)

1. Does the existing `queue-summary` endpoint already include per-chunk status? If yes, reuse; if no, extend.
2. Is `react-window` already a project dep? If yes, use it; if no, confirm it's the right choice or pick the equivalent.
3. Confirm the actual filesystem layout of `projects/<videoId>/images/` — the spec assumes `<chunkId>.png` but the canonical naming should be verified against `MagnificImageProvider.generateBatch`'s real output_path resolution.
4. Confirm the render step's location and current entry-point shape for the precheck addition.
