# Issue: Hook video / hook audio duration mismatch in render

**Date**: 2026-05-09
**Branch**: google-flow-persistence-poll
**Commit**: 875a6982fec335c0e46d03a28b59b0a5dffcdda8
**Status**: Direction chosen 2026-05-10 — provider-aware chunker (`hook_video_clip_seconds` setting) + bump hook chunk count 12 → 15 to keep a 120 s hook under Google Flow's 8 s clips. See [§Chosen direction](#chosen-direction-2026-05-10). Originally captured as latent: crash during render is fixed (see `src/lib/render.ts` Stage D normalization); the mismatch described here causes correctness/UX issues in the rendered output but not a hard failure.
**Source**: Surfaced while debugging a Stage D xfade EINVAL on video `01KR6CZDKK0NJPPBFS4MJV7BTR` (Alexander the Great…).

> Originally captured as a problem write-up only. Direction now chosen — see [§Chosen direction (2026-05-10)](#chosen-direction-2026-05-10).

## TL;DR

The chunking step produces hook chunks whose audio durations sum to ~120 s (target `HOOK_TARGET_SECONDS = 120`). The Google Flow video provider generates exactly one **fixed-length 8 s clip per hook chunk**, so the concatenated hook video is `HOOK_CHUNK_COUNT × 8 s = 96 s` regardless of how long the corresponding narration is. Stage D of the renderer takes the chunk-derived hook duration as the xfade offset between hook and main, so the video's hook→main transition is *planned* against an audio timeline that the actual hook video can't reach. Result: ~24 s of hook narration has no matching hook visuals, the `-shortest` mux at Stage E truncates the output, and the tail of the main narration gets dropped from the final file.

The renderer comment at `src/lib/render.ts:371-373` notes this drift is expected to be "±a few seconds" — that assumption holds for an image-based hook but not for fixed-length clip generators.

## Evidence (from `01KR6CZDKK0NJPPBFS4MJV7BTR`)

- **Workflow**: `google-flow-chatterbox` (image_provider=google_flow, video_provider=google_flow).
- **Audio narration**: `audio/narration.mp3` is 424.91 s.
- **Chunks** (`chunks/chunks.json`):
  - 12 hook chunks, total span 0 → 119.56 s (sum of audio durations).
  - 11 main chunks, total span 119.56 → 424.88 s.
  - Hook chunk durations range 7.04 s – 13.40 s (most >8 s; only `hook_04`, `hook_09`, `hook_10` are ≤8 s).
- **Hook video clips** (`videos/hook/hook_*.mp4`): 12 files, each exactly 8.000 s @ 24 fps, 1280×720, yuv420p.
- **Stage A output** (after my crash fix): `render/hook_final.mp4` = 96.04 s.
- **Stage C output**: `render/main_concat.mp4` = 305.33 s.
- **Stage D**: invoked with `xfade ... offset=119.56` against `hook_final` (96.04 s) and `main_concat` (305.33 s).
- **Stage D output** with the crash fix applied: `render/video_only.mp4` = 305.37 s. Notable: this is roughly `main_concat + crossfade` — *not* `hookDuration + main_concat`. The first ~120 s of `main_concat` content is consumed inside the xfade region.
- **Stage E output**: `render/final_test.mp4` = 305.37 s. The audio (424.91 s) is truncated by `-shortest`. ~119 s of narration is dropped from the **end** of the main story.

## Why this happens

Two assumptions cross-cut and break:

1. **Chunking budgets the hook by audio time, not by clip count × clip length.**
   `src/worker/steps/08-chunk.ts:6-8` — `HOOK_TARGET_SECONDS = 120`, `HOOK_CHUNK_COUNT = 12`. The chunker greedily groups sentences until the audio reaches 120 s, then splits into 12 near-equal groups. Average chunk duration is ~10 s, often >8 s. This is fine for a still-image hook (Stage B's zoompan stretches a single image to any duration) but not for a video-clip hook with a fixed per-clip length.

2. **Google Flow always returns 8 s clips.**
   The `generate_hook_video` step calls `video_provider.generate(...)` once per hook chunk, and Google Flow's clip length is not parameterized by chunk duration. Twelve chunks → twelve 8-s clips → 96 s of video, regardless of how much audio was budgeted upstream.

The renderer is the meeting point of those two assumptions:

3. **Stage D's xfade offset is chunk-derived, not media-derived.**
   `src/lib/render.ts:371-374`:
   ```ts
   const hookDuration =
     hookChunks[hookChunks.length - 1].end - hookChunks[0].start;
   ```
   This is the audio timeline value (~119.56 s in this video), then used as `xfade ... offset=${hookDuration}` against the actual `hook_final.mp4` content (96.04 s). The comment two lines above acknowledges drift but assumed it would stay within "±a few seconds".

## What goes wrong in the output

Two distinct symptoms, both downstream of the same offset/duration mismatch:

- **Audio truncation at the end.** The Stage D xfade output ends at ~`max(hookDuration, input_0.duration) + (input_1.duration − duration)` ≈ `main_concat.duration + 0.04 s`. Stage E's `ffmpeg ... -shortest` then trims the 424.91 s narration to match the ~305.37 s video — losing **~119 s of narration off the end of the video**, which is the climax/conclusion of the main story.

- **Hook→main visual–audio desync** (mechanism not fully verified). xfade with `offset=119.56` while `input_0` ends at 96.04 s does *something* to fill the 23.5 s gap (frozen last frame / black / early reveal of input_1) — I did not pin down which. Whatever it does, the audio is still narrating hook content during that gap while the visual either freezes or transitions early. The empirical Stage D output duration (305.37 s) is consistent with "discard the first 119.56 s of input_1, then let input_1 play to its end on the output timeline", but other shapes are possible. **Confirm by inspecting a real rendered video before designing a fix.**

## Things to consider when designing a fix

These are options, not recommendations. Each has trade-offs that need a deliberate decision. *(Decision recorded below — see [§Chosen direction](#chosen-direction-2026-05-10).)*

- **Cap hook chunks at the provider's clip length.** Make the chunker for video-clip providers target ≤ N seconds per chunk and produce however many chunks fit in the hook budget (drop `HOOK_CHUNK_COUNT = 12` as a fixed constant for those providers).
- **Multiple clips per chunk.** Generate `ceil(chunk_duration / clip_length)` clips for each hook chunk and concat them, so the hook video's total length ≈ hook audio length.
- **Use the actual `hook_final.mp4` duration as the Stage D offset.** Probe the file with `ffprobe` (or have Stage A emit the duration) and pass that as `offset` instead of the chunk-derived value. This avoids the truncation but turns the gap into a different problem (visual transition no longer aligns with the chunk boundary in the audio).
- **Hold or fill the visual gap explicitly** (zoompan a still image, last-frame freeze, generated bridge clip) so the hook visuals reach the audio's chunk boundary.
- **Time-stretch hook clips.** Slow the playback rate so each clip's duration matches its chunk's audio duration. Risk: motion looks unnatural; speed factor could be large for >12 s chunks.
- **Drop the hook→main crossfade entirely for video-clip providers.** Just concat `hook_final` + `main_concat`. Removes the offset problem but loses the visual fade.

The right answer probably differs by `video_provider` (image-vs-clip), so this might belong in the workflow registry / provider contract rather than purely in the renderer.

## Open questions to resolve before designing

*(Status of each question after the chosen direction: see [§Effect on the original "Open questions"](#effect-on-the-original-open-questions).)*

1. **What does xfade actually emit between input_0 EOF (96.04 s) and the offset (119.56 s)** when both inputs are normalized to the same fps/timebase? Frozen-frame, black, or input_1 reveal? This determines whether the visual symptom is "freeze + cut narration" or "early visual transition + cut narration".
2. **Is the audio truncation actually ~119 s of the main story, or are timestamps elsewhere shifting?** Verify by playing the produced final.mp4 and noting the last word against the script.
3. **Is the 8 s clip length a hard Google Flow constraint, or is it parameterized?** Confirm in `src/lib/video/google-flow.ts` and the Flow API. If parameterizable per clip, an upstream fix is cheaper.
4. **What's the spec authority for hook structure?** `docs/histforge-spec.md` likely has the hook section design rationale (e.g., why 12 chunks, why ~10 s each). Any chunker-side fix has to stay consistent with what the LLM-generated hook script targets.
5. **Does any other step (e.g., enrich_chunks, image generation) implicitly depend on `HOOK_CHUNK_COUNT = 12` or chunk duration?** A chunker change could ripple.

## Code anchors

- Chunker hook logic: `src/worker/steps/08-chunk.ts:6-110`
- Hook video step: `src/worker/steps/generate-hook-video.ts`
- Google Flow provider: `src/lib/video/google-flow.ts`
- Renderer Stage A (hook concat + tail + final): `src/lib/render.ts:251-300`
- Renderer Stage D (hook→main xfade): `src/lib/render.ts:364-395`
- Renderer Stage E (audio mux with `-shortest`): `src/lib/render.ts:397-409`
- Crash-fix landing for the 24-vs-30 fps timebase mismatch (separate issue): the `fps=${framerate}` term in the `norm` filter at `src/lib/render.ts:387`

## How this was discovered

Render of `01KR6CZDKK0NJPPBFS4MJV7BTR` failed at Stage D with `ffmpeg exited with code=4294967274` ("Nothing was written into output file…"). Reproducing the pipeline by hand against the project's actual files isolated the failing command (Stage D xfade). The failure root cause was a **timebase mismatch** between hook clips (24 fps → tbn=1/12288) and the zoompan main concat (30 fps → tbn=1/15360); xfade refuses with EINVAL when timebases differ. That's now fixed by adding `fps=${framerate}` to the Stage D normalization. While verifying the fix end-to-end, the duration math above became visible — the render now succeeds, but the produced file has the symptoms documented above.

---

## Chosen direction (2026-05-10)

**Branch**: `ready-script-submission`. Re-investigated end-to-end against the current code; the original write-up holds. Two of the bullets from [§Things to consider](#things-to-consider-when-designing-a-fix) are adopted together: the **cap hook chunks at the provider's clip length** approach as the primary fix, plus the **ffprobe-based Stage D offset** as defense in depth (sentence-boundary snapping leaves residual drift even after the chunker is aligned, and the renderer should not have to trust upstream timestamps that don't match the actual concat output). Picked over multi-clip-per-chunk, time-stretching, hold-fill, and crossfade removal because the combined approach aligns chunker, provider, and renderer on the same physical clip duration with no per-clip artifacts (no held last frames, no slowdown) and no architectural deferral.

### What we'll change

1. **New setting `hook_video_clip_seconds`** (number, default `8`).
   Records the provider's nominal clip length — Google Flow / Veo = 8 s. ComfyUI users set it manually to match whatever their workflow JSON produces (auto-detection from the workflow file is out of scope for v1). Lives in `lib/db.ts` defaults, `lib/settings.ts` Zod schema, and the Settings UI alongside the other render-shape settings (`aspect_ratio`, `long_edge_px`, `framerate`).

2. **Bump hook chunk count from 12 → 15.**
   With Google Flow's 8 s clips, `15 × 8 s = 120 s` preserves the original 2-minute hook editorial intent. Either bump the constant at `src/worker/steps/08-chunk.ts:7` directly, or — preferred — promote it to a `hook_chunk_count` setting so different workflows / providers can size their hook independently of clip length (e.g. a workflow with 5 s ComfyUI clips would want 24 chunks for the same 120 s hook).

3. **Rewrite hook chunking** in `src/worker/steps/08-chunk.ts:46-110`.
   Replace the "split the ≤120 s hook span into 12 near-equal sentence groups" logic with the same sentence-walking algorithm already used for main chunks (`08-chunk.ts:118-146`), parameterized by `hook_video_clip_seconds` instead of `MAIN_TARGET_SECONDS`. Each hook chunk's audio span will then be ~`clipSeconds` ± sentence-boundary jitter (~1 s), matching the provider's actual output. Stop after `hook_chunk_count` chunks (or when sentences run out, whichever first).

4. **Defensive Stage D fix in the renderer.**
   Replace the chunk-timestamp `hookDuration` calculation at `src/lib/render.ts:371-374` with an `ffprobe` of `hook_final.mp4`. Even with the chunker aligned, sentence snapping still introduces ±1–2 s of residual drift, accumulated across 15 chunks; using the real concat duration as the xfade offset eliminates that risk regardless of upstream chunker behavior. An ffprobe wrapper can mirror the existing `buildFfmpegExec` shape in `src/worker/steps/14-render.ts:34-63`.

### Out of scope for v1

- **Per-provider clip-length settings.** A single global `hook_video_clip_seconds` covers all workflows for now; operators rerunning with a different provider edit the setting between runs. Splitting into provider-specific settings is a follow-up if mixed-provider operation becomes common.
- **Auto-detecting ComfyUI clip duration** from the workflow JSON's video-output node. Possible but format-specific and fragile — manual setting first, auto-detection later.
- **Per-chunk time-stretch / hold-fill fallback** for outlier chunks whose audio span doesn't fit `clipSeconds` cleanly. Sentence-boundary snapping should keep this rare; revisit only if it surfaces in real videos.

### Effect on the original "Open questions"

- **Q3 (is 8 s a hard Google Flow constraint?)** — sidestepped. The chosen direction treats clip length as a HistForge-side configuration, not a provider negotiation. If Google Flow ever exposes a per-request duration param, plumbing it through the provider is an orthogonal follow-up.
- **Q5 (other consumers of `HOOK_CHUNK_COUNT = 12` or chunk duration?)** — still load-bearing for the implementation plan. Before changing the constant: grep the codebase for `HOOK_CHUNK_COUNT` and `HOOK_TARGET_SECONDS`, audit `09-enrich-chunks.ts` for any implicit per-chunk assumptions, and check the dashboard UI for surfaces that count or display hook chunks.
- **Q4 (spec authority)** — `docs/histforge-spec.md` will need an update to reflect the new chunk count and the configurability.
- **Q1 (xfade behavior in the gap)** and **Q2 (audio truncation specifics)** — no longer load-bearing for fix design (both symptoms disappear once Stage A duration ≈ Stage D offset), but worth confirming empirically once the fix lands so we don't miss a second-order effect.

### Code touch points (preview, for the planning step)

- `src/lib/db.ts` — defaults for `hook_video_clip_seconds` (and likely `hook_chunk_count`).
- `src/lib/settings.ts` — Zod schema + coercion for the new setting(s).
- Settings UI tab module (resolve current path against `src/lib/settings-tabs.ts` references) — surface the new setting(s) in the same group as `aspect_ratio` / `long_edge_px` / `framerate`.
- `src/worker/steps/08-chunk.ts` — replace `HOOK_TARGET_SECONDS` / `HOOK_CHUNK_COUNT` constants with setting reads; rewrite hook-chunk grouping to walk sentences by clip-length target (mirrors the main-chunk loop).
- `src/lib/render.ts` — Stage D `hookDuration` via `ffprobe` of `hook_final.mp4`.
- `src/worker/steps/14-render.ts` — add an `ffprobe` wrapper alongside `buildFfmpegExec`, signal-aware so it cooperates with mid-render cancellation.
- Tests: chunker (new algorithm + setting wiring + boundary cases — sentences shorter and longer than `clipSeconds`); render (ffprobe path with mocked exec; hook-final duration drives offset).
- `docs/histforge-spec.md` — update the chunking section (currently anchored at 12 chunks / 120 s) to reflect configurability.
