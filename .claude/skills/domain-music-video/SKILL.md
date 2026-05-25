---
name: domain-music-video
description: Guide for HistForge's music-video kind — the videos/workflows `kind` discriminator, the six-step music-video backbone, the Magnific HITL-aware worker steps, the music-video UI surface (tabs, Add Music Video modal, HITL banner), the kind-aware workflow validator, and the loop-seam render. Use when modifying any of the music-video worker steps, the materializer's kind switch, the music-video Add modal / Music videos tab, the HITL banner mount, the kind-aware workflow consistency rules, or the music-video render tunables. Pair with `domain-magnific-coordinator` (Magnific queue, routes, reaper, extension) and `domain-workflows` (registry mechanics).
---

# Music Video Kind

## Anchors

Contract names for this domain. Resolve against the current codebase.

- **Kind discriminator + materialization**: `VideoKind`, `materializeStepList`, `MUSIC_VIDEO_STEPS`, `WorkflowSnapshot.kind`
- **Music-video columns on `videos`**: `videos.kind`, `videos.magnific_image_prompt`, `videos.magnific_motion_prompt`, `videos.suno_style_prompt`, `videos.song_count`, `videos.repeat_factor`
- **Workflow-row kind**: `workflows.kind`
- **Six worker step slugs**: `generate_loop_image`, `generate_loop_clip`, `make_thumbnail`, `generate_music`, `download_music`, `render_music_video`
- **Step `module` tag**: `music_video` (the `ModuleId` literal that groups the six steps)
- **Validators**: `validateWorkflowConsistency`, `validateMusicVideoConsistency`
- **Built-in workflow**: `music-video-magnific-suno`
- **UI components**: `MusicVideosTab`, `AddMusicVideoModal`, `MagnificHitlBanner`
- **Render tunables (settings keys)**: `music_video_loop_trim_tail_seconds`, `music_video_loop_xfade_seconds`

## Architecture

A music video is a separate pipeline backbone living under the same orchestrator, queue, lifecycle, and dashboard machinery as the narrative pipeline. The narrative pipeline goes script → narration → alignment → chunking → per-chunk visuals → multi-stage xfade render. The music-video pipeline goes Magnific image (HITL) → Magnific image-to-video clip → ffmpeg thumbnail crop → Suno songs → looped mux. The two share no step files past the `module: 'music_video'` boundary; what they share is everything outside the step files — the videos table, the worker runner, the FIFO queue picker, the per-step harness, pause/resume/defer/delete, the dashboard polling, the workflow registry, and the AI-skill drafts pipeline.

The shape is set by **ADR-0011** (kind discriminator on `videos` + `workflows`) and **ADR-0012** (HITL via extension `no_timeout`, single-account Magnific queue, no parallel `music_videos` table). Read those for design rationale before reshaping the kind axis.

The pair of skills: this skill owns the kind, the steps, the UI, and the materializer branch. **`domain-magnific-coordinator`** owns the `magnific_queue`, webhook routes, reaper extension, and the Magnific Chrome extension contract — anything that crosses the wire to the operator's Magnific tab.

## Kind as a Single Branch Site

**`materializeStepList` is the only kind-switching site in the worker process.** Adding a third kind (podcast, shorts, etc.) is one new enum value, one new materializer branch, one new tab on `/videos`, and the kind-specific worker steps — nothing about either existing kind has to change. Don't add a second kind-switch elsewhere. The kind-agnostic-by-default rule is what keeps the orchestrator, lifecycle, drafts, and dashboard from accumulating per-kind branches.

`resolveDeps` also short-circuits LLM / image / video provider resolution for music-video snapshots, because the six steps don't read `ctx.chat`, `ctx.visualPromptChat`, `ctx.imageProvider`, or `ctx.videoProvider`. **Don't widen `ResolvedDeps` to make those fields optional** — `null` on those fields for music-video runs is the contract, and changing it would force every narrative step to start defending against null providers. The interface itself carries no warning about this; treat the skill as the canonical statement.

The worker queue is **unified**: one FIFO across both kinds by `created_at`. The picker doesn't care about kind; only the dashboard tabs filter at the data layer.

## Per-Topic Inputs on `videos`

Music-video rows carry five extra nullable columns the orchestrator and the steps read at runtime (named in Anchors). These are **typed columns, not a JSON blob or side table**, because the precedent — `videos.provided_script` for narrative-kind ready scripts — already established that pattern, and per-column Zod parsing is easier to introspect via the sqlite shell than blob-field parsing. The Add Music Video modal is the single insert site; the `POST /api/videos` route dispatches on the body's `kind` field and refuses cross-kind shapes (narrative payload onto music_video row, and vice versa).

## Six-Step Backbone (why fixed)

`MUSIC_VIDEO_STEPS` is hard-coded — no glue insertion, no provider drop-out, no chunker slot. That's deliberate. A music-video workflow doesn't have any axis the existing registry needs to model (script LLM, TTS, chunker variant, image vs video provider mix); modelling it as "a narrative workflow with everything null" would push a null-pyramid into the materializer and force the Add modal to render per-row conditional fields. The kind-specific Add modal is the cheaper trade.

Each step file's module JSDoc documents its own contract: skip-on-disk reentry, the queue-row reentry check, the `no_timeout` value passed at enqueue, the defer-not-throw exit on paused/deleted, and the terminal-failure detection. The one piece worth restating here because it lives in the skill alone: **`generate_loop_image` enqueues with `no_timeout=1` because operator selection can legitimately take days.** The sibling step's JSDoc only explains its own `no_timeout=0` choice, so the HITL value's rationale doesn't live at any call site.

