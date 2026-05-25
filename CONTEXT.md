# HistForge

A pipeline that turns a creative input into a finished YouTube video. Two production *kinds* exist: a one-line topic → narrative historical video (the original product), and a Magnific image + Suno music prompt → looped music video. The vocabulary below is for talking about the pipeline's media outputs.

## Video kinds

**Narrative video**:
The original HistForge product. A `videos` row with `kind='narrative'`. Input is a one-line topic plus a visual-style choice; the pipeline generates a script, voices it, aligns it, chunks it, generates per-chunk images/clips, and renders a long-form (~90 min) historical YouTube video. Every domain term below the "Language" header — script, narration, chunk, audio span, clip, image, render — applies *only* to narrative-kind videos unless explicitly noted.

**Music video**:
A `videos` row with `kind='music_video'`. Input is a Magnific image prompt, a Suno style prompt, a song count `N`, and a repeat factor `M`. The pipeline generates one Magnific image (operator picks one variation in Chrome — HITL), an image-to-video loop clip on Magnific, a thumbnail from the same image, `N` instrumental Suno songs, then renders a looped video where the clip plays under `concat × M` of the song sequence. No script, no narration, no alignment, no chunks. Per-row music-video terms (loop image, loop clip, song, repeat factor, music video render) are defined under "Music video language" below.

