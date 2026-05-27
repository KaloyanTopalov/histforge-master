# histforge — System Design Specification (v4)

A single-operator pipeline that turns a topic line into a finished 2-hour historical YouTube video, unattended.

---

## 1. Goals & Non-Goals

**Goals**
- Queue videos, walk away, return to finished `.mp4` files.
- Modular pipeline — every external dependency (LLM, TTS, image gen, video gen) can be swapped.
- Workflow-driven sequence — each video picks a workflow that owns the ordered step list the orchestrator runs.
- Resume from last successful step on crash.
- Solo operator, one video at a time, local machine.

**Non-goals (v1)**
- Multi-user / authentication.
- Cloud deployment.
- Human-in-the-loop review.
- Automatic YouTube upload.
- Parallel video processing.

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│   Windows (native)                                           │
│                                                              │
│  ┌────────────────┐         ┌──────────────────────────┐     │
│  │   Next.js App  │ ◄─────► │       SQLite DB          │     │
│  │  (App Router)  │         │  videos, steps, settings │     │
│  │  Dashboard +   │         └──────────────────────────┘     │
│  │   API routes   │                    ▲                     │
│  └────────────────┘                    │                     │
│                                        │                     │
│  ┌────────────────┐                    │                     │
│  │  Node Worker   │ ◄──────────────────┘                     │
│  │  (long-running)│                                          │
│  └───────┬────────┘                                          │
│          │                                                   │
│          ├─► OpenRouter API       (LLM steps)                │
│          ├─► AI33 / GenAIPro API (TTS, ElevenLabs-compat)    │
│          ├─► Chatterbox-TTS-Server (TTS, local HTTP)         │
│          ├─► ComfyUI (local)     (images + clips)            │
│          ├─► ffmpeg.exe           (render)                   │
│          └─► wsl python3 align.py (aeneas, WSL2 subprocess)  │
│                                                              │
│  ┌────────────────────────────────────────────────────┐      │
│  │  ./projects/<video_id>/   (artifacts on local disk)│      │
│  └────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────┘
```

**Stack**
- **OS:** Windows 10/11 native, with WSL2 (Ubuntu) installed *only* to host aeneas.
- **Runtime:** Node 20 LTS, npm.
- **Frontend:** Next.js 14+ (App Router), React, Tailwind CSS.
- **DB:** SQLite via `better-sqlite3`. Single source of truth for all state.
- **Worker:** Plain Node process, same repo, started alongside Next.js via `concurrently`.
- **Google Flow runner:** a forked Chrome extension (`extensions/youforge-flow/`) acts as a dumb task runner against `labs.google/fx/tools/flow`; HistForge owns the queue, accounts, and cooldown state via webhook endpoints (see §12b). No Playwright — the extension drives a real Chrome profile the user is signed into.
- **Render:** Node spawns `ffmpeg.exe` directly (no Python).
- **Alignment:** Node spawns `wsl python3 align.py` (the only thing in WSL).

Why Windows-native + WSL-for-aeneas-only: aeneas does not install cleanly on native Windows but is trivial in WSL2. Everything else (ComfyUI, ffmpeg, Node) runs better on Windows native and avoids WSLg display headaches and `\\wsl$\` path translation. Only the small `align.py` script crosses the boundary.

---

## 3. Repository Layout

```
histforge/
├── README.md
├── MANUAL.md
├── CLAUDE.md
├── package.json
├── .env.example
├── next.config.js
├── tailwind.config.js
├── tsconfig.json
│
├── src/
│   ├── app/                      # Next.js App Router
│   │   ├── layout.tsx
│   │   ├── page.tsx              # → redirect to /videos
│   │   ├── nav-bar.tsx
│   │   ├── videos/
│   │   │   ├── page.tsx
│   │   │   ├── videos-client.tsx
│   │   │   ├── video-queue-table.tsx
│   │   │   ├── finished-videos-table.tsx
│   │   │   ├── add-video-modal.tsx
│   │   │   ├── delete-confirm-dialog.tsx
│   │   │   └── [id]/
│   │   │       ├── page.tsx
│   │   │       ├── video-detail-client.tsx
│   │   │       └── video-actions.tsx
│   │   ├── settings/
│   │   │   ├── page.tsx
│   │   │   └── settings-form.tsx
│   │   └── api/
│   │       ├── videos/route.ts                   # GET list, POST create
│   │       ├── videos/[id]/route.ts              # GET, PATCH, DELETE
│   │       ├── videos/[id]/start/route.ts        # POST new → queued
│   │       ├── videos/[id]/retry/route.ts
│   │       ├── videos/[id]/restart/route.ts
│   │       ├── videos/[id]/files/[...path]/route.ts
│   │       ├── videos/start-all/route.ts         # POST bulk new → queued
│   │       ├── settings/route.ts
│   │       └── health/route.ts
│   │
│   ├── worker/
│   │   ├── index.ts              # entry point
│   │   ├── runner.ts             # main loop, picks queued videos (FIFO)
│   │   ├── pipeline.ts           # step orchestration, resume, delete-requested
│   │   ├── workflows/index.ts    # workflow registry (comfyui, google-flow)
│   │   └── steps/
│   │       ├── 01-research-outline.ts
│   │       ├── 02-research-characters.ts
│   │       ├── 03-write-hook.ts
│   │       ├── 04-write-chapters.ts
│   │       ├── 05-assemble-script.ts
│   │       ├── 06-voiceover.ts
│   │       ├── 07-align.ts
│   │       ├── 08-chunk-clips-then-images.ts
│   │       ├── 08-chunk-images-only.ts
│   │       ├── 08-chunk-clips-only.ts
│   │       ├── chunk-utils.ts
│   │       ├── 09-generate-visual-prompts.ts
│   │       ├── generate-images.ts
│   │       ├── generate-clips.ts
│   │       ├── 14-render.ts
│   │       ├── 15-cleanup.ts
│   │       └── index.ts          # REAL_STEPS + validateWorkflowSteps
│   │
│   ├── lib/
│   │   ├── db.ts                 # SQLite client + schema
│   │   ├── settings.ts           # typed accessors + per-key schemas
│   │   ├── llm/                  # OpenRouter chat provider
│   │   ├── tts/
│   │   │   ├── types.ts          # TtsProvider interface
│   │   │   ├── index.ts          # provider registry (getTtsProvider)
│   │   │   ├── ai33.ts           # AI33 TTS client (ElevenLabs-compatible)
│   │   │   ├── genaipro.ts       # GenAIPro TTS client (ElevenLabs-compatible)
│   │   │   ├── chatterbox.ts     # Chatterbox TTS client (local HTTP)
│   │   │   └── chatterbox-transcode.ts # WAV→MP3 transcode helper
│   │   ├── image/
│   │   │   ├── types.ts          # ImageProvider interface
│   │   │   ├── index.ts          # provider registry (getImageProvider)
│   │   │   └── comfyui.ts        # ComfyUI client (images + clips)
│   │   ├── repos/
│   │   │   ├── videos.ts         # CRUD + lifecycle transitions
│   │   │   └── steps.ts          # step-row transitions
│   │   ├── render.ts             # ffmpeg orchestration (one file)
│   │   ├── align.ts              # wraps `wsl python3 align.py` invocation
│   │   ├── sentences.ts          # JS sentence splitter
│   │   ├── prompts.ts            # template loader + variable substitution
│   │   ├── project-files.ts      # artifact tree lister for detail page
│   │   └── logger.ts
│   │
│   └── types.ts                  # Video, VideoStatus, Chunk, AlignmentEntry, …
│
├── prompts/
│   ├── _shared/
│   │   ├── audience_profile.md
│   │   ├── banned_words.md
│   │   ├── format_guidelines.md
│   │   └── numbers_as_letters.md
│   ├── 01_research_outline.md
│   ├── 03_write_hook.md
│   ├── 04_write_chapters_batch.md
│   ├── 04_story_so_far.md
│   ├── 04_extract_structure.md
│   ├── 09_generate_visual_prompts.md
│   └── comfyui/
│       ├── default-workflow.json              # image workflow (API format)
│       ├── default-hook-video-workflow.json   # text-to-video workflow (user-supplied)
│       └── README.md
│
├── python/
│   └── align.py                    # aeneas wrapper, runs in WSL
│
├── extensions/
│   ├── youforge-flow/              # forked Chrome extension — Google Flow task runner
│   └── veo-upstream/               # upstream reference copy (for future diffs)
│
├── projects/                       # gitignored, runtime artifacts
│   └── <video_id>/...
│
└── data/
    └── histforge.db                # SQLite, gitignored
```

`align.py` is the only Python file. Direct `fs/promises` everywhere — no storage abstraction layer (YAGNI; refactor when/if remote storage is required).

---

## 4. Database Schema (SQLite)

```sql
CREATE TABLE videos (
  id               TEXT PRIMARY KEY,        -- ulid
  title            TEXT NOT NULL,
  topic_info       TEXT NOT NULL,
  workflow_id      TEXT NOT NULL,           -- resolves to a workflow registry entry
  status           TEXT NOT NULL,           -- new | queued | in_progress | done | failed
  current_step     TEXT,                    -- denormalized from video_steps for query speed
  failed_step      TEXT,                    -- populated when status=failed
  failed_reason    TEXT,
  started_at       INTEGER,
  finished_at      INTEGER,
  output_path      TEXT,                    -- path to final mp4
  delete_requested INTEGER NOT NULL DEFAULT 0,
  deferred_until   INTEGER,                  -- unix seconds; set by steps that yield (e.g. Google Flow)
  provided_script  TEXT,                    -- when non-null, queue-time prep skips script generation (see §7.7)
  visual_style_id  TEXT REFERENCES visual_styles(id) ON DELETE SET NULL,  -- nullable; NULL = "Default" (empty style prompt)
  visual_style_snapshot TEXT,                -- JSON {id,title,prompt} pinned at create / re-pinned at queue; authoritative source for step 09 (ADR-0010)
  image_chunk_target_seconds INTEGER,        -- per-video override of the global pacing target; NULL falls through to `image_chunk_target_seconds` setting
  image_chunk_min_seconds    INTEGER,        -- per-video floor override; NULL falls through to `image_chunk_min_seconds` setting
  image_chunk_max_seconds    INTEGER,        -- per-video ceiling override; NULL falls through to `image_chunk_max_seconds` setting
  created_at       INTEGER NOT NULL
);

