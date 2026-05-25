---
status: accepted
date: 2026-05-15
---

# Split youforge-flow concurrency into separate image and video pools

## Context

The youforge-flow extension owns a single `concurrency` setting consumed by `src/runner.js`. One `activeTaskCount` counter gates all six Veo modes — `createimage` and `imagegen` (synchronous image generation, ~30s) share the pool with `text`/`image`/`ingredients`/`frames` (async video generation, up to 10 min via `pollVideoUntilDone`). Under sustained load, slow video tasks fill the pool and starve fast image tasks for the duration of the video poll window. Descriptive research is in [docs/research/2026-05-15-youforge-flow-concurrency.md](../research/2026-05-15-youforge-flow-concurrency.md).

## Decision

Two independent slot pools in the extension's runner, with the server filtering returned tasks by an extension-expressed bucket intent.

1. **Two counters, two ceilings.** Replace `activeTaskCount` with `activeImageCount` and `activeVideoCount`. Replace the `concurrency` setting (and `getMaxConcurrent()`) with `imageConcurrency` (default 5) and `videoConcurrency` (default 3), both clamped `[1, 10]` via the existing `MAX_CONCURRENT_MAX` constant. Asymmetric defaults reflect that image jobs turn over ~10× faster than video jobs, so equal counters would tilt account-level rate-limit pressure toward video.

2. **Bucket classification.** A task's *concurrency bucket* (see [CONTEXT.md](../../CONTEXT.md)) is `image` when `EXECUTORS[task.mode].isImageGen === true`, else `video`. Computed in `dispatchTask` at increment time and closure-captured for the completion `.then`/`.catch` decrement + same-bucket re-poll. The unknown-mode fallback (`EXECUTORS.text`) charges video — same destination as the in-place fallback.

3. **`wantBucket` on `/api/flow/next-task`.** The request schema gains an optional `wantBucket: z.enum(['image', 'video']).optional()`. `takeNextTaskForAccount` accepts the bucket and adds a `mode IN (...)` clause from a server-side bucket-to-modes map (placed at `src/lib/flow-constants.ts` alongside `DEFAULT_STALE_ACCOUNT_MINUTES`). When `wantBucket` is absent, behaviour is unchanged (highest-priority pending row, any mode) — preserving rollout-order independence. The existing `mode` request field stays as a no-op carried by `getCurrentMode()`.

4. **Per-bucket polling cadence.** The Chrome alarm, initial-fill loop, and task-completion `.then`/`.catch` chain all generalize to per-bucket calls of `pollForTasksFIFO(bucket)`. Alarm fires both buckets sequentially with `_launchStaggerMs()` between, gated by each bucket's own counter. Initial fill interleaves buckets with per-bucket "still open" flags. Completion polls only its own bucket. The `pollingInProgress` mutex stays single — bucket parallelism happens via serialized fires, not concurrent ones. No cross-bucket pokes on completion: the alarm's ~10s period bounds the latency for a freshly-non-empty idle bucket.

5. **Delete-on-upgrade migration.** `chrome.runtime.onInstalled` (`reason === 'update'`) removes the old `concurrency` key from `chrome.storage.local`; new keys initialize from schema defaults. The semantic break (single-pool tuning → two-pool tuning) is not meaningfully translatable, so any auto-derivation imposes invented intent.

6. **`markSlotFreedForUpscale` becomes video-specific.** Upscale exists only for video tasks (image upscale runs synchronously inside the slot). The function decrements `activeVideoCount` and re-polls the video bucket. Renamed to `markVideoSlotFreedForUpscale` so the video-only semantics aren't ambiguous after the split.

## Considered options (rejected)

**B — Single pool with two sub-caps.** One total ceiling + per-bucket sub-caps. Rejected because it doesn't actually prevent starvation: with sub-caps set to the total, videos can still fill all slots if they get there first. The mechanism that solves starvation is *reserved* image capacity, not *capped* video capacity. Option B looks like a compromise but doesn't deliver the property.

**C — Weighted slots (image=1, video=N).** Rejected because it hides the operator-facing distinction behind implementation mechanics and doesn't match the stated framing ("one for images and one for videos"). The popup would still need two inputs to be intelligible, and operators would have to reason about an internal weight constant.

**M2 — Duplicate old `concurrency` into both new keys.** Rejected because it silently doubles the total in-flight ceiling on upgrade. An operator at `concurrency=8` would suddenly tolerate 16 simultaneous Veo calls per account — a behaviour change they didn't request, surfacing only when rate-limit cooldowns start firing.

**M3 — Split old `concurrency` half-and-half.** Rejected because the asymmetric defaults (5/3) reflect the physics of image vs video turnover. Splitting a single value 50/50 ignores that, producing worse-than-default settings for any old value below 10.

**Cross-bucket completion pokes.** Rejected because the alarm's ~10s period already bounds idle-bucket-wakeup latency, and the common case (both buckets busy) makes pokes a constant tax for an occasional payoff.

## Consequences

- **The "HistForge has no view of extension concurrency" property is preserved.** The new `wantBucket` field expresses *intent* (what the extension is ready to take next), not *state* (how full the pools are). Concurrency values remain extension-local; only the bucket-to-modes classification crosses the wire. The "extension-local" note at `docs/setup-guides/setup-google-flow.md:42` is updated to clarify scope: the two values remain extension-local; the bucket distinction is now shared.
- **The server gains one small piece of knowledge** — a bucket-to-modes map alongside `DEFAULT_STALE_ACCOUNT_MINUTES`. The bucket boundary is stable; if Veo adds a new mode in future, both the extension's `EXECUTORS` and this map need entries.
- **CONTEXT.md gains "Concurrency bucket"** under Coordination vocabulary. "Pool" remains informal prose; "bucket" is the canonical classification noun.
- **Out of scope:** surfacing per-bucket counts in the popup status display (the existing `getStatus().isProcessing` boolean stays bucket-agnostic), HistForge-side UI for the extension's settings, telemetry/metrics for bucket utilisation. Each is a clear extension if observed need arises.