**Video kind**:
The discriminator on `videos.kind` and `workflows.kind`. Values: `narrative`, `music_video`. Pinned on each `videos` row at creation; mirrors onto `workflow_snapshot.kind` via the workflow registry. The pipeline orchestrator + worker queue + lifecycle module are kind-agnostic; the materializer is the only place that switches on `kind` to emit a different step backbone. The dashboard `/videos` page surfaces kind via page-level tabs (Narrative | Music videos) — each tab owns its own Topics / Queue / Finished sections, but the underlying worker queue is unified (one FIFO by `created_at` across both kinds). See [ADR 0011](docs/adr/0011-video-kind-discriminator.md) for the chosen-vs-rejected design and the schema impact.
_Avoid_: "workflow type" (overloaded — could mean the workflow registry's `id` like `comfyui` vs. `google-flow`, which is one dimension below kind).

## Language

**Script**:
The LLM-generated text that the narrative video narrates. Produced in two passes: outline (chapters) and chapter prose. The script's full text becomes the narration. Narrative-kind only.

**Narration**:
The single audio track (`audio/narration.mp3`) generated from the script by a TTS provider. The pipeline treats it as one monolithic file; chunk boundaries are *views* into it, not separate audio files.

**Hook section**:
The opening section of a workflow-1 video — the contiguous run of clip chunks at the start, before the image body. Only applicable to workflows that use `chunk_clips_then_images`; video types using `chunk_images_only` or `chunk_clips_only` have no hook section.
_Avoid_: intro, pre-roll.

**Main section**:
The body of a workflow-1 video after the hook — the contiguous run of image chunks paired with still images that are zoom-panned. Only applicable to workflows that use `chunk_clips_then_images`; video types using `chunk_images_only` or `chunk_clips_only` have no main section.
_Avoid_: body.

**Chunk**:
A contiguous group of one or more aligned sentences from the script with an `id`, a `kind` (`clip` | `image`), an audio span, and a visual prompt. Produced by the workflow's chunker step (e.g. `chunk_clips_then_images`, `chunk_images_only`, `chunk_clips_only`) and stored in `chunks/chunks.json`. A chunk's `id` is the filesystem binding to its visual asset.
_Avoid_: segment (segment refers specifically to a Stage B per-image render output, `segment_NNN.mp4`), section.

**Clip chunk** / **Image chunk**:
A chunk with `kind` of `clip` or `image` respectively. Clip chunks pair with a clip file; image chunks pair with a still image.

**Audio span**:
A chunk's `[start, end]` interval — absolute seconds within `narration.mp3`, from aeneas alignment. The chunk's audio span duration is `chunk.end - chunk.start`.
_Avoid_: chunk duration (ambiguous — could mean audio span or rendered clip length).

**Clip**:
A short video file produced by the video provider for a single chunk with `kind="clip"`. Stored as `videos/clip/<chunkId>.mp4`. Clip duration is determined by the provider (e.g. Google Flow VEO emits a fixed 8 s clip).
_Avoid_: hook video (used colloquially for the whole hook section), video.

**Image**:
A single still image produced by the image provider for a single chunk with `kind="image"`. Stored as `images/<chunkId>.png`. The renderer plays each image for exactly the chunk's audio span with a slow zoom in.

**Visual prompt**:
The short text string attached to a chunk that drives its visual asset (image or clip). Produced by step `generate_visual_prompts` (one prompt per chunk) and stored as the `prompt` field on each chunk in `chunks.json`. Clip chunks' prompts feed the video provider; image chunks' prompts feed the image provider. The step batches K chunks per LLM call and skips chunks that already have a non-null prompt (see [ADR 0002](docs/adr/0002-visual-prompts-batching.md)).
_Avoid_: "enrichment" (legacy name for the step that produces these — the step is now `generate_visual_prompts`).

**Render**:
The ffmpeg-orchestrated process (Stage A, B, CD, E in `src/lib/render.ts`) that composes clips, images, and narration into `final.mp4`. Narrative-kind only. Stages: A = clip-chunk concat (writes `clip_final.mp4`; skipped when there are no clip chunks), B = per-image-chunk renders (writes `segment_NNN.mp4`; skipped when there are no image chunks), CD = fused image crossfade chain + clip→image crossfade (one ffmpeg invocation), E = audio mux. The music-video kind has its own render step (`render-music-video`) with a different filter graph; see "Music video language" below.

**Throwaway intermediate**:
A render-stage output whose *pixels* feed a later stage but whose *compression artifacts* are re-encoded away. `segment_NNN.mp4` (Stage B output) and `<chunkId>_timed.mp4` (Stage A per-clip output) are throwaway intermediates — Stage CD re-encodes them, so their per-segment encoder quality has no effect on `final.mp4`. The clip-stage intermediates `clip_concat.mp4` / `clip_tail.mp4` / `clip_final.mp4` are also throwaway under the same definition; only `final.mp4` is the visible artefact.
_Avoid_: "scratch file" (overloaded with disk scratch), "temp" (used for `render/` cleanup, not for the quality distinction).

## Relationships

- A **script** is voiced as one **narration**.
- A **narration** is partitioned into **chunks** by aeneas alignment + the workflow's chunker step.
- A chunk binds to its visual asset via filesystem id — clip chunks to `videos/clip/<id>.mp4`, image chunks to `images/<id>.png`.
- The chunk → asset binding is filesystem-based: `<chunkId>` matches the asset filename.
- A chunk's **audio span** is the authoritative duration target for its visual; the renderer enforces this binding (see [ADR 0001](docs/adr/0001-stage-a-enforces-audio-video-binding.md)).

## Flagged ambiguities

- "chunk" was used informally to mean both a sentence-group with audio timestamps (the canonical sense) and a rendered video segment. Resolved: **chunk** = aligned text-with-timestamps; **segment** = a Stage B per-image render output.
- "clip" was used for both a single-chunk video file and the whole hook section. Resolved: **clip** = single-chunk video file (a chunk with `kind="clip"`); the hook section as a whole has no single noun — refer to "the hook section" or "clip_final.mp4".
- "clip" (above) refers to a *narrative-kind* per-chunk clip file (one clip per chunk). The music-video kind has only one clip total — the **loop clip** (see below) — which is structurally different. Always qualify when crossing kinds: "per-chunk clip" vs. "loop clip".

## Music video language

Terms specific to the `music_video` kind. Music-video pipelines do not produce a script, narration, alignment, or chunks; the terms below replace those.

**Loop image**:
The single Magnific image produced by step `generate-loop-image`. Stored at `projects/<video_id>/loop_image.png`. The operator picks one variation from Magnific's grid (HITL — see "HITL gate" below). The same file is used as both (a) the first AND last frame of the loop clip (so the clip loops seamlessly) and (b) the thumbnail base.
_Avoid_: "cover" (ambientforge's term — HistForge music videos do not have a separate cover artifact since there's no DistroKid submission).

**Loop clip**:
The single ~5–15s Magnific Seedance image-to-video output produced by step `generate-loop-clip`. Stored at `projects/<video_id>/loop_clip.mp4`. The clip is the only video source in a music video; it is stream-looped (`-stream_loop -1`) for the full audio duration. The loop image is supplied to Seedance as both `first_frame` and `last_frame` so the clip transitions cleanly when looped.
_Avoid_: "clip" alone in music-video context (collides with the narrative-kind per-chunk clip); "hook video" (narrative-kind term).

**Song**:
A single Suno-generated audio track. Stored at `projects/<video_id>/songs/song_NN.wav` (NN zero-padded, 1-indexed, ordering matches generation order). v1 uses Suno `description` mode + `instrumental=true`, so songs carry no lyrics. All `N` songs in a video share one `videos.suno_style_prompt`; Suno produces `N` variations of that style.
_Avoid_: "track" (ambientforge's term; HistForge says song).

**Song count (N)** / **Repeat factor (M)**:
Per-video integers stored on `videos.song_count` and `videos.repeat_factor`. `N` ∈ `[1..30]` is how many distinct Suno songs are generated (default 10). `M` ∈ `[1..10]` is how many times the concatenated N-song sequence is looped in the final video (default 3). Total final video duration = `M × Σ(song durations)`. The (song1, song2, …, songN) sequence plays in order, then repeats from song1 for each of the `M` cycles — songs are not individually repeated.

**Music video render**:
The ffmpeg step `render-music-video` that produces `final.mp4` for the music-video kind. Different filter graph from the narrative-kind render (no xfade chain, no Stage B/CD): concat the N songs (stream-copy demuxer) → repeat-concat that file M times into `looped_audio.wav` (stream-copy) → mux `-stream_loop -1 -i loop_clip.mp4` + `looped_audio.wav` with `-map 0:v:0 -map 1:a:0 -t <total>`. Video re-encoded (libx264 or NVENC); audio stream-copied (Suno's native peaks accepted). The held last-frame tail trick from narrative-kind Stage A does not apply — clip seams are masked by Seedance's first==last-frame symmetry.

**HITL gate**:
A per-task no-timeout marker on a browser-driven queue table (`magnific_queue.no_timeout`, `suno_queue.no_timeout`). When set, the reaper does NOT requeue a task that has been `dispatched` longer than the normal timeout — used for the Magnific image-pick step (operator chooses one of the variations in their Magnific tab) and for Suno captcha challenges (operator solves the hCaptcha in their suno.com tab). The HistForge worker sees this as a normal task that happens to take a long time; the operator coordination lives inside the relevant extension. See [ADR 0012](docs/adr/0012-hitl-via-extension-no-timeout.md) for why HITL state lives on the queue row rather than as a new `videos.status` value.
_Avoid_: "awaiting operator" as a video status (HITL does NOT introduce a new `videos.status` value; the video stays `in_progress` and the queue table carries the awaiting state).

## Coordination vocabulary

Terms used when talking about the Google Flow account fleet and how dispatch is gated. Captures distinctions that surface in code, settings, and operator-facing UI.

**Time-based pause**:
An account is held back from dispatch until a wall-clock deadline. Carried by the `paused_until` column on `google_flow_accounts`. Auto-resumes when the deadline passes. Triggered by quota errors (`handleQuota`), create-project failures (24h hold), operator-set holds in Settings, and Veo backend congestion (see **Service overload pause** below).
_Avoid_: "cooldown" (overloaded — there are now two cooldown settings, `google_flow_account_cooldown_hours` for quota and `google_flow_service_overload_cooldown_minutes` for backend congestion. Always say which one).

**Operator-gated pause**:
An account is held back from dispatch indefinitely until the operator takes a specific recovery action. Carried by the `recovery_reason` + `recovery_required_at` columns. No auto-resume. Triggered by reCAPTCHA failures (see [ADR 0003](docs/adr/0003-recaptcha-recovery-operator-gated.md)); structurally extensible to other operator-actionable states (e.g., per-account re-login) but currently used only for reCAPTCHA recovery.
_Avoid_: "manual pause" (ambiguous — could mean operator-set time-based pause from Settings UI).

**reCAPTCHA recovery**:
The specific operator-gated state where an account needs the operator to manually re-engage its Google Flow session (open `labs.google/fx/tools/flow` in the account's Chrome profile and interact for ~30 seconds) before dispatch resumes. Distinct from time-based pause because the underlying cause — Google's reCAPTCHA score for the session — does not recover with elapsed time, only with session engagement.
_Avoid_: "captcha-paused" (conflates the kind with the cause).

**Service overload pause**:
The specific time-based pause triggered by Veo backend congestion — the error `PUBLIC_ERROR_HIGH_TRAFFIC` from `aisandbox-pa`. Shares the `paused_until` column with other time-based pauses but uses its own duration setting (`google_flow_service_overload_cooldown_minutes`, default 15 min) because congestion subsides on minutes-scale, not the hour-scale of quota windows. Distinct from quota in two ways: (1) the cause is Veo-side (backend congestion), not account-side (rate window exhausted); (2) surfaces a top-level banner because operator visibility of "Veo is congested right now" is a fleet-level signal, even though the dispatch-gating mechanism remains per-account. See ADR-0004.
_Avoid_: "global overload pause" (the dispatch-gating mechanism is per-account; only the banner is fleet-level). "Backend pause" (ambiguous — could read as `queue_state='paused'`).

**Concurrency bucket**:
A classification of Veo tasks (`image` | `video`) that determines which slot pool the task is charged against in the youforge-flow extension's runner. Derived from `task.mode`: `createimage`/`imagegen` are the image bucket; `text`/`image`/`ingredients`/`frames` are the video bucket. The extension expresses intent via the optional `wantBucket` field on `/api/flow/next-task`; the server filters returned tasks by the corresponding mode set. Each bucket has an independent slot ceiling (`imageConcurrency` / `videoConcurrency` settings) and an independent active-count counter — pools do not share slots, so video tasks cannot starve image tasks. See [ADR 0005](docs/adr/0005-youforge-flow-image-video-concurrency-split.md).
_Avoid_: "mode" (the per-task Veo executor key, e.g. `createimage`), "kind" (used for chunks: `clip` | `image`).

## Lifecycle vocabulary

Terms used when talking about the multi-write atomic state transitions of videos and the Flow fleet.

**Video lifecycle**:
The state machine of a video as it moves through `new` → `queued` → `in_progress` → `done` | `failed` | (removed), with `paused` and `deferred_until` as orthogonal axes. The composed transitions on this lifecycle (entering a step, recording failure, finalizing, pausing, retry, restart, delete) form the operator-facing surface that the worker orchestrator and the dashboard share. Distinguished from the Flow lifecycle along operator mental model — who triggers the transition and why. See [ADR 0007](docs/adr/0007-video-and-flow-lifecycle-modules.md).
_Avoid_: "video state" alone (ambiguous — could mean just the `status` column).

**Flow lifecycle**:
The state machine of the Flow account fleet and its dispatch queue — accounts move through enabled / time-based pause / operator-gated pause; queue tasks move through pending → dispatched → done | failed (with retry and prompt-rewrite cycles). The composed transitions on this lifecycle (account-pause + task-requeue + banner updates, captcha recovery, the queue-row resume cascade) form the operator-facing surface that the Flow webhook handlers and the Flow-fleet dashboard share.

**Transition**:
A named multi-write atomic state change on a lifecycle that runs inside one `db.transaction()`. Distinct from an atomic repo helper (a single SQL write). Lifecycle modules own transitions; repos own atomic writes. Composing one lifecycle's transition inside another's uses better-sqlite3's reentrant transactions — the inner call becomes a savepoint — so cross-lifecycle composition doesn't require shared transaction-context plumbing.
_Avoid_: "operation" (overloaded with Google Flow's `google_operation_id`).

**Per-step harness**:
The named per-step run cycle inside `runPipeline` — build the step context, run the step, interpret the outcome (continue / defer / cancel / fail), and apply the matching **transition**. Lives as `runStep` in `src/worker/run-step.ts`. Composes lifecycle transitions (`enterStep`, `recordStepFailure`, `deleteFully`) with single-statement repo writes (`stepsRepo.markDone`, `videosRepo.setDeferredUntil`). Distinguished from the loop's *boundary checks* (delete / pause / skip-if-done) which decide whether a step runs at all; the harness is what runs once those checks pass.
_Avoid_: "step runner" (overloaded with `runner.ts`, the queue-polling loop), "step executor" (suggests CPU work, not a state-machine cycle).