CREATE TABLE visual_styles (
  id            TEXT PRIMARY KEY,        -- ulid
  title         TEXT NOT NULL,           -- operator-facing label; not unique
  prompt        TEXT NOT NULL,           -- visual-style guidance injected as the `style_prompt` template var in step 09; empty string allowed
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE video_steps (
  video_id      TEXT NOT NULL REFERENCES videos(id),
  step_name     TEXT NOT NULL,
  status        TEXT NOT NULL,           -- pending | running | done | failed
  started_at    INTEGER,
  finished_at   INTEGER,
  PRIMARY KEY (video_id, step_name)
);

CREATE TABLE settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);
```

The Google Flow provider adds three more tables — `google_flow_accounts`, `google_flow_queue`, and `google_flow_video_projects` — defined in §12b.3.

There is no separate `topics` table. `title` + `topic_info` live directly on each `videos` row. The previous `topics → videos` queue flow has been replaced by per-video lifecycle control (see section 15).

The DB is the single source of truth. There is no `meta.json` mirror file.

**Video statuses:**

| Status | Meaning |
|---|---|
| `new` | Draft. Created via Add Topic. Editable. Not picked up by the worker. Operator clicks Start (per-row) or Start All to move it to `queued`. |
| `queued` | Ready to run. Worker picks the oldest `queued` video FIFO. |
| `in_progress` | Worker is executing the pipeline. |
| `done` | Finished successfully. Row moves to the Finished section. |
| `failed` | A step threw. Operator can Retry / Restart from the detail page. |

`delete_requested=1` is an out-of-band flag the UI sets when deleting an `in_progress` video. The orchestrator honors it between steps (section 15.3).

**Settings keys:**

| Key | Type | Default | Notes |
|---|---|---|---|
| `openrouter_script_model` | string | "" | OpenRouter model id used for script-writing steps (steps 01-05) when a video's workflow pins `script_llm_provider = openrouter`. |
| `openrouter_visual_model` | string | "" | OpenRouter model id used for visual-prompting calls (step 09 `generate_visual_prompts`, Google Flow moderation) when `script_llm_provider = openrouter`. |
| `claude_cli_script_model` | string | `claude-opus-4-7` | Model id passed to the Claude CLI for script-writing steps when `script_llm_provider = claude_cli`. Binary is hardcoded to `claude` and must be on PATH. |
| `claude_cli_visual_model` | string | `claude-opus-4-7` | Model id passed to the Claude CLI for visual-prompting calls when `script_llm_provider = claude_cli`. |
| `image_provider` | enum | `comfyui` | Image generation backend |
| `comfyui_base_url` | string | `http://127.0.0.1:8188` | ComfyUI API URL |
| `comfyui_workflow_path` | string | `prompts/comfyui/default-workflow.json` | Image workflow file (API format) |
| `comfyui_hook_video_workflow_path` | string | `prompts/comfyui/default-hook-video-workflow.json` | Text-to-video workflow file; user-supplied. Used by the ComfyUI video provider for chunks with `kind="clip"`. Key retains the "hook" prefix as a historic artifact. |
| `google_flow_image_model` | enum | `NARWHAL` | `NARWHAL` (Nano Banana 2) / `GEM_PIX_2` (Nano Banana Pro) / `IMAGEN_3_5` (Imagen 4) |
| `google_flow_video_model` | enum | `veo_3_1_t2v_lite_low_priority` | `veo_3_1_t2v_lite` (Veo 3.1 - Lite) / `veo_3_1_t2v_fast_ultra` (Veo 3.1 - Fast) / `veo_3_1_t2v` (Veo 3.1 - Quality) / `veo_3_1_t2v_lite_low_priority` (Lite [Lower Priority]) |
| `google_flow_aspect_ratio` | enum | `landscape` | `landscape` / `portrait` |
| `google_flow_account_cooldown_hours` | int | `4` | Pause length after a 429 / `RESOURCE_EXHAUSTED` from Flow |
| `google_flow_max_retries` | int | `3` | Transient-retry budget per queue row |
| `google_flow_dispatch_timeout_minutes` | int | `30` | Per-dispatch age cap enforced by the reaper |
| `google_flow_relogin_needed` | bool | `false` | Auto-set on `session_expired`; auto-cleared on next successful dispatch |
| `google_flow_content_moderation_enabled` | bool | `true` | When true, the Google Flow steps run an in-step moderation loop on content-policy failures (see §12b.7). |
| `google_flow_content_moderation_max_rounds` | int | `2` | Maximum prompt rewrites past the original attempt; 0..10. After the cap, the step throws with the original policy reasons. |
| `google_flow_content_moderation_model` | string | "" | Model id used by the moderator. Empty falls back to the workflow-pinned provider's visual model (`<provider>_visual_model`). |
| `aspect_ratio` | enum | `16:9` | `16:9` / `9:16` / `1:1` / `4:5` |
| `long_edge_px` | int | `1920` | Long edge in pixels; renderer derives W×H |
| `framerate` | int | `30` | 30 / 60 |
| `video_encoder` | enum | `libx264` | Stage CD H.264 encoder: `libx264` (software default) / `h264_nvenc` (NVIDIA) / `h264_amf` (AMD). Stages A and B keep libx264 regardless. See ADR-0004 for per-encoder args. |
| `hook_video_clip_seconds` | float | `8` | Per-clip duration for the ComfyUI video provider. 1..60. For Google Flow use `google_flow_hook_clip_seconds`. Key retains the "hook" prefix as a historic artifact. |
| `google_flow_hook_clip_seconds` | enum | `"8"` | `"4"` / `"6"` / `"8"`. Per-clip duration for the Google Flow video provider. Encoded into the dispatched Veo `videoModelKey`. Key retains the "hook" prefix as a historic artifact. |
| `hook_length_seconds` | int | `120` | Workflow-1 hook section length in seconds (only consumed by the `chunk_clips_then_images` chunker — caps the count of clip chunks at the start of the video). 4..400. Internal clip chunk count is derived as `round(seconds / clip)` per provider. Ignored by `chunk_images_only` and `chunk_clips_only`. |
| `script_length_minutes` | int | `90` | Total chapter narration length in minutes. 6..600. Internal chapter count is derived as `round(minutes / 6)` (so 90 → 15 chapters). |
| `image_chunk_target_seconds` | int | `8` | Per-chunk target for the images-only chunker. 2..60. Overridden per-video by `videos.image_chunk_target_seconds`. |
| `image_chunk_min_seconds` | int | `4` | Hard floor for the images-only chunker. 2..20. Overridden per-video by `videos.image_chunk_min_seconds`. |
| `image_chunk_max_seconds` | int | `12` | Soft ceiling for the images-only chunker. 4..60. A single oversized sentence is emitted anyway with a logged warning. Overridden per-video by `videos.image_chunk_max_seconds`. |
| `step_09_examples_json` | string | `""` | JSON array of exemplar scene objects rendered into the step 09 prompt as a `<good_examples>` block. Empty = no block. Validation is best-effort; invalid JSON degrades to an empty block. |
| `voice_id` | string | (required) | ElevenLabs voice ID (shared by both providers) |
| `voiceover_model_id` | enum | `eleven_multilingual_v2` | One of: `eleven_multilingual_v2`, `eleven_turbo_v2_5`, `eleven_flash_v2_5`, `eleven_v3` |
| `voice_stability` | float | `0.75` | 0–1 |
| `voice_similarity` | float | `0.5` | 0–1 |
| `voice_style` | float | `0.0` | 0–1 |
| `voice_speed` | float | `1.0` | 0.7–1.2 |
| `voice_use_speaker_boost` | bool | `true` | |

There is no `queue_state` / `queue pause` setting. Each video's `status` column is the only queue gate (see section 15).

**Render constants** (in `lib/render.ts`, not Settings):
```ts
export const CROSSFADE_SECONDS = 1.0;
export const ZOOM_TARGET = 1.275;     // final zoom factor (1.0 = no zoom)
```

Resolution is computed: `16:9 + long_edge=1920 → 1920×1080`; `9:16 + long_edge=1920 → 1080×1920`; etc.

---

## 5. Project Folder Layout

```
projects/<video_id>/
├── script/
│   ├── 01_outline.md
│   ├── 03_hook.md
│   ├── 04_outline_structured.json   # produced inside step 4 for debugging
│   ├── 04_chapter_01.md
│   ├── ...
│   ├── 04_chapter_15.md
│   ├── story_so_far.md              # running summary, updated after each chapter
│   └── full_script.md               # final concatenation, fed to TTS
├── audio/
│   ├── narration.mp3
│   ├── narration.srt               # AI33 transcript only (Chatterbox emits no transcript)
│   └── narration.json              # AI33 transcript JSON only (Chatterbox emits none)
├── alignment/
│   ├── sentences.txt                # one sentence per line, fed to aeneas
│   └── alignment.json               # [{ id, text, begin, end }]
├── chunks/
│   └── chunks.json                  # [{ id, kind, start, end, text, prompt }]
├── images/                          # generated by image provider, named by chunk_id
│   ├── image_001.png
│   └── ...
├── videos/
│   └── clip/                        # clips produced by the video provider, named by chunk_id
│       ├── clip_01.mp4
│       └── ...
├── render/                          # intermediate render files (deleted on retry)
├── pipeline.log                     # one log file for the whole pipeline
└── final.mp4                        # the deliverable
```

After cleanup: only `final.mp4`, `script/full_script.md`, and `pipeline.log` remain.

Clips are produced directly as text-to-video by the video provider — there is no intermediate image-from-prompt step for clip chunks. The render step reads `videos/clip/<chunk_id>.mp4` whichever workflow produced them. Workflows without a `video_provider` (e.g. `google-flow-images-only`) produce no `videos/clip/` directory; workflows without an `image_provider` (e.g. `google-flow-clips-only`) produce no `images/` directory.

---

## 6. Pipeline Step List

The step sequence is determined by the video's `workflow_id` via the workflow registry (§19); the registry materializes a flat step list per video at queue time. Four workflows ship today, differing in their chunker step and their provider mix (see §19.2).

### 6.1 Script-stage steps (run in every workflow)

| # | Slug | Inputs | Outputs |
|---|---|---|---|
| 1 | `research_outline` | title, topic_info, audience_profile, script_length_minutes | `script/01_outline.md` |
| 2 | `write_hook` | `01_outline.md`, title | `script/03_hook.md` |
| 3 | `write_chapters` (loop) | outline, hook, story_so_far | `04_outline_structured.json`, `04_chapter_NN.md` × N, `story_so_far.md` |
| 4 | `assemble_script` | hook + all chapter files | `script/full_script.md` |
| 5 | `voiceover` | `full_script.md` | `audio/narration.mp3`, `audio/narration.srt`, `audio/narration.json` |
| 6 | `align` | `full_script.md`, `narration.mp3` | `alignment/alignment.json` |

`write_hook` writes a short opening prologue regardless of workflow — its output is part of the script that flows through `assemble_script` → `voiceover`. Only `chunk_clips_then_images` differentiates its first N chunks as clip chunks; the other two chunkers ignore that boundary entirely.

### 6.2 Chunker step (workflow-selected, one of three)

The workflow row's `chunker_step` column picks one chunker:

| Slug | Inputs | Outputs | Chunk kinds emitted |
|---|---|---|---|
| `chunk_clips_then_images` | `alignment.json`, `hook_length_seconds`, provider clip-seconds | `chunks/chunks.json` | first N chunks `kind="clip"` (ids `clip_NN`), rest `kind="image"` (ids `image_NNN`) |
| `chunk_images_only` | `alignment.json` | `chunks/chunks.json` | every chunk `kind="image"` (ids `image_NNN`) |
| `chunk_clips_only` | `alignment.json`, provider clip-seconds | `chunks/chunks.json` | every chunk `kind="clip"` (ids `clip_NNN`) |

See §10 for partition rules and id-width conventions. All three chunkers share the helpers in `chunk-utils.ts` (`makeChunk`, `findGroupEnd`, `MAIN_TARGET_SECONDS`).

### 6.3 Visual-prompt + asset steps

| # | Slug | Inputs | Outputs |
|---|---|---|---|
| 9 | `generate_visual_prompts` | `chunks.json`, `videos.visual_style_snapshot.prompt` (empty when NULL) | `chunks.json` (with prompts) |
| — | `generate_images` | image-kind chunks + prompts | `images/<chunk_id>.png` (via `snapshot.image_provider`; skipped if null) |
| — | `generate_clips` | clip-kind chunks + prompts | `videos/clip/<chunk_id>.mp4` (via `snapshot.video_provider`; skipped if null) |