## Render Notes

The `video_encoder` setting is **shared with the narrative renderer** so an operator who picks an encoder once doesn't have to set it per-kind. The loop-seam tunables (`music_video_loop_trim_tail_seconds`, `music_video_loop_xfade_seconds`) are music-video-only because they describe physics that has no narrative analogue.

The two-pass loop-seam mitigation (pre-trim re-encode then xfade-chained mux), the `+1` iteration cushion, the `xfadeDur ≤ T/2` clamp, the `xfade=0` escape hatch, and the rejected single-pass `-stream_loop -1` approach are all inline-commented at the render step. The piece **not** in the call-site comment: `settb=AVTB` on every input is required because NVENC's pixfmt negotiation triggers a filter-graph reinit that rejects the chain mid-stream, while libx264 silently masks the same bug. The failure mode is encoder-specific and only shows up under operator GPU swap — that's the trap.

## Music-Video Workflow

A single built-in workflow ships: `music-video-magnific-suno`. Operators can clone it via the existing `/workflows` UI to make variants once more providers exist (a future `seedream-suno` or `magnific-udio`, for example). The provider triple and the null-narrative-fields rule are enforced by `validateMusicVideoConsistency`, which has its own JSDoc; the kind-router (`validateWorkflowConsistency`) does likewise.

**`upscaler_provider` is a column shipped without a v1 step that consumes it** — placeholder for a future upscaler. Don't repurpose it for something else; the column exists so adding an upscaler step doesn't need a schema migration.

For workflow registry mechanics, builtin seeding, snapshot lifecycle, and the AI-skill drafts JSON schema, see **`domain-workflows`** and **`domain-workflow-drafts`**.

## UI Surface Notes

- **`MagnificHitlBanner`'s "Open Magnific tab" CTA opens the same URL the magnific-ext content script injects on.** The extension's `MAGNIFIC_IMAGE_GEN_URL` constant is the canonical source; a divergence lands operators on a tab the content script isn't injected on, and the banner appears stuck because no overlay buttons render. There is no runtime check for this; treat it as a cross-process invariant.
- **Plan-1 deferred edit.** The music-video Topics table renders the Edit button but the callback is a no-op in Plan 1; operators delete + recreate. Don't repurpose the button for something else — the kind-agnostic table expects the callback to mean "open an edit modal," and an alternative use would break the narrative tab's edit flow when the real music-video edit modal lands.

For settings tabs, the per-page polling pattern, and shared dashboard primitives, see **`domain-dashboard`**.

## Suno Stubs

`generate_music` and `download_music` are Plan 1 stubs (no-op resolve + N silent stereo WAVs respectively). Real Suno integration is a separate plan that will add a `suno_queue` table, `/api/suno/*` routes, and a Suno-side dumb-runner extension following the same coordinator pattern as Magnific. **Don't preempt that shape from inside these stubs** — the right place to model it is alongside the existing magnific coordinator, not by accreting Suno-specific logic into the stub bodies.

## Common Pitfalls

- **The materializer is the only kind-switching site.** Resist adding `if (kind === 'music_video') { ... }` branches in the orchestrator, runner, picker, lifecycle, dashboard list-polling endpoints, or the AI-skill drafts pipeline. **Why:** the kind-agnostic-by-default rule is what makes adding a third kind (podcast, shorts) cheap. Every additional branch site is a new place future kinds have to be wired through; the more branches accumulate, the closer the design slides back toward Option-2 separation (rejected in ADR-0011 because it would duplicate the lifecycle module). **How to apply:** if you think you need a kind branch elsewhere, first try to move the decision into the snapshot or into the step's own contract.
- **`magnific_image_prompt` and `magnific_motion_prompt` are independent operator inputs.** Don't derive the motion prompt from the image prompt at step-time — the modal collects both directly. **Why:** the two prompts describe orthogonal concerns (subject vs camera motion), and Magnific Seedance produces better results when each is operator-tuned. An earlier derived-suffix approach is gone; reintroducing it would silently degrade output for operators who haven't noticed the motion prompt is its own field. **How to apply:** if you find yourself transforming one prompt into the other, you've drifted off the contract — surface the second field in the UI instead.
- **Don't split the encoder choice with a music-video-specific setting.** `render_music_video` reads the same `video_encoder` key the narrative renderer reads. **Why:** an operator who picks an encoder once shouldn't have to set it per-kind, and splitting the keys forces a settings UI grid that's harder to keep coherent. **How to apply:** the loop-seam tunables are music-video-only because they describe physics with no narrative analogue — that's the bar for adding a kind-specific setting.
- **xfade-chained mux: `settb=AVTB` on every input, clamp `xfadeDur ≤ T/2`.** Both are easy to drop "for cleanliness" while refactoring args. **Why:** without `settb`, NVENC triggers filter-graph reinit and the chain rejects mid-stream — libx264 happens to skip reinit and silently masks the bug, so the failure mode is encoder-specific and only shows up under operator GPU swap. Without the clamp, the first-fade offset arithmetic goes negative for short trimmed clips and ffmpeg rejects the graph. **How to apply:** if you're refactoring the render filter args, run the test suite under both encoder selections (or at minimum mentally trace what NVENC sees).
- **Don't add a music-video `cleanup` step that uses the narrative step-15 keep set.** The narrative cleanup's keep set names narrative-kind artifacts; running it against a music-video project would either nuke needed files or skip them entirely. **Why:** the artifact trees genuinely diverge per kind, and enumerate-and-delete needs a kind-specific keep list. **How to apply:** when the music-video cleanup ships, follow the same enumerate-and-delete shape `domain-media` describes but with the music-video keep list.
