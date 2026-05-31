/**
 * Shared types for histforge.
 *
 * DB row types mirror the SQLite schema in docs/histforge-spec.md:170-207.
 * Narrow file-format types (AlignmentEntry, Chunk)
 * are defined here as the single source of truth — when implementing the
 * step that produces or consumes one of these files, import the type from
 * here rather than declaring it inline.
 */

export type VideoStatus = "new" | "queued" | "in_progress" | "done" | "failed";

export type QueueState = "running" | "paused";

/**
 * Discriminates a video row's pipeline shape. `narrative` rows walk the
 * existing research → write → voiceover → align → chunk → image/clip →
 * render chain; `music_video` rows walk the six-step loop-image / loop-clip /
 * music backbone. Pinned at creation and never mutated (PATCH rejects any
 * `kind` field that differs from the row's stored value).
 */
export type VideoKind = "narrative" | "music_video";

export interface Video {
  id: string;
  title: string;
  topic_info: string;
  workflow_id: string;
  status: VideoStatus;
  current_step: string | null;
  failed_step: string | null;
  failed_reason: string | null;
  started_at: number | null;
  finished_at: number | null;
  output_path: string | null;
  delete_requested: 0 | 1;
  paused: 0 | 1;
  deferred_until: number | null;
  provided_script: string | null;
  visual_style_id: string | null;
  visual_style_snapshot: string | null;
  kind: VideoKind;
  magnific_image_prompt: string | null;
  magnific_motion_prompt: string | null;
  suno_style_prompt: string | null;
  song_count: number | null;
  repeat_factor: number | null;
  /**
   * Per-video override of `image_chunk_target_seconds`. NULL falls
   * through to the global setting via `getImageChunkPacing`.
   */
  image_chunk_target_seconds: number | null;
  /**
   * Per-video override of `image_chunk_min_seconds`. NULL falls through
   * to the global setting via `getImageChunkPacing`.
   */
  image_chunk_min_seconds: number | null;
  /**
   * Per-video override of `image_chunk_max_seconds`. NULL falls through
   * to the global setting via `getImageChunkPacing`.
   */
  image_chunk_max_seconds: number | null;
  /**
   * Magnific Project UUID for the narrative-magnific image path. NULL
   * until the extension creates a Project for this video; cached here so
   * later image chunks reuse it. See the magnific-narrative spec.
   */
  magnific_project_id: string | null;
  created_at: number;
}

/**
 * Video row plus the runtime snapshot the videos list API computes by
 * joining `video_steps`. Mirrors the detail page's "Total" timer so the
 * list rows can show the same elapsed time without each row fetching its
 * own steps. The client extrapolates `now - running_step_started_at` for
 * live ticking between polls.
 */
export interface VideoListItem extends Video {
  runtime_ms: number;
  running_step_started_at: number | null;
}

export interface GoogleFlowAccount {
  id: string;
  name: string;
  token: string;
  paused_until: number | null;
  last_seen_at: number | null;
  credits: number | null;
  credits_updated_at: number | null;
  enabled: 0 | 1;
  recovery_reason: string | null;
  recovery_required_at: number | null;
  created_at: number;
}

export type GoogleFlowQueueKind = "image" | "clip";
export type GoogleFlowQueueMode =
  | "createImage"
  | "text"
  | "image"
  | "frames";
export type GoogleFlowQueueStatus =
  | "pending"
  | "dispatched"
  | "done"
  | "failed";

export interface GoogleFlowQueueItem {
  id: number;
  video_id: string;
  chunk_id: string | null;
  kind: GoogleFlowQueueKind;
  mode: GoogleFlowQueueMode;
  prompt: string;
  reference_image: string | null;
  start_frame: string | null;
  end_frame: string | null;
  output_path: string;
  status: GoogleFlowQueueStatus;
  assigned_account_id: string | null;
  external_task_id: string | null;
  result_url: string | null;
  error_reason: string | null;
  retry_count: number;
  moderation_round: number;
  priority: number;
  created_at: number;
  dispatched_at: number | null;
  completed_at: number | null;
  google_operation_id: string | null;
  google_operation_project_id: string | null;
}

/**
 * Mode discriminator for the magnific_queue. `image-hitl` is the
 * operator-blocking Magnific image-gen step (no_timeout=1 by convention);
 * `image-to-video` is the unattended Magnific Seedance step (no_timeout=0
 * so the reaper can requeue a hung extension session). Per ADR-0012.
 */
export type MagnificQueueMode = "image-hitl" | "image-to-video" | "image-batch";
export type MagnificQueueStatus =
  | "pending"
  | "dispatched"
  | "done"
  | "failed";

/**
 * One row in the `magnific_queue` table. Single-account semantics — no
 * assigned_account_id, no per-account FK. Music-video kind enqueues at
 * most one row per (video, mode); the worker step uses
 * `findOpenTaskForVideo({video_id, mode})` to skip re-enqueueing on
 * re-entry. Per ADR-0012 §Consequences.
 */