Both asset steps are provider-agnostic: each filters `chunks.json` by the matching `kind`, then dispatches to the provider pinned by the workflow snapshot (currently `comfyui` or `google_flow`). The dispatch lives in `lib/image/index.ts` / `lib/video/index.ts`; see §12 (ComfyUI) and §12b (Google Flow) for per-provider behaviour. A workflow whose `image_provider` is null omits `generate_images` from its step list; same for `video_provider` / `generate_clips`.

### 6.4 Trailing shared steps (run in every workflow)

| # | Slug | Inputs | Outputs |
|---|---|---|---|
| 14 | `render` | `images/`, `videos/clip/`, `narration.mp3`, `chunks.json` | `final.mp4` |
| 15 | `cleanup` | — | deletes intermediate files |

Non-script steps drop the numeric prefix because workflow registries, not file-system order, determine execution. Script steps retain their `01-…15-` prefixes for human navigation.

### 6.4 Step contract

Each step is `run(videoId, ctx): Promise<void>`:
1. Read inputs from disk.
2. Do work, writing outputs to disk **incrementally** where possible.
3. Return without throwing on success → runner flips the step row to `done`.
4. On throw → runner sets step row `failed`, deletes the failing step's *own* artifacts (declared via `Step.outputs`, unless the step overrides `cleanup`), appends error to `pipeline.log`, marks video `failed`, moves to the next queued video. A per-video failure does **not** pause any other video.
5. On worker restart with an `in_progress` video: runner finds the first non-`done` step and runs it.

**Sub-resume in `write_chapters`:** the loop checks for `04_chapter_NN.md` on disk before generating chapter N. If present, skip. If chapter 7 fails, only chapter 7's file is deleted; chapters 1–6 stay; on resume the loop picks up at 7. The step is marked `failed` only if a chapter call exhausts its retries.

---

## 7. Script Chain Detail

### 7.1 Outline (`research_outline`)
Reads `prompts/01_research_outline.md` (adapted from `research_prompt.txt`).
Variables: `{{title}}`, `{{topic_info}}`, `{{audience_profile}}`, `{{chapter_count}}`, `{{banned_words}}`, `{{numbers_as_letters}}`. The `{{chapter_count}}` variable is interpolated from the derived count (`round(script_length_minutes / 6)`), not a settings key.

Title and topic_info are read directly from the `videos` row.

### 7.2 Hook (`write_hook`)
Reads `prompts/03_write_hook.md` (synthesized from `hook.txt` + `hook_2.txt`).
Variables: `{{title}}`, `{{outline}}`, `{{numbers_as_letters}}`, `{{banned_words}}`.
Output: 250–400 word cold-open prologue.

### 7.3 Chapters loop (`write_chapters`)

This step does its own structure extraction internally before looping.

**Phase A — extract structure (once per step run, idempotent):**
If `04_outline_structured.json` doesn't exist, call LLM with `prompts/04_extract_structure.md`:
> Extract the chapters from this outline as JSON. Output exactly: `[{ "number": 1, "title": "...", "summary": "..." }, ...]`. Output JSON only, no prose.

Parse and write `04_outline_structured.json`.

**Phase B — chapter loop:**
For `i` in 1..N (where N is the derived chapter count from `script_length_minutes`):
1. If `04_chapter_<i>.md` already exists on disk, skip (sub-resume).
2. Build context: outline + structured chapter `i` + `story_so_far.md` (empty on first iteration).
3. Read `prompts/04_write_chapters_batch.md`.
4. Call LLM → `04_chapter_<i>.md` (1100–1300 words).
5. Call LLM with `prompts/04_story_so_far.md` to update the running summary (~200 words). Overwrite `story_so_far.md`.

### 7.4 Assemble (`assemble_script`)
Concatenate `03_hook.md` + `04_chapter_01.md` + ... + `04_chapter_15.md` with double newlines → `full_script.md`.

### 7.5 Shared prompt fragments
- `_shared/audience_profile.md` — AUDIENCE_PROFILE block.
- `_shared/banned_words.md` — BANNED_WORDS block.
- `_shared/format_guidelines.md` — third-person, no headings, no line breaks within paragraphs, etc.
- `_shared/numbers_as_letters.md` — "Spell all numbers and dates as words."

The prompt loader inlines shared fragments at load time and substitutes `{{var}}` placeholders.

### 7.6 Ready-script variant (skip script generation)

When `videos.provided_script` is non-null, the operator has supplied a pre-written script and steps `research_outline`, `write_hook`, `write_chapters`, and `assemble_script` are skipped. `topic_info` is irrelevant for the run; the dashboard stores the sentinel `"[ready script — generation skipped]"` in that column to satisfy the existing NOT NULL constraint.

**Queue-time prep** is route-side, not orchestrator-side. `applyReadyScriptArtifacts(db, videoId)` (in `lib/ready-script.ts`) is called after `transitionNewToQueued` (single-row start), inside the `start-all` loop (bulk start), after `restart` wipes the project dir, and after a PATCH that sets `provided_script` on a row already in `queued`. It is a no-op for topic-driven videos. Sequence:

1. SELECT `provided_script` + `workflow_snapshot` for `videoId`. Return early if `provided_script` is null.
2. `mkdirSync(projects/<id>/script)`, sanitize the script via `lib/script-sanitize.ts` (em-dashes → commas — the AI33 / GenAIPro voiceover providers fail on `—`, and the same sanitizer is what step 5 runs on LLM-generated scripts), write `script/full_script.md`.
3. In one SQL transaction: `INSERT OR IGNORE` a `done` row into `video_steps` for every script-module step name in `snapshot.steps` plus the literal `"assemble_script"`. `INSERT OR IGNORE` is required because the orchestrator's pre-loop `upsertPending` runs later and must not overwrite the pre-marked rows.

The orchestrator's existing skip-done logic (`if step_row.status == 'done': continue`, §15.3) advances straight to `voiceover`. No orchestrator changes are needed — ready-script support is purely additive.

**Failure cases:** FS write failure propagates as a 500 from the route; SQL insert failure (rare on `INSERT OR IGNORE` over a tiny table) leaves the file on disk but no done rows, in which case the orchestrator would re-run script generation against the sentinel — accepted risk, no compensating rollback.

**Out of scope:** pre-aligned or pre-chunked input (the contract is `full_script.md` only); switching a ready-script video back into a topic-driven video via Edit (delete and re-create); auto-derivation of title from script content.

---

## 8. Voiceover (`voiceover`)

The voiceover step uses the TTS provider registry (`lib/tts/`). The active provider is selected from `snapshot.tts_provider` (`"ai33"`, `"genaipro"`, or `"chatterbox"`) — pinned per video at queue time, mirroring how `image_provider` and `video_provider` are resolved.

Three providers are bundled. AI33 and GenAIPro are ElevenLabs-compatible cloud APIs that follow a submit/poll/sidecar pattern. Chatterbox is a local HTTP service (`devnen/Chatterbox-TTS-Server`, port 8004) with synchronous WAV output — no API key, no polling, no sidecar transcripts.

### 8.1 AI33 (ElevenLabs-compat cloud)

AI33 is an ElevenLabs-compatible TTS cloud API. The step reads `full_script.md`, submits the full text in one call, polls for completion, then downloads the MP3 and optional transcript files. This sub-section documents the AI33 wire format; the GenAIPro client uses Bearer-token auth, a flat submit body at `https://genaipro.vn/api/v1/labs/task`, an opt-in subtitle export, and the same voice-tuning settings — see `src/lib/tts/genaipro.ts` and `docs/tts/genaipro/genaipro_api.md`.

**Submit:**
```http
POST https://api.ai33.pro/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128
xi-api-key: ${AI33_API_KEY}
Content-Type: application/json

{
  "text": "<full_script>",
  "model_id": "eleven_multilingual_v2",
  "with_transcript": true,
  "voice_settings": {
    "stability": 0.75,
    "similarity_boost": 0.5,
    "style": 0,
    "speed": 1,
    "use_speaker_boost": true
  }
}
```
Response: `{ "success": true, "task_id": "abc123", "ec_remain_credits": 1234 }`.

**Poll:**
```http
GET https://api.ai33.pro/v1/task/{task_id}
xi-api-key: ${AI33_API_KEY}
```
Response: `{ "id": "...", "status": "doing|done|error", "error_message": "...", "metadata": { "audio_url": "...", "srt_url": "...", "json_url": "..." }, "progress": 50, "type": "tts" }`.

Polling cadence: 30s. No overall timeout.

**Download:** On `status === "done"`, download:
- `metadata.audio_url` → `audio/narration.mp3`
- `metadata.srt_url` → `audio/narration.srt` (if present)
- `metadata.json_url` → `audio/narration.json` (if present)

Transcript files are saved for future use (not currently consumed by the alignment step).

**Failure handling:** 2–3 retries with exponential backoff on submit; on `status === "error"`, mark step failed and move on.

**Config:** Voice tuning params come from Settings (section 4), not env. Provider API keys (`AI33_API_KEY`, `GENAIPRO_API_KEY`) live in `.env`.

### 8.2 Chatterbox (local HTTP)

Chatterbox is a local TTS server (`devnen/Chatterbox-TTS-Server`, default port 8004). The step issues a single synchronous `POST /tts`, receives WAV audio in the response body, and transcodes to MP3 via piped ffmpeg before writing `audio/narration.mp3`. No submit/poll, no sidecar — alignment runs in section 9 (aeneas) directly from the MP3.

**Submit:**
```http
POST {chatterbox_base_url}/tts
Content-Type: application/json

{
  "text": "<full_script>",
  "voice_mode": "predefined" | "clone",
  "predefined_voice_id": "<filename>",      // when voice_mode === "predefined"
  "reference_audio_filename": "<filename>", // when voice_mode === "clone"
  "output_format": "wav",
  "speed_factor": 1.0
}
```
Response: WAV bytes (full body). The provider transcodes WAV→MP3 inline via piped ffmpeg.