export interface MagnificQueueItem {
  id: number;
  video_id: string;
  mode: MagnificQueueMode;
  prompt: string;
  reference_image: string | null;
  output_path: string;
  status: MagnificQueueStatus;
  no_timeout: 0 | 1;
  external_task_id: string | null;
  result_url: string | null;
  error_reason: string | null;
  retry_count: number;
  created_at: number;
  dispatched_at: number | null;
  completed_at: number | null;
}

/**
 * One row in the `moderation_events` table. Each rewrite the moderation
 * loop performs writes a new row; rows are video-scoped and cascade-
 * deleted with their video.
 */
export interface ModerationEvent {
  id: number;
  video_id: string;
  chunk_id: string;
  kind: GoogleFlowQueueKind;
  round: number;
  original_prompt: string;
  rewritten_prompt: string;
  reason_tag: string | null;
  created_at: number;
}

export interface GoogleFlowVideoProject {
  video_id: string;
  account_id: string;
  flow_project_id: string;
  created_at: number;
}

/**
 * One row in the `visual_styles` table. Gallery entry storing a named
 * visual prompt prefix (e.g. "Cinematic noir") consumed by step 09 to
 * style image / clip prompts. Snake-case mirrors the SQLite columns.
 */
export interface VisualStyle {
  id: string;
  title: string;
  prompt: string;
  created_at: number;
  updated_at: number;
}

/**
 * JSON shape pinned in `videos.visual_style_snapshot` at create and
 * re-pinned at queue. Intentionally omits timestamps — the snapshot
 * freezes the prompt content, not the gallery row's lifecycle. NULL
 * snapshot at step-09 time = empty style prompt = "Default (no style)".
 */
export interface VisualStyleSnapshot {
  id: string;
  title: string;
  prompt: string;
}

/**
 * One row in the `workflows` table. Snake-case mirrors the SQLite
 * columns directly (per the "DB row types mirror the schema" convention).
 * Numeric flags (`is_builtin`, `enabled`) are stored as 0/1 — same shape
 * as `videos.paused`.
 *
 * `script_llm_provider` and `chunker_step` are nullable (relaxed Plan 1
 * Phase 1.1 Task 2) so music_video workflows can carry null. The advisory
 * validator (`validateWorkflowConsistency`) enforces the per-kind
 * provider invariants at runtime.
 */
export interface WorkflowRow {
  id: string;
  label: string;
  short_label: string;
  description: string | null;
  kind: VideoKind;
  script_llm_provider: string | null;
  tts_provider: string | null;
  image_provider: string | null;
  video_provider: string | null;
  music_provider: string | null;
  upscaler_provider: string | null;
  is_builtin: number;
  enabled: number;
  version: number;
  created_at: number;
  updated_at: number;
  chunker_step: string | null;
  // Per-workflow image style bundle id (see `lib/image/styles.ts`).
  // NULL → resolves to "cinematic" at runtime (step 09), preserving the
  // pre-doodle pipeline's behavior. Doodle workflows carry
  // "doodle_polished" or "doodle_rough".
  image_style: string | null;
}

/**
 * One row in the `workflow_steps` table. Carries only the user-authored
 * script-module steps; glue / module steps (TTS/image/video) are inserted
 * at materialization time from the parent workflow's provider columns.
 */
export interface WorkflowStepRow {
  workflow_id: string;
  position: number;
  step_name: string;
}

/**
 * JSON shape stored in `videos.workflow_snapshot`. Pinned at
 * create / queue time so an in-flight run is unaffected by edits to the
 * live workflow row. Only the script-module steps are stored — glue
 * and module steps are materialized from the four provider fields.
 * `for_each` lives on the step file metadata, not the snapshot.
 *
 * `kind` is the discriminator `materializeStepList` switches on. For
 * `music_video` snapshots, `script_llm_provider`, `tts_provider`, and
 * `chunker_step` are all null; `music_provider` is set; `upscaler_provider`
 * is reserved for future use. `script_llm_provider` and `chunker_step`
 * mirror the `workflows` table's relaxed nullability (Plan 1 Phase 1.1
 * Task 2).
 */
export interface WorkflowSnapshot {
  workflow_id: string;
  version: number;
  kind: VideoKind;
  script_llm_provider: string | null;
  tts_provider: string | null;
  image_provider: string | null;
  video_provider: string | null;
  music_provider: string | null;
  upscaler_provider: string | null;
  chunker_step: string | null;
  steps: { step_name: string }[];
}

export type VideoStepStatus = "pending" | "running" | "done" | "failed";

export interface VideoStep {
  video_id: string;
  step_name: string;
  status: VideoStepStatus;
  started_at: number | null;
  finished_at: number | null;
}

// ─── File format types ────────────────────────────────────────────────

/**
 * One entry in `alignment/alignment.json`, produced by step 7 (align)
 * via aeneas. Per docs/histforge-spec.md:425-430.
 *
 * Note: aeneas writes `begin`/`end`, NOT `start`/`end`. The chunking step
 * (8) renames these fields when grouping sentences into Chunks.
 */
export interface AlignmentEntry {
  id: string;
  text: string;
  begin: number;
  end: number;
}

/**
 * One entry in `chunks/chunks.json`, produced by step 8 (chunk).
 * Per docs/histforge-spec.md:443-447.
 *
 * `prompt` is `null` until step 9 (generate_visual_prompts) populates it
 * with the visual prompt string for the image provider. After enrichment,
 * all chunks have a non-null prompt.
 */
export type ChunkKind = "clip" | "image";

export interface Chunk {
  id: string;
  kind: ChunkKind;
  start: number;
  end: number;
  text: string;
  prompt: string | null;
  /**
   * Ordered list of prior `prompt` values written by the moderation loop,
   * oldest-first. The current `prompt` is *not* included. Cleared to `[]`
   * by step 9 (generate_visual_prompts) only on chunks it decides to
   * (re)generate — i.e. those with `prompt === null` at step entry. An
   * already-enriched chunk is skipped entirely on resume and keeps its
   * lineage. Optional for back-compat with chunks.json files written
   * before this field existed; consumers must coalesce undefined → []
   * before pushing.
   */
  prompt_history?: string[];
}

/**
 * Framing for a Shot. Mirrors the seven cuts the biz-life-pov-pipeline
 * blueprint enumerates; consumers should treat unknown values as the
 * fallback "medium" to stay forward-compatible with new LLM outputs.
 */
export type ShotCamera =
  | "wide"
  | "medium"
  | "close-up"
  | "over-shoulder"
  | "pov"
  | "static";

/**
 * Subject of a Shot. Drives downstream reference-attachment policy
 * (e.g. only `character` shots require a character reference). `title-card`
 * is a text-only frame; `environment` / `object` shots are character-less.
 */
export type ShotSubjectKind =
  | "character"
  | "environment"
  | "object"
  | "title-card";

/**
 * Editorial intent classifier for a Shot. Five canonical values mirroring
 * the brainstorm taxonomy (establishing / narrative / fact_card / reveal /
 * emphasis). Purely descriptive metadata in this version — does NOT
 * influence chunk timing (which is owned by the chunker step 08). Future
 * beat-aware render effects (e.g. emphasis = slow zoom, fact_card = no
 * zoom) can dispatch on this field without re-running the LLM.
 */
export type BeatType =
  | "establishing"
  | "narrative"
  | "fact_card"
  | "reveal"
  | "emphasis";

/**
 * Provider-neutral reference attachment for a Shot. The `source` is
 * tagged so downstream provider projections (e.g. Google Flow's
 * `referenceEntities` vs `imageInputs`) can dispatch on `kind` rather
 * than baking provider terminology into the IR.
 */
export interface ShotReference {
  role: "character" | "style";
  source:
    | { kind: "entity"; entity_id: string }
    | { kind: "image"; url: string };
}

/**
 * Richer per-shot intermediate representation, written by step 9
 * (generate_visual_prompts) into `chunks/chunks.json`. `Shot` extends
 * `Chunk` so the file shape stays backward-compatible: legacy consumers
 * that read `Chunk[]` still see the timing + `prompt` they expect, while
 * forward-looking consumers can opt into the structured fields.
 *
 * All extension fields are optional. The LLM is encouraged but not
 * required to emit them; older prompt templates that return only
 * `{id, prompt}` continue to parse and persist as plain Chunks.
 */
export interface Shot extends Chunk {
  /**
   * ONE-sentence description of what's in the frame. Set by the LLM to
   * carry the visual intent independently of the assembled `prompt`
   * string — a later phase will assemble the final prompt from this plus
   * `camera`, `references`, and the style/character locks.
   */
  scene?: string;
  /** Camera framing for this shot. */
  camera?: ShotCamera;
  /**
   * What the shot is *about*, used to decide whether a character
   * reference must be attached at generation time. Pre-enqueue
   * validation (Codex Q4) reads this.
   */
  subject_kind?: ShotSubjectKind;
  /**
   * The exact word or short phrase in the narration that anchors this
   * shot to a moment on the audio timeline. Used by future per-word
   * placement features; today purely informational.
   */
  trigger_text?: string;
  /**
   * Provider-neutral references attached to this shot. Empty / undefined
   * means no references — downstream provider projections decide what
   * that means per provider (e.g. Flow falls back to the saved Character
   * entity if configured).
   */
  references?: ShotReference[];
  /** Negative prompt fragment specific to this shot, if any. */
  negative_prompt?: string;
  /**
   * Editorial intent of this shot. Set by the LLM in step 09 alongside
   * `scene` and friends. Pure metadata — chunk timing is owned by the
   * chunker step 08.
   */
  beat_type?: BeatType;
}