**Settings keys:** `chatterbox_base_url`, `chatterbox_voice_mode` (`"predefined"` | `"clone"`), `chatterbox_voice_filename`. Tuning: `chatterbox_temperature`, `chatterbox_exaggeration`, `chatterbox_cfg_weight`, `chatterbox_speed_factor` (range 0.25–4, mapped to the wrapper's `speed_factor` field). The ElevenLabs-shaped sliders (`voice_id`, `voiceover_model_id`, `voice_stability`, `voice_similarity`, `voice_style`, `voice_speed`, `voice_use_speaker_boost`) are not consumed by Chatterbox.

**Watermark:** Every output carries Resemble AI's Perth perceptual watermark (inaudible). Operators should know the rendered narration carries this watermark.

**Setup:** See `docs/setup-guides/setup-chatterbox.md` for installing and verifying the local Chatterbox server (Python 3.10, NVIDIA CUDA, devnen wrapper, port 8004 verification).

---

## 9. Alignment (`align`) — aeneas via WSL

**Pre-processing (Node side):**
1. Load `full_script.md`.
2. Sentence-split with a JS splitter (`sbd` or similar).
3. Write one sentence per line to `alignment/sentences.txt`.

**Invoke aeneas:**
```ts
spawn("wsl", [
  "-d", process.env.WSL_DISTRO,
  "python3",
  wslPath(absPath("python/align.py")),
  "--audio", wslPath(absPath("projects/<id>/audio/narration.mp3")),
  "--text",  wslPath(absPath("projects/<id>/alignment/sentences.txt")),
  "--out",   wslPath(absPath("projects/<id>/alignment/alignment.json")),
])
```

`wslPath()` is a small helper: `C:\Users\x\histforge\foo` → `/mnt/c/Users/x/histforge/foo`. Implemented as a string transform in `lib/align.ts`.

`align.py` uses aeneas's `ExecuteTask` API with config:
```
task_language=eng|is_text_type=plain|os_task_file_format=json
```

Output `alignment.json`:
```json
[
  { "id": "f000001", "text": "On the morning of January twenty-second...", "begin": 0.0, "end": 4.83 },
  ...
]
```

No confidence scoring in v1. If drift becomes visible, swap for WhisperX behind the same `lib/align.ts` interface.

---

## 10. Chunking

The workflow row's `chunker_step` column selects one of three chunker step files at materialization time (§19); each produces the same `chunks/chunks.json` shape but emits a different mix of `kind` values. Shared helpers live in `src/worker/steps/chunk-utils.ts`.

**Common shape:**
```json
[
  { "id": "<id>", "kind": "clip" | "image", "start": 0.0, "end": 8.1, "text": "...", "prompt": null },
  ...
]
```

The sum of all chunk durations equals the audio length exactly (no gaps, no overlaps in chunking — overlaps come later from xfade). A chunk's `id` is the filesystem binding to its visual asset: clip chunks bind to `videos/clip/<id>.mp4`, image chunks bind to `images/<id>.png`.

### 10.1 `chunk_clips_then_images` (workflow-1 chunker)

1. Load `alignment.json`.
2. **Clip section:** walk sentences from t=0 accumulating ~`clip_seconds` per group, cutting at the nearest sentence boundary. Emit up to `round(hook_length_seconds / clip_seconds)` clip chunks (or fewer if sentences run out first — never empty groups). `clip_seconds` is provider-resolved: `google_flow_hook_clip_seconds` when the workflow's `video_provider` is `google_flow`, else `hook_video_clip_seconds`. Each clip chunk is intended to map 1:1 to a provider clip, so its duration tracks the provider's nominal clip length. Mark `kind: "clip"`, ids `clip_01..clip_NN` (2-digit, capped at the configured count).
3. **Image section:** from where the clip section ended, walk sentences accumulating duration. When the running total reaches ~`MAIN_TARGET_SECONDS` (30 s), cut at the nearest sentence boundary (slightly before or after, whichever is closer). Start a new chunk. Mark `kind: "image"`, ids `image_001..image_NNN` (3-digit, unbounded).

This is the workflow-1 topology — a short, clip-paired opening followed by an image-paired body.

### 10.2 `chunk_images_only` (workflow-2 chunker)

Single loop over the full narration. Walk sentences accumulating ~`MAIN_TARGET_SECONDS` (30 s) per group, cutting at the nearest sentence boundary. Every chunk gets `kind: "image"`, ids `image_001..image_NNN` (3-digit, unbounded). No clip section, no `hook_length_seconds` cap.

### 10.3 `chunk_clips_only` (workflow-3 chunker)

Single loop over the full narration. Walk sentences accumulating ~`clip_seconds` per group (provider-resolved as in §10.1), cutting at the nearest sentence boundary. Every chunk gets `kind: "clip"`, ids `clip_001..clip_NNN` (3-digit, unbounded — worst case ≈ `hook_length_seconds / clip_seconds = 100`). No `hook_length_seconds` cap; the chunker runs until sentences are exhausted. `hook_length_seconds` is ignored.

### 10.4 Optional moderation field

The Google Flow content-moderation loop (§12b.7) may add an optional `prompt_history: string[]` field to a chunk: oldest-first list of prior `prompt` values written by rewrites, with the current `prompt` excluded. The field is optional for back-compat with older `chunks.json` files; consumers must coalesce undefined to `[]` before pushing. `generate_visual_prompts` resets it to `[]` in a single eager sweep over the to-regenerate subset before any LLM call.

---

## 11. Visual prompt generation (`generate_visual_prompts`)

For every chunk whose `prompt` is null, the step requests a visual prompt from the LLM in **batched JSON envelopes**, run concurrently per-provider. Already-prompted chunks (`chunk.prompt !== null`) are skipped on entry — the step is resume-safe by default. To force regeneration from scratch, roll back to the workflow's chunker step, which rewrites `chunks.json` with `prompt: null` everywhere.

**Batched JSON envelope.** Chunks in the to-regenerate subset are sliced into K-sized batches (`visual_prompts_batch_size`, default 8, range 1–16). Each batch renders `prompts/09_generate_visual_prompts.md` with a JSON array of `{id, prev_text, current_text, next_text}` plus the global style prompt; the LLM is asked to return `{"prompts": [{"id": "<chunk_id>", "prompt": "<string>"}]}` with no preamble, no commentary, no markdown fences. ID-keyed validation rejects missing, extra, or duplicate IDs and empty-string `prompt` values. K=1 disables batching as an escape hatch. Same envelope pattern as the content moderator (`prompts/moderate_blocked_prompts.md`).

**Per-provider concurrency.** Batches run in parallel up to a provider-specific limit resolved from the workflow-pinned `script_llm_provider`: `claude_cli_visual_prompts_concurrency` (default 2, range 1–8 — Claude Code Max RPM cap + ~200 MB per process) or `openrouter_visual_prompts_concurrency` (default 8, range 1–32 — HTTP-bound, headroom on visual-tier models).

**Parse-failure recovery: retry-then-per-chunk fallback.** On a strict-validation failure the same batch is retried once with a stricter envelope reminder appended (same `MAX_PARSE_ATTEMPTS = 2` cadence as the moderator). On a second failure the batch falls back to per-chunk calls for just its K chunks; other in-flight batches continue at full concurrency. A per-chunk call that itself parse-fails twice is a step failure.

**Eager `prompt_history` reset.** Before the batch loop starts, `prompt_history` is set to `[]` on every chunk in the to-regenerate subset and `chunks.json` is written once. This closes the inconsistent-partial-state window the old per-iteration reset opened.

**Persistence.** `chunks.json` is rewritten once per settled batch through an in-process async mutex (no torn JSON under concurrent batches). Atomic `tmp + rename` writes are a deferred follow-on across all `chunks.json` writers. Worst-case crash loss is `concurrency × K` unwritten chunks (16 under defaults), strictly better than the previous whole-step regen.

Style prompt source: `videos.visual_style_snapshot.prompt` (full-row JSON mirror of the chosen `visual_styles` entry, pinned at `createNewVideo` and re-pinned at `transitionNewToQueued`; mirrors the `workflow_snapshot` pattern). The operator picks a `visual_styles` entry on the topic-creation modal or leaves it as "Default", in which case `visual_style_id` is `NULL`, the snapshot is `NULL`, and step 09 injects the empty string. The gallery itself is operator-managed CRUD under Settings > Visual Style. See ADR-0010 for the `ON DELETE SET NULL` rationale.

---

## 12. ComfyUI provider (images + clips)

When a workflow's `image_provider` or `video_provider` is `comfyui`, the provider-agnostic `generate_images` / `generate_clips` step dispatches to the ComfyUI client (`src/lib/image/comfyui.ts`). ComfyUI is a local Stable Diffusion UI with an HTTP API; the same HTTP flow works for image outputs and video outputs by pointing at different workflow JSON files.

See `docs/comfyui/setup-comfyui.md` for installation and checkpoint setup.

### 12.1 Shared HTTP flow

For each item (image or clip):
1. Load workflow JSON from the configured path (`comfyui_workflow_path` for images, `comfyui_hook_video_workflow_path` for clips — key name retains the "hook" prefix as a historic artifact).
2. Inject the chunk's prompt into the positive-prompt node (marked with `_histforge_prompt: true`, or the first `CLIPTextEncode` by node ID).
3. For images only: inject width/height into the `EmptyLatentImage` node, computed from `aspect_ratio` and `long_edge_px`.
4. `POST /prompt` to `comfyui_base_url` → returns `{ prompt_id }`.
5. Poll `GET /history/{prompt_id}` until the output is available (or error).
6. Download the output via `GET /view?filename=...` and write to the target file path.

Items are processed sequentially (ComfyUI queues internally). Resume semantics: existing output files are skipped.

**Error handling:**
- ComfyUI unreachable → clear error message with the configured URL.
- ComfyUI execution error → extracted from `/history` response and thrown.
- Missing output after poll → treated as a step failure; `render` falls back to a placeholder frame if an image is missing at render time.

### 12.2 Image generation (via `generate_images`)

`generate_images` reads `chunks/chunks.json`, filters `kind === "image"`, and when `snapshot.image_provider === "comfyui"` calls the ComfyUI image generator. Output: `images/<chunk_id>.png`.

### 12.3 Clip generation (via `generate_clips`)

`generate_clips` reads `chunks/chunks.json`, filters `kind === "clip"`, and when `snapshot.video_provider === "comfyui"` loads the clip workflow JSON. Output: `videos/clip/<chunk_id>.mp4`.

The clip workflow goes text-to-video directly — there is no intermediate image-from-prompt step. The workflow JSON is user-supplied at the path configured by `comfyui_hook_video_workflow_path` (SVD, AnimateDiff, Wan, LTX, etc. — HistForge doesn't care which node graph as long as it exposes a positive-prompt node and a video output node). If the path doesn't resolve, the step throws a clear "drop your ComfyUI video workflow at X" error.

Video-output extraction looks for the first node whose class is `SaveVideo`, `VHS_VideoCombine`, or any class whose declared output type is `VIDEO`. This flexibility is deliberate — which model the user wires is their choice.

### 12.4 Default image workflow

Ships at `prompts/comfyui/default-workflow.json` — a minimal SDXL workflow: `CheckpointLoaderSimple` → `CLIPTextEncode` (positive + negative) → `KSampler` → `VAEDecode` → `SaveImage`. See `prompts/comfyui/README.md` for customization.

A default clip workflow is *not* shipped — the user drops their own at `prompts/comfyui/default-hook-video-workflow.json` (or changes the setting to point somewhere else).

---

## 12b. Google Flow provider (hybrid executor)

When a workflow's `image_provider` or `video_provider` is `google_flow`, the provider-agnostic `generate_images` / `generate_clips` step dispatches to the Google Flow client. Google Flow generates images and clips by driving `labs.google/fx/tools/flow` through a forked Chrome extension (**YouForge Flow**), with HistForge owning the queue, per-account cooldown state, and result storage. No Playwright and no Google API — users sign into Flow manually in one Chrome profile per account; the extension drives that session.

See `docs/setup-guides/setup-google-flow.md` for installation and account onboarding.

### 12b.1 Architecture

HistForge is the source of truth for work and accounts; the extension is a dumb runner. Up to four accounts can run in parallel (each capped around 300 clips/day by Google). When every account is simultaneously in cooldown, the Flow step returns a defer sentinel and the orchestrator moves to the next video.

```
┌──────────────────────┐        ┌─────────────────────────────────────┐
│ HistForge (Node)     │        │ Chrome profile × N                  │
│  • worker + pipeline │        │ (one per Google account,            │
│  • google_flow_queue │        │  persistent login)                  │
│  • 30 s reaper       │        │ ┌───────────────────────────────┐   │
│  • webhook routes ◄──┼────────┼─┤ YouForge Flow extension       │   │
│                      │────────►─┤  poll → run Flow → submit     │   │
│                      │        │ └───────────────────────────────┘   │
└──────────────────────┘        └─────────────────────────────────────┘
```

The extension lives at `extensions/youforge-flow/` — forked from a third-party VEO API extension and stripped of Baserow / n8n / remote-control baggage; pristine upstream is retained at `extensions/veo-upstream/` as a reference copy for future diffs.

### 12b.2 Webhook endpoints

Each account is issued a URL-safe token that appears in the URL path **and** the request body; the handler rejects any mismatch. Endpoints are otherwise unauthenticated — HistForge is assumed to be localhost-bound in v1.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/flow/next-task/[token]` | Extension polls for work. Resolves account, clears expired cooldown in the same statement, atomically claims one `pending` queue row, returns it (or `{}`). Every dispatched task carries `imageModel` and `videoModel`, read fresh from settings per dispatch so a settings change is honoured by the next dispatch without a queue-schema migration. |
| POST | `/api/flow/submit-result/[token]` | Extension submits an `external_task_id` with `resultUrl` or `error`. Classifies errors (content-policy → permanent fail; 429 / `RESOURCE_EXHAUSTED` → account cooldown + requeue; transient → retry within `google_flow_max_retries`), validates the result host against an SSRF allowlist, streams the media into `projects/<video_id>/<output_path>`, and marks the row done/failed. State-tolerant: stale submissions for already-`done` rows return `{success: true, duplicate: true}` so the extension doesn't enter its retry storm. |
| POST | `/api/flow/status/[token]` | Extension reports `session_expired` (sets the global `google_flow_relogin_needed` flag — does **not** pause the account; the extension self-halts) or `credits` (advisory credit count for the dashboard). |

Plus a dashboard-only surface: `GET/POST /api/flow/accounts`, `PATCH/DELETE /api/flow/accounts/[id]`, `GET /api/flow/queue-summary/[videoId]`, and `POST /api/flow/requeue-failed/[videoId]`.

### 12b.3 Queue model

```sql
CREATE TABLE google_flow_accounts (
  id                 TEXT PRIMARY KEY,         -- slug, e.g. acc_01
  name               TEXT NOT NULL,
  token              TEXT NOT NULL UNIQUE,
  quota_used_today   INTEGER NOT NULL DEFAULT 0,
  paused_until       INTEGER,                  -- unix seconds; 429 cooldown or manual pause
  last_seen_at       INTEGER,                  -- liveness signal from polls
  credits            INTEGER,                  -- advisory, last reported by extension
  credits_updated_at INTEGER,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL
);

CREATE TABLE google_flow_queue (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id             TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  chunk_id             TEXT,
  kind                 TEXT NOT NULL,          -- image | clip
  mode                 TEXT NOT NULL,          -- createImage | text | image | frames
  prompt               TEXT NOT NULL,
  reference_image      TEXT,
  start_frame          TEXT,
  end_frame            TEXT,
  output_path          TEXT NOT NULL,          -- relative to project dir
  status               TEXT NOT NULL,          -- pending | dispatched | done | failed
  assigned_account_id  TEXT REFERENCES google_flow_accounts(id) ON DELETE SET NULL,
  external_task_id     TEXT,                   -- `${id}_${dispatched_at}`
  result_url           TEXT,
  error_reason         TEXT,
  retry_count          INTEGER NOT NULL DEFAULT 0,
  moderation_round     INTEGER NOT NULL DEFAULT 0,  -- rewrites past original; see §12b.7
  priority             INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  dispatched_at        INTEGER,
  completed_at         INTEGER
);
CREATE INDEX idx_google_flow_queue_pickup ON google_flow_queue(status, priority, id);

CREATE TABLE moderation_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id          TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  chunk_id          TEXT NOT NULL,
  kind              TEXT NOT NULL,            -- image | clip
  round             INTEGER NOT NULL,         -- 1-indexed; matches the queue row's moderation_round after rewrite
  original_prompt   TEXT NOT NULL,
  rewritten_prompt  TEXT NOT NULL,
  reason_tag        TEXT,                     -- nullable: extracted policy code or null when none matched
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_moderation_events_video_created ON moderation_events(video_id, created_at);

CREATE TABLE google_flow_video_projects (
  video_id         TEXT NOT NULL,
  account_id       TEXT NOT NULL,                 -- soft ref; no FK (orphan-by-design on account delete)
  flow_project_id  TEXT NOT NULL,                 -- Google Flow project UUID, created by the extension
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (video_id, account_id),
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);
```

Deleting a video cascades its queue rows, per-account project mappings, and moderation events; deleting an account nulls out references on historical queue rows and leaves project mappings in place as orphan pointers (operator policy: never delete Flow-side projects). The per-(video, account) project mapping is populated by the extension on first dispatch via `POST /api/flow/project/[token]` and read back on every subsequent `next-task` so each account always reuses its own project for a given video.

`moderation_round` is 0 for the original prompt and increments each time the in-step moderation loop rewrites the row (see §12b.7). It is a separate dimension from `retry_count`, which counts transient retries — a moderation rewrite preserves `retry_count`. Pre-existing rows on upgraded DBs default to 0; the next moderation pass treats them as round 0 and rewrites to round 1.

The dispatch-qualified `external_task_id` (e.g. `"7_1745168400"`) lets the reaper requeue a stuck row without the extension's in-memory dedup set (upstream `processedJobIds`) rejecting the retry — `requeueTask` clears the field so the next claim mints a fresh id. HistForge never parses this value; all lookups are equality-only.

The atomic claim uses a single `db.transaction()`: `SELECT id … WHERE status='pending' ORDER BY priority DESC, id ASC LIMIT 1` followed by `UPDATE … WHERE id=? AND status='pending' RETURNING *`. Contention between parallel polls from different accounts resolves deterministically — exactly one claim succeeds.

### 12b.4 Event-driven quota + defer semantics

Quota is **event-driven**: HistForge does not track a daily cap or projected reset time. An account is paused only by an observed 429 / `RESOURCE_EXHAUSTED` on `submit-result` (cooldown is `google_flow_account_cooldown_hours`, default 4 h) or by a manual pause from the dashboard. `paused_until <= now()` is detected on the next `next-task` request and cleared atomically (also zeroing `quota_used_today`).

The Flow step enqueues its chunks then calls a shared `waitForFlowQueue(videoId, kind)` helper that polls `countByStatusForVideo` every 5 s. Three terminal conditions:

- **All rows terminal** (`done` + `failed`) — step returns normally (failures throw an aggregated error).
- **Stalled**: no account is available (all paused or disabled) **and** no rows are `dispatched`. Helper returns `{ok: false, reason: "stalled", retryAfter}` where `retryAfter` is the earliest `paused_until` across enabled accounts.
- **Timeout**: 24 h of wall-clock wait per re-entry.

On stall, the step returns the defer sentinel `{deferred: true, retryAfter}`. `pipeline.ts` widens `Step.run`'s return type to `Promise<void | DeferSignal>`; the call site inspects the sentinel, leaves the step row in `running`, sets `videos.deferred_until`, and returns from the per-video loop without advancing. Video status stays `in_progress`. Both `findOldestQueuedId` and `findInProgressId` filter out rows whose `deferred_until > unixepoch()` so the runner picks something else to do. The orthogonal `anyInProgressExists` does **not** filter defers — the one-at-a-time invariant still sees the deferred video.

### 12b.5 Reaper + watcher

A 30 s interval in the worker process (separate from the main event loop) performs three passes:

1. Requeue `dispatched` rows whose account's `last_seen_at` is older than 10 minutes, or whose account is `enabled=0`.
2. Requeue `dispatched` rows whose age exceeds `google_flow_dispatch_timeout_minutes`, regardless of account liveness — catches the case where polling is healthy but a specific dispatch silently dropped.
3. Clear `videos.deferred_until` early when any account becomes available and the video still has `pending` rows. Videos with no pending rows are left alone (either done or fell through into failure).

On worker boot, `resetAllDispatchedOnStartup` flips every `dispatched` row back to `pending` (and clears `external_task_id` so the next dispatch re-qualifies). Late submissions for reclaimed rows are accepted by the state-tolerant `submit-result` handler and resolve cleanly.

### 12b.6 Google Flow dispatch from `generate_images` / `generate_clips`

When the provider-agnostic asset step dispatches to Google Flow (`snapshot.image_provider === "google_flow"` for `generate_images`, `snapshot.video_provider === "google_flow"` for `generate_clips`), the shape is the same: read `chunks/chunks.json`, filter by `kind`, for each chunk:

- Skip if the output file already exists on disk (resume behavior, matches the ComfyUI dispatch).
- Skip if `findOpenTaskForChunk` returns a non-terminal queue row (idempotent re-entry).
- Otherwise `enqueueTask` with the chunk's visual prompt; warn-and-skip chunks whose prompt is `null`.

Then call `waitForFlowQueue`. On the defer sentinel, return it verbatim; on timeout, throw; on any `failed` row, throw an aggregated error listing failed chunks and reasons. Before a clean return, the step calls `clearDeferredUntil(videoId)` so a stale defer from a prior pass is wiped.

If zero chunks are enqueueable **and** no existing output files are on disk (every prompt is null — a `generate_visual_prompts` gap), the step throws rather than silently succeed and hand `render` an empty directory.

- `generate_images` (Google Flow dispatch) — filters `kind === "image"`, mode=`createImage`, output `images/<chunk_id>.png`.
- `generate_clips` (Google Flow dispatch) — filters `kind === "clip"`, mode=`text` (text-to-video), output `videos/clip/<chunk_id>.mp4`. Matches the ComfyUI clip shape so `render` is provider-agnostic.

### 12b.7 Content-policy moderation loop

Google Flow's image and video models apply visual-safety and audio-safety filters; rejected prompts come back through `submit-result` tagged with codes like `CHILD_DANGER`, `SAFETY`, `VIOLENCE`, `PERSON_GENERATION`, `PUBLIC_ERROR_DANGER_FILTER`, `PUBLIC_ERROR_AUDIO_FILTERED`. Without intervention these failures are permanent — the row is `failed` and the step throws once the wait drains.

Both Google Flow dispatch paths (`generate_images` and `generate_clips`) run an in-step moderation loop that rewrites those prompts via an LLM and requeues. The loop runs *after* `waitForFlowQueue` returns and *before* the missing-file aggregation throws.

**Round semantics.** `google_flow_content_moderation_max_rounds = N` (default 2) caps the rewrites past the original generation attempt. Valid rounds are 1..N inclusive; a row that has already been through round N and is still failing causes the step to throw with the original policy reasons. `moderation_round = 0` on a fresh row; `requeueWithNewPrompt` bumps it to the new round and clears `error_reason`.

**Per-iteration flow.**
1. Read `google_flow_content_moderation_enabled`; if false, skip straight to the existing aggregation throw.
2. Select failed rows for `(video_id, kind)` whose `error_reason` matches the moderator-eligibility predicate (`isContentPolicyError` in `src/lib/flow-error-classify.ts`). It matches the canonical content-policy shapes that `submit-result` uses for inbound routing, plus Veo's generic `MEDIA_GENERATION_STATUS_FAILED` fall-through — a row that exhausted transient retries with that signature and no explicit policy tag is almost certainly deterministic, so the moderator gets a rewrite shot.
3. `nextRound = max(moderation_round) + 1` over those rows; if `nextRound > max_rounds`, fall through to the throw.
4. Build a batch payload of `{id, kind, reason_tag, prev_text, current_text, next_text, original_prompt}` and call the moderator (model from `google_flow_content_moderation_model`, falling back to the workflow-pinned provider's visual model). The prompt template lives at `prompts/moderate_blocked_prompts.md` and substitutes the batch as JSON into a single `{{batch_json}}` placeholder; the LLM returns `{rewrites: [{id, rewritten_prompt}, ...]}`.
5. **Atomic write order:** prepare an in-memory updated `chunks.json`; in a single SQLite transaction insert one `moderation_events` row per rewrite and call `requeueWithNewPrompt(id, rewritten, nextRound)`; after commit, write `chunks.json` once.
6. Re-enter `waitForFlowQueue`. Loop until either no content-policy failures remain, or `nextRound > max_rounds`.

**Crash safety.** A crash before the transaction leaves no state changed. A crash mid-transaction is rolled back by SQLite. A crash between commit and the `chunks.json` write leaves the DB authoritative — the requeued rows already carry the new prompt; `chunks.json` is only re-read at the start of the step to enqueue *new* chunks, and `prompt_history` on the file is forensic only (the canonical record is `moderation_events`).

**`prompt_history` on `Chunk`.** Each rewrite pushes the previous `prompt` onto the chunk's `prompt_history` (oldest-first; current `prompt` excluded). Re-running `generate_visual_prompts` directly fills missing prompts only (skip if `prompt !== null`); to regenerate from scratch, roll back to the workflow's chunker step, which rewrites `chunks.json` with `prompt: null` everywhere and `generate_visual_prompts` then eagerly resets `prompt_history` to `[]` over the to-regenerate subset — the moderation lineage from a prior run no longer applies.

**Out of scope.** ComfyUI and other providers do not surface content-policy errors the same way and are not moderated. After max rounds the step throws — there is no skip-and-continue placeholder pathway.

---

## 13. Render (`render`) — Node + ffmpeg.exe

Renderer is `lib/render.ts`. It composes ffmpeg command lines and spawns `ffmpeg.exe` directly. No Python.

### 13.1 Inputs
- `audio/narration.mp3` (full audio, exact duration `T`)
- `videos/clip/clip_NN.mp4` (one per clip chunk, no audio; per-clip length is provider-resolved — `google_flow_hook_clip_seconds` for Google Flow, `hook_video_clip_seconds` for ComfyUI). For workflow-1 (`chunk_clips_then_images`) the count is capped at `round(hook_length_seconds / clip_seconds)`; for workflow-3 (`chunk_clips_only`) clips span the whole narration. Absent entirely when the workflow uses `chunk_images_only`.
- `images/image_NNN.png` for every image chunk. Absent entirely when the workflow uses `chunk_clips_only`.
- `chunks.json` (exact start/end per chunk)
- Settings: `aspect_ratio`, `long_edge_px`, `framerate`
- Constants from `lib/render.ts`: `CROSSFADE_SECONDS` (CF=1.0), `ZOOM_TARGET` (1.275)

Resolution `W × H` is derived from `aspect_ratio` + `long_edge_px`.

### 13.2 The crossfade duration math

xfade with N segments of nominal duration `D_i` and overlap `CF` produces an output of duration `Σ D_i − (N−1)·CF`. To make the rendered video match the audio length exactly, each segment except the last must be rendered with **`D_i + CF`** seconds of content (using the same image, extending the zoompan range slightly). The last segment uses exact `D_N`.

```
visible_duration_per_segment = chunk_duration       (matches alignment slot)
rendered_duration_per_segment = chunk_duration + CF (except last segment, = chunk_duration)
```

After xfade chains them with overlap `CF`, total = `Σ chunk_duration + (N−1)·CF − (N−1)·CF = Σ chunk_duration = T_image`. Audio aligns.

The clip→image transition (workflow-1 only) is the same: `clip_concat` is whatever the concatenated clips actually produce (`round(hook_length_seconds / clip_seconds) × clip_seconds ± sentence-jitter`), with a trailing `CF` still of the last clip frame appended to provide the crossfade tail. The renderer ffprobes `clip_final.mp4` to get the xfade offset rather than deriving it from chunk timestamps — chunk audio span and rendered video length can diverge (e.g. fixed-length provider clips vs. variable sentence groups).

### 13.3 Pipeline

On any retry of the render step, `render/` is deleted first. No segment caching — start fresh.

**Stage A — Clip segment (skipped when there are no clip chunks):**
1. Concat clips with **no crossfade** (intentional — they should look like one continuous video):
   ```
   ffmpeg -f concat -safe 0 -i clip_list.txt -an -c:v libx264 -preset medium -crf 20 clip_concat.mp4
   ```
2. Append a re-encoded last-frame still for `CF` seconds to provide the crossfade tail (`clip_tail.mp4`). No time-stretching: combined clip duration depends on the configured clip length and chunk count; the audio plays from t=0 anyway and the alignment downstream uses real timestamps from aeneas. The resulting `clip_final.mp4` is the Stage A output.

**Stage B — Per-image-chunk renders (skipped when there are no image chunks):**
For each image chunk `i`:
1. `dur = chunks[i].duration` (or `dur + CF` if not the last chunk).
2. `frames = round(dur * framerate)`.
3. Zoom from `1.0` to `ZOOM_TARGET` via `zoompan` against a pre-upscaled working buffer:
   ```
   ffmpeg -loop 1 -i image_NNN.png -t <dur> \
     -vf "scale=<upscaleLong>:-1,zoompan=z='1.0+(<ZOOM_TARGET>-1.0)*on/<frames>':d=<frames>:s=<W>x<H>:fps=<framerate>,format=yuv420p" \
     -c:v libx264 -preset ultrafast -crf 18 \
     render/segment_NNN.mp4
   ```
   The pre-zoompan upscale long edge is derived per chunk as `upscaleLong = min(12000, max(max(W, H) * 2, ceil(N_frames * 9)))` — sized to keep the integer-pixel step rate above the perceptibility threshold so motion stays smooth across the chunker's realistic duration range; see ADR-0005 for the derivation, the floor, and the 12000 ceiling (logged when it engages). Stage B segments use `-preset ultrafast -crf 18` while Stage A keeps `-preset medium -crf 20`; see ADR-0002 for the throwaway-intermediate rationale behind the asymmetry. Segments are independent and render in parallel, bounded by the module-level `SEGMENT_CONCURRENCY` const in `lib/render.ts`.

**Stage CD — Fused image crossfade chain + clip→image crossfade:**
A single ffmpeg invocation builds the image xfade chain and (when clip chunks exist) crossfades `clip_final.mp4` onto the front in one filter graph, encoding directly to `video_only.mp4`. The image chain uses `transition=fade duration=CF offset=<cumulative>` per transition; the clip→image xfade uses `offset = ffprobe(clip_final.mp4) − CF` so the transition lands at the actual end of the clip section regardless of chunker target vs. provider clip-length drift. The clip input is normalized (scale/pad/setsar/fps/format) ahead of the xfade because clips from external generators may not match target resolution/SAR/framerate/pixel format; the image side is already at target geometry by construction (Stage B's `zoompan s=WxH:fps=…` + `format=yuv420p`). When there is only one image segment and no clip section, Stage CD stream-copies `segment_001.mp4` to `video_only.mp4` (no filter graph). When the workflow is clip-only (`chunk_clips_only`, no image chunks), Stage CD stream-copies `clip_final.mp4` to `video_only.mp4` (no filter graph; the held-last-frame tail in Stage A is skipped when no Stage CD xfade is bridged to). The encoder used in the three re-encoding sub-cases is selected by the `video_encoder` setting (ADR-0004); the per-encoder argv bundles are:

| `video_encoder` | Stage CD encoder args |
|---|---|
| `libx264` (default) | `-c:v libx264 -preset medium -crf 20` |
| `h264_nvenc` | `-c:v h264_nvenc -preset p5 -tune hq -rc vbr -cq 21 -b:v 0` |
| `h264_amf` | `-c:v h264_amf -quality balanced -rc cqp -qp_i 21 -qp_p 23` |

Output: `video_only.mp4`.

For 240 segments, the fused filter graph string is large but feasible. If ffmpeg argv length becomes a problem, pair-wise reduction (xfade pairs into intermediates, then pairs of pairs, etc.) is the fallback.

**Stage E — Mux audio:**
```
ffmpeg -i video_only.mp4 -i audio/narration.mp3 \
  -c:v copy -c:a aac -b:a 192k -shortest \
  final.mp4
```

### 13.4 Placeholder fallback
If a chunk's image file is missing (generation skip or provider failure), the renderer generates a `W×H` black frame with white text `MISSING: <chunk_id>` via ffmpeg's `drawtext` filter and uses it as the segment input. Logged.

---

## 14. Cleanup (`cleanup`)

Implemented as enumerate-and-delete against a keep set — anything not in the keep set is removed, so future intermediate files are cleaned automatically.

Keeps:
- `final.mp4`
- `script/full_script.md`
- `pipeline.log`

Everything else is deleted, including: `render/`, `images/`, `videos/`, `audio/`, `alignment/`, `chunks/`.

---

## 15. Worker & Queue

### 15.1 Process model
Single Node process started alongside Next.js via `concurrently`.

`package.json` scripts:
```json
"scripts": {
  "dev":   "concurrently -n web,worker -c blue,green \"next dev\" \"tsx watch src/worker/index.ts\"",
  "build": "next build && tsc -p tsconfig.worker.json",
  "start": "concurrently -n web,worker -c blue,green \"next start\" \"node dist/worker/index.js\"",
  "db:init": "tsx scripts/db-init.ts"
}
```

Use `npm run dev` for development (file-watch reloads). Use `npm run build` once, then `npm start` for unattended overnight runs (no reloads, stable).

`better-sqlite3` is fine for single-writer access (only the worker writes to `videos`/`video_steps`; the API also writes to `videos` via create/edit/delete routes, but never while the worker is mid-step on that video — status transitions are atomic).

### 15.2 Main loop
```
on start:
  if any video has status='in_progress', resume it (runPipeline)   # crash recovery

loop:
  in_progress = videos where status='in_progress'    # crash recovery path
  if in_progress exists: runPipeline(in_progress.id)
  next = videos where status='queued' order by created_at asc limit 1   (FIFO)
  if none: sleep 5s; continue
  set next.status='in_progress', started_at=now (if null)
  runPipeline(next.id)
```

`new`-status videos are **not** picked up by the runner. They wait for the operator to click Start (per-row) or Start All (bulk), which transitions them to `queued`.

There is no global queue pause. The previous `queue_state` / `freepik_relogin_needed` flags have been removed along with the `/api/queue/*` routes. Failure isolation now means a failed video never blocks any other video.

### 15.3 runPipeline(videoId)
```
resolve workflow = getWorkflowById(video.workflow_id)   # throws if unknown
resolve steps    = map workflow.steps to REAL_STEPS entries
seed video_steps rows (pending) for each step, idempotent

for step in steps:
  if video.delete_requested:                          # between-step check
    rm -rf projects/<id>/
    delete video_steps + videos rows
    return
  if step_row.status == 'done': continue              # resume fast-path
  set step_row.status='running', video.current_step=step.name
  try:
    await step.run(videoId, ctx)
    set step_row.status='done'
  catch err:
    set step_row.status='failed'
    cleanup step artifacts (step.cleanup or rm step.outputs)
    append stack to pipeline.log
    set video.status='failed', failed_step=step.name, failed_reason=err.message
    return

# post-loop honors a late delete-request before marking done
if video.delete_requested:
  rm -rf projects/<id>/; delete rows; return
set video.status='done', output_path='projects/<id>/final.mp4'
```

### 15.4 Delete-requested handling

Deleting a video that is currently `in_progress` cannot stop mid-step safely — steps own their own I/O and may hold ffmpeg/ComfyUI sessions. Instead the DELETE route sets `delete_requested=1` and returns `202 Accepted`. The orchestrator checks the flag between every step; when set, it wipes the project directory on disk, deletes the `video_steps` + `videos` rows in a transaction, and returns. No partial next-step state ever lands because the check fires before the next step starts.

For `new` / `queued` / `failed` / `done`, DELETE removes the row (and project directory, for `queued` / `failed` / `done`) synchronously — no deferred path needed.

### 15.5 Failure isolation
- A failed video does **not** pause the queue or block other videos. Worker logs and moves to the next `queued` video.
- There is no queue pause concept at all. Each video's `status` column is the only gate.

---

## 16. Dashboard

### 16.1 Pages

**`/videos`** (also the home page — `/` redirects here)

Two sections on a single page:

- **Video Queue** — rows where `status ∈ {new, queued, in_progress, failed}`, sorted FIFO by `created_at`. Columns: Title, Workflow (short label + tooltip with full label), Status, Actions.
- **Finished Videos** — rows where `status = done`, sorted by `finished_at` DESC. Columns: Title, Finished (date/time), Time, Actions.

Page header: **Add Topic** button (opens Add/Edit modal), **Add Ready Script** button (opens a separate modal: title + workflow + script textarea with a "Load from file…" helper that reads `.txt` / `.md` via `FileReader.readAsText`; persists `provided_script` per §7.7), and **Start All** button (bulk transitions `new` → `queued`, disabled when no `new` rows exist).

Ready-script videos render a small "Ready script" badge inline in the Title cell across all three lifecycle tables (Topics, Queue, Finished) so the operator can tell them apart at a glance.

Action buttons per row, per status:

| Status | Actions |
|---|---|
| `new` | Start, Edit, Delete |
| `queued` | Edit, Delete (PATCH accepts edits while queued; the resync rule in §7.7 keeps disk-state consistent for ready-script videos) |
| `in_progress` | Edit (disabled), Delete (or "Deleting…" cue if `delete_requested=1`) |
| `failed` | Edit (disabled), Delete (Retry/Restart are on the detail page only) |
| `done` | Open folder, Copy path, Delete |

Polling: `/api/videos` every 5s. Done/failed transitions show a toast. Rows move between sections automatically as statuses change.

**`/videos/[id]`**
- Header: title, status, workflow label, visual-style title (`visual_style_snapshot.title ?? "Default"`) with a "Show prompt" disclosure that reveals the pinned `visual_style_snapshot.prompt`, link to `final.mp4` when done.
- Step list with status icons and timings.
- Single **View pipeline log** link → opens `pipeline.log`.
- Artifacts panel: links to all files in the project folder.
- For `google-flow` videos: a **Flow progress** card (per-kind counts, failed-list expansion, requeue actions) with an inline per-kind moderation indicator ("moderating N…" or "moderation round X/M"); plus, when the video has any moderation events, a collapsible **Content moderation** panel below it grouping rewrites by round (kind, chunk_id, reason tag, original/rewritten prompts). Both panels are powered by the same `/api/flow/queue-summary/[videoId]` 5s poll. See §12b.7.
- Per-status action surface (mirrors the list-row actions, with extras):
  - `new`: Start, Delete
  - `queued`: Delete
  - `in_progress`: Delete (or "Deleting…" cue)
  - `failed`: Retry failed step, Restart from beginning, Delete
  - `done`: Copy Path

Retry/Restart behavior (unchanged from pre-overhaul): **Retry** clears failed status and resumes from the failed step; **Restart** deletes all artifacts and re-queues from step 1.

Delete flows through a confirm dialog with a status-aware message. On successful delete of a `new` / `queued` / `failed` video, the user is redirected back to `/videos`; for `in_progress`, the detail page stays and polling eventually 404s and redirects.

**`/settings`**

Six tabs, each binding to the settings from section 4:

- **Script** (default tab): the length controls `script_length_minutes`, `hook_length_seconds`, `hook_video_clip_seconds` (ComfyUI-only), plus a **Provider** section housing the OpenRouter and Claude CLI panels (gated by a local view-filter dropdown — not persisted). Each panel exposes two model fields: `<provider>_script_model` (script-writing steps) and `<provider>_visual_model` (step 9 `generate_visual_prompts` + Google Flow moderation). The active provider per video is chosen by its workflow (`workflows.script_llm_provider` → `snapshot.script_llm_provider`); this panel carries the model ids the chosen provider will use.
- **Visual Style**: CRUD gallery over the `visual_styles` table (master-detail layout — alphabetical list of titles on the left; title input + prompt textarea + Save/Delete on the right). Owns no flat settings; the form-level Save button is hidden on this tab. Edits go to `/api/visual-styles[/id]` directly, not through the bulk PATCH. Dirty pane warns before discarding on row switch, tab switch, and page close. Operators pick from this gallery per video on the `/videos` creation modals; "Default (no style)" maps to `visual_style_id = NULL` and injects an empty `style_prompt` at step 09. See ADR-0010.
- **TTS**: `voice_id`, `voiceover_model_id`, `voice_stability`, `voice_similarity`, `voice_style`, `voice_speed`, `voice_use_speaker_boost`, `chatterbox_base_url`, `chatterbox_voice_mode`, `chatterbox_voice_filename`. The active provider is chosen per workflow in the workflow editor (`workflows.tts_provider` → `snapshot.tts_provider`); this panel carries the voice configuration shared across providers. The ElevenLabs-shaped `voice_*` tuning is honoured by AI33/GenAIPro; Chatterbox uses its own params, with only `voice_speed` carrying over (mapped to `speed_factor` on `/tts`).
- **Google Flow**: the model + aspect dropdowns (`google_flow_image_model`, `google_flow_video_model`, `google_flow_aspect_ratio`, `google_flow_hook_clip_seconds`), an **Accounts** section that fetches/mutates via `/api/flow/accounts` (add / rename / enable-toggle / pause / delete; token + webhook URLs are revealed in a one-time modal on creation), and an **Advanced** subsection (collapsed by default) holding the read-only `google_flow_relogin_needed` indicator, the ops-tuning fields `google_flow_account_cooldown_hours`, `google_flow_max_retries`, `google_flow_dispatch_timeout_minutes`, and the content-moderation fields `google_flow_content_moderation_enabled`, `google_flow_content_moderation_max_rounds`, `google_flow_content_moderation_model` (empty model falls back to the workflow-pinned provider's visual model; see §12b.7). See §12b.
- **ComfyUI**: `image_provider`, `comfyui_base_url`, `comfyui_workflow_path`, `comfyui_hook_video_workflow_path`
- **Render**: `aspect_ratio`, `long_edge_px`, `framerate`

Active tab is reflected in `?tab=…` query. A single Save button at the form level sends a PATCH with only the dirty fields across all tabs. A dirty indicator (small dot) appears next to any tab label whose fields have unsaved changes.

### 16.2 API routes

```
GET    /api/videos                     # list + envelope
POST   /api/videos                     # body {title, topic_info, workflow_id, provided_script?, visual_style_id?} → status=new; visual_style_id omitted/null = "Default" (empty style prompt)
GET    /api/videos/:id                 # video + steps + artifacts + workflow_label + visual_style_snapshot
PATCH  /api/videos/:id                 # body {title?, topic_info?, workflow_id?, provided_script?, visual_style_id?} — 409 if status∉{new,queued}; visual_style_id change re-pins visual_style_snapshot; provided_script change on queued resyncs disk via §7.7
DELETE /api/videos/:id                 # status-dependent:
                                       #   new      → row only
                                       #   queued   → files + row
                                       #   failed   → files + row
                                       #   done     → files + row
                                       #   in_prog  → set delete_requested=1, 202
POST   /api/videos/:id/start           # new → queued
POST   /api/videos/:id/retry           # retry failed step (unchanged)
POST   /api/videos/:id/restart         # restart from beginning (unchanged)
POST   /api/videos/:id/open-folder     # opens the per-video folder in Windows Explorer with final.mp4 selected; 400 non-Windows, 410 folder missing
POST   /api/videos/start-all           # bulk new → queued, returns count

GET    /api/videos/:id/files/...       # file serving from <projectsDir>/<id>/

GET    /api/settings
PATCH  /api/settings

GET    /api/visual-styles              # list of {id, title, prompt, created_at, updated_at}
POST   /api/visual-styles              # body {title, prompt} → 201 with row
GET    /api/visual-styles/:id          # single row
PATCH  /api/visual-styles/:id          # body {title?, prompt?} — does not perturb existing videos (snapshot is pinned)
DELETE /api/visual-styles/:id          # unconditional; referencing videos' visual_style_id → NULL via ON DELETE SET NULL (ADR-0010)

GET    /api/health                     # { ok: true }

# Google Flow (see §12b)
POST   /api/flow/next-task/[token]             # extension polls for work
POST   /api/flow/submit-result/[token]         # extension submits result or error
POST   /api/flow/status/[token]                # session_expired | credits events
GET    /api/flow/accounts                      # list accounts (token masked)
POST   /api/flow/accounts                      # mint an account + token
PATCH  /api/flow/accounts/[id]                 # rename / enable-toggle / manual pause
DELETE /api/flow/accounts/[id]                 # delete + requeue its dispatched rows
GET    /api/flow/queue-summary/[videoId]       # counts + failed list + moderation block (per-kind round/pending, max_rounds, last_event_at, events) for the video
POST   /api/flow/requeue-failed/[videoId]      # requeue failed rows (?force=1 to bypass retry cap)
```

There are no `/api/topics/*`, `/api/queue/*`, or `/api/freepik/*` routes. All three surfaces were removed in the overhaul.

### 16.3 Notifications
Dashboard polls `/api/videos` every 5s on the videos list page. Done/failed transitions show a toast. No desktop notifications, no sound, no email.

---

## 17. Configuration

### 17.1 `.env`
```
OPENROUTER_API_KEY=
AI33_API_KEY=
GENAIPRO_API_KEY=
# Chatterbox runs locally — configure URL and voice in Settings → TTS, not env.
DATABASE_URL=./data/histforge.db
PROJECTS_DIR=./projects
WSL_DISTRO=Ubuntu
```

API keys live in env. Everything else (model name, voice config, render config, style, ComfyUI URL + workflow paths) lives in DB-backed Settings, editable in the dashboard.

`ffmpeg` and `python3` are invoked by literal name — they must be on PATH (Windows PATH for ffmpeg, WSL PATH for python3). ComfyUI must be running locally before any step in the `comfyui` workflow executes — see `docs/comfyui/setup-comfyui.md`. For the `google-flow` workflow, each Google account needs a Chrome profile with the YouForge Flow extension running — see `docs/setup-guides/setup-google-flow.md`. For the `chatterbox` TTS provider, the local Chatterbox-TTS-Server (`devnen/Chatterbox-TTS-Server`, port 8004) must be running before any step that triggers voiceover — see `docs/setup-guides/setup-chatterbox.md`.

### 17.2 Prompts
Files in `prompts/`. Edited in your IDE. Worker reads them fresh on every step run; no restart required after editing.

---

## 18. Logging

One log file per video: `projects/<id>/pipeline.log`. Append-only. Each line is prefixed with `[<step_name>]` and a timestamp. Step start, key actions, step end. On error: stack trace appended under the failing step's prefix.

The dashboard "View pipeline log" link opens the same file.

LLM full prompt/response logging: off by default.

---

## 19. Workflows

A **workflow** is a named, ordered sequence of step slugs that the orchestrator runs for any video carrying that workflow's `id`. The registry lives at `src/worker/workflows/index.ts` and exports two functions: `listWorkflows()` and `getWorkflowById(id)`.

### 19.1 Registry schema

```ts
interface Workflow {
  id: string;                      // stable key stored in videos.workflow_id
  shortLabel: string;              // compact name for the Video Queue column
  label: string;                   // verbatim human description shown in the dropdown + tooltip
  steps: readonly string[];        // ordered step slugs the orchestrator runs
}
```

### 19.2 Shipped workflows

Each workflow row carries provider columns (`script_llm_provider`, `tts_provider`, `image_provider`, `video_provider`) and a `chunker_step` column. The materializer (`src/lib/workflows.ts`) emits the flat step list per video by interleaving the workflow's authored script steps with `voiceover`, `align`, the selected chunker, `generate_visual_prompts`, then `generate_images` (if `image_provider` is non-null) and/or `generate_clips` (if `video_provider` is non-null), then `render`, `cleanup`. Four workflows ship today:

- **`comfyui`** — ComfyUI for both images and clips. Chunker: `chunk_clips_then_images`. Materialized steps: `research_outline`, `write_hook`, `write_chapters`, `assemble_script`, `voiceover`, `align`, `chunk_clips_then_images`, `generate_visual_prompts`, `generate_images`, `generate_clips`, `render`, `cleanup`.

- **`google-flow`** — Google Flow for both images and clips (see §12b). Chunker: `chunk_clips_then_images`. Materialized steps: same as `comfyui`. Both Google Flow dispatches may return a defer sentinel when every account is simultaneously in cooldown; the orchestrator sets `videos.deferred_until` and moves to the next video.

- **`google-flow-images-only`** — Google Flow image generation only; no clip section. Chunker: `chunk_images_only`. Materialized steps: `research_outline`, `write_hook`, `write_chapters`, `assemble_script`, `voiceover`, `align`, `chunk_images_only`, `generate_visual_prompts`, `generate_images`, `render`, `cleanup` (no `generate_clips`).

- **`google-flow-clips-only`** — Google Flow clip generation only; no image section. Chunker: `chunk_clips_only`. Materialized steps: `research_outline`, `write_hook`, `write_chapters`, `assemble_script`, `voiceover`, `align`, `chunk_clips_only`, `generate_visual_prompts`, `generate_clips`, `render`, `cleanup` (no `generate_images`).

The `chunker_step` ↔ provider consistency rule (`chunk_clips_then_images` requires both image and video providers; `chunk_images_only` requires only image; `chunk_clips_only` requires only video) is enforced by `validateChunkerStepConsistency` in `src/lib/workflows-validator.ts` — advisory warnings in the editor, refuse-to-boot in `bootValidate`.

### 19.3 Module-load validation

`src/worker/steps/index.ts` calls `validateWorkflowSteps(listWorkflows(), REAL_STEPS)` at module load. A typo in the registry — a workflow referencing a slug that doesn't resolve to any `REAL_STEPS` entry — fails the worker at boot, not mid-run when a specific video picks that workflow.

### 19.4 Adding a workflow

1. Write any new step files under `src/worker/steps/` and add them to `REAL_STEPS` in `steps/index.ts`.
2. Append a `Workflow` entry to `WORKFLOWS` in `workflows/index.ts` with a unique `id` and a `steps` array referencing registered slugs.
3. No UI changes required — the Add/Edit modal populates the Workflow dropdown from `listWorkflows()`.

For AI-skill–generated workflow JSON (filesystem drafts pipeline), see §19a.

---

## 19a. AI workflow drafts

An out-of-codebase AI skill can author workflow JSON and drop it into a filesystem inbox; the dashboard surfaces pending drafts on `/workflows` and a single click commits the row + archives the file. This is the second import surface alongside the file-picker upload on the workflows page; both go through the same backend helper (`importWorkflowJson` in `src/lib/workflows-import.ts`) and return the same response shape.

### 19a.1 Filesystem layout

```
prompts/workflows/
  drafts/<slug>.json                       # pending — written by the AI skill, surfaced on /workflows
  imported/<slug>-<unix_timestamp>.json    # archived — committed drafts moved here on successful import
```

Both directories are created lazily on the first drafts API call. `<slug>` matches `^[a-z0-9-]+$` (the workflow id regex from `src/lib/workflows-schema.ts`); the basename validator (`/^[a-z0-9-]+\.json$/`) is the path-traversal defense and runs before any FS read. The two directories are siblings under `prompts/workflows/` so the post-commit `renameSync` from `drafts/` to `imported/` stays on the same volume. The archived filename uses the row's canonical `id` (post-commit re-read), not the source filename — a draft authored with mismatched filename-vs-slug ends up with a normalized archived name.

`prompts/workflows/` contains user-and-AI-generated content only. Bundled defaults stay in code (`BUILTIN_WORKFLOWS`, `src/lib/workflows.ts`).

### 19a.2 JSON shape

Identical to the export shape produced by `GET /api/workflows/[id]/export` — snake_case, flat. Round-trip parity (export → re-import) is the contract guarantor.

```jsonc
{
  "id": "fast-narrative",                  // kebab-case slug, becomes the workflows row PK
  "label": "Fast narrative",
  "short_label": "Fast",
  "description": "Skips character research for shorter videos.",  // string | null
  "script_llm_provider": "openrouter",     // "openrouter" | "claude_cli"
  "tts_provider": "ai33",                  // "ai33" | "genaipro" | "chatterbox" | null
  "image_provider": "comfyui",             // "comfyui" | "google_flow" | null
  "video_provider": "comfyui",             // same
  "chunker_step": "chunk_clips_then_images", // "chunk_clips_then_images" | "chunk_images_only" | "chunk_clips_only" — optional, defaults to "chunk_clips_then_images". See §10 + §19.2 for the provider-consistency rule.
  "enabled": true,
  "steps": [                               // ordered script-module steps only
    { "step_name": "research_outline" },
    { "step_name": "write_hook" },
    { "step_name": "write_chapters" }
  ]
}
```

`for_each` is not in the JSON — it lives as step-file metadata. Server-controlled fields (`is_builtin`, `version`, `created_at`, `updated_at`) are silently stripped on import (Zod default); the drafts list parser surfaces them as `unknown_field` advisories on the row's `errors` array so the AI-skill author notices during iteration.

### 19a.3 AI-skill loop

1. Skill calls `GET /api/workflows/schema` for the live `{ modules, steps, providers }` catalog (the four provider fields' enums come from this endpoint, not from a hardcoded list, so registry changes propagate without a skill update).
2. Skill writes a snake-case JSON file to `prompts/workflows/drafts/<slug>.json`.
3. Operator opens `/workflows`; the Drafts section above the main table lists pending drafts with metadata and any `errors` advisories from the parser.
4. Operator clicks Import → `POST /api/workflows/drafts/<filename>/import` validates the file, commits the row, and atomically moves the source file to `imported/<slug>-<unix_timestamp>.json`. Slug collision returns 409; the UI opens an overwrite-confirm dialog and re-POSTs with `?overwrite=1`. Discard removes the file without importing (`DELETE /api/workflows/drafts/<filename>`).

The dashboard does not poll the filesystem — refresh is on page load + manual Refresh button. FS watching is out of scope for v1.

### 19a.4 Validation contract

Input-availability warnings (Phase 3 `validateInputAvailability`) ride the import response in a `warnings` array; saves are never blocked. The success toast surfaces the warning count and the messages in its description, and the View action routes to `/workflows/<slug>/edit` where inline warnings appear on the offending step rows. Schema-level failures (`WorkflowImportSchema.safeParse` errors) return 400 `invalid_input` with Zod issue details; the source file stays in `drafts/` so the operator can fix and retry.

The `imported/` directory grows monotonically; auto-prune is deferred for v1.

---

## 20. Modularity & Future Swaps

Each external dependency is behind an interface so swaps don't touch step code:

- **`lib/llm/`** — `chat(messages, opts): Promise<string>`. Providers are pure transports: callers must pass `opts.model` explicitly. The pipeline resolves provider + per-purpose model at the `resolveDeps` boundary: every LLM-driven step in a run (script writing, step 9 visual-prompt generation, Google Flow moderation) goes through the workflow-pinned `script_llm_provider` (snapshot-pinned per workflow, §19a.2), with `<provider>_script_model` for the script wrapper (`ctx.chat`) and `<provider>_visual_model` for the visual-prompt wrapper (`ctx.visualPromptChat`). Currently: OpenRouter, Claude CLI. Adding a provider = one new file + one registry entry; the canonical name list lives in `LLM_PROVIDER_NAMES` (`src/lib/llm/names.ts`), which every consumer (zod schema, UI option lists) derives from.
- **`lib/tts/`** — `TtsProvider` interface with `synthesize(text, outPath, opts)`. Provider registry selects by `snapshot.tts_provider` (snapshot-pinned per workflow). Currently: AI33, GenAIPro, Chatterbox. Adding a provider = one new file + one registry entry. Local providers (e.g. Chatterbox) carry an empty `envKey` in `TTS_PROVIDER_META` since they have no API key — they read URL/auth from Settings instead.
- **`lib/image/`** — `ImageProvider` interface with `generateBatch(items, targetDir, opts)`. Provider registry selects by `image_provider`. Currently: ComfyUI, Google Flow.
- **`lib/video/`** — `VideoProvider` interface for clip generation. Provider registry selects by `video_provider`. Currently: ComfyUI, Google Flow.
- **`lib/align.ts`** — `align(audioPath, scriptPath, outPath): Promise<void>`. WSL+aeneas today; could become WhisperX or a hosted aligner.
- **Workflow registry** — orthogonal to provider registries. A workflow wires step slugs (which may be provider-specific) into an order; adding a provider = new step file + optional new workflow.

(There is intentionally no storage abstraction; steps use `fs/promises` directly. Refactor if/when remote storage becomes a real requirement.)

---

## 21. Open Issues / Known Risks

1. **Aeneas accuracy on 2-hour audio.** Untested at scale. Fallback: WhisperX behind the same `lib/align.ts` interface.
2. **ffmpeg filter graph size for 240-segment xfade.** Likely fine but may need pair-wise reduction fallback.
3. **Word count → duration drift.** The chapter target is ~900 words ≈ 6 min @ ~150 wpm (hardcoded constant), so 15 chapters ≈ 90 min. Actual AI33 voice tempo may shift the total — first real run calibrates `script_length_minutes`.
4. **WSL path translation.** `lib/align.ts` includes a `wslPath()` helper. Tested by integration test on first run.
5. **ComfyUI VRAM requirements.** SDXL at 1920px long edge requires 8+ GB VRAM. Lower `long_edge_px` to 1024 for GPUs with less memory. Text-to-video workflows (SVD, AnimateDiff, Wan, LTX) vary more widely — user picks a workflow that fits their hardware.
6. **ComfyUI clip workflow is user-supplied.** HistForge ships no default for `prompts/comfyui/default-hook-video-workflow.json`. Until the user drops one in place, the `comfyui` workflow fails at `generate_clips` when it dispatches to the ComfyUI video provider.
7. **Google Flow depends on a live Chrome profile per account.** Up to four profiles permanently open on the host machine is the real operational cost — no workaround. If Google changes the reCAPTCHA site key, action names, or endpoint paths, the fork breaks until patched; keeping `flow-api.js` close to upstream's shape makes cherry-picks from upstream easier.

---

## 22. Suggested Build Order

1. Skeleton: Next.js + SQLite + worker + concurrently. Stub steps that write marker files. Verify queue, resume, failure paths end-to-end.
2. Videos page + Settings page + Add/Edit modal.
3. LLM steps (research_outline, write_hook, write_chapters, assemble_script). Test with one real video.
4. TTS step (voiceover via provider registry — AI33 / GenAIPro / Chatterbox).
5. Aeneas via WSL (align + chunk). Test path translation.
6. Visual prompt generation.
7. ComfyUI image generation via `generate_images`. Hand-assemble a clip workflow JSON; verify `generate_clips`.
8. Render.
9. Cleanup + final polish.
10. Add `npm run build` + `npm start` for unattended operation.
11. Follow-ups: additional workflows / providers as needed.

---

*End of spec v4.*
