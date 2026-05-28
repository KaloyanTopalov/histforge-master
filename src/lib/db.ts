import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LlmProviderName } from "./llm/names";

/**
 * Default values for every setting key. Stored as strings; lib/settings.ts
 * handles coercion to native types. Required-but-unset keys (the OpenRouter
 * model fields, voice_id) seed as empty string — the operator fills them
 * in via /settings.
 */
const DEFAULT_SETTINGS: Record<string, string> = {
  openrouter_script_model: "",
  openrouter_visual_model: "",
  claude_cli_script_model: "claude-opus-4-7",
  claude_cli_visual_model: "claude-opus-4-7",
  image_provider: "comfyui",
  comfyui_base_url: "http://127.0.0.1:8188",
  comfyui_workflow_path: "prompts/comfyui/default-workflow.json",
  comfyui_hook_video_workflow_path:
    "prompts/comfyui/default-hook-video-workflow.json",
  google_flow_relogin_needed: "false",
  flow_create_project_failed: "",
  flow_service_overload_until: "",
  google_flow_service_overload_cooldown_minutes: "15",
  google_flow_account_cooldown_hours: "4",
  google_flow_max_retries: "3",
  google_flow_image_model: "NARWHAL",
  google_flow_video_model: "veo_3_1_t2v_lite_low_priority",
  google_flow_aspect_ratio: "landscape",
  google_flow_image_aspect_ratio: "16:9",
  google_flow_hook_clip_seconds: "8",
  google_flow_dispatch_timeout_minutes: "30",
  aspect_ratio: "16:9",
  long_edge_px: "1920",
  framerate: "30",
  video_encoder: "libx264",
  hook_video_clip_seconds: "8",
  hook_length_seconds: "120",
  script_length_minutes: "90",
  voice_id: "",
  voiceover_model_id: "eleven_multilingual_v2",
  voice_stability: "0.75",
  voice_similarity: "0.5",
  voice_style: "0.0",
  voice_speed: "1.0",
  voice_use_speaker_boost: "true",
  queue_state: "running",
  google_flow_content_moderation_enabled: "true",
  google_flow_content_moderation_max_rounds: "2",
  google_flow_content_moderation_model: "",
  chatterbox_base_url: "http://127.0.0.1:8004",
  chatterbox_fast_base_url: "http://127.0.0.1:8005",
  chatterbox_voice_mode: "predefined",
  chatterbox_voice_filename: "",
  chatterbox_temperature: "0.8",
  chatterbox_exaggeration: "0.5",
  chatterbox_cfg_weight: "0.5",
  chatterbox_speed_factor: "1.0",
  chatterbox_fast_max_chunk_chars: "300",
  chatterbox_fast_silence_ms: "150",
  chatterbox_fast_workers: "2",
  visual_prompts_batch_size: "8",
  claude_cli_visual_prompts_concurrency: "2",
  openrouter_visual_prompts_concurrency: "8",
  // Target chunk duration (seconds) for the chunk_images_only chunker.
  // Default 8s gives ~7-8 chunks per minute of narration — close to typical
  // YouTube-narrative pacing. Lower for faster cuts, higher to dwell on
  // each image. The chunk-clips-then-images chunker keeps the legacy
  // MAIN_TARGET_SECONDS=30 in chunk-utils.ts because its image segments
  // are paired with hook clips and don't drive visual pacing alone.
  image_chunk_target_seconds: "8",
  // Hard floor + soft ceiling for chunk_images_only durations. The chunker
  // forward-merges short chunks until min is satisfied; oversized single
  // sentences exceed max with a logged warning (can't subdivide a single
  // sentence's VO). Together with the target above, they form a [min,
  // target, max] envelope the per-video `videos.image_chunk_*_seconds`
  // override columns can shadow on a per-field basis.
  image_chunk_min_seconds: "4",
  image_chunk_max_seconds: "12",
  // Few-shot example block for step 09's prompt template. JSON-encoded
  // array of exemplar scene objects; empty = no block. Operators paste
  // 2-3 hand-picked entries from their best video to lock house style.
  // JSON parseability is validated at the consumer (step 09), not at
  // write-time, so an operator iterating on the JSON can save partial
  // progress without hand-validating every keystroke.
  step_09_examples_json: "",
  // Plan 2 Phase 2.1 Task 2: Magnific (music-video kind) keys. Empty
  // token seeds because the Settings > Magnific tab mints one on first
  // open via a server-side randomBytes helper; the four routes 404 until
  // a non-empty value is set. Models are free-text in v1 so operators
  // can adopt new Magnific model slugs without a code update. Dispatch
  // timeout is the per-row age cap the reaper consults for image-to-video
  // rows (image-hitl rows have no_timeout=1 and bypass the cap).
  magnific_token: "",
  magnific_dispatch_timeout_minutes: "30",
  magnific_image_model: "flux-realism",
  magnific_video_model: "seedance",
  // Auto-flipped by /api/magnific/status on session_expired events; the
  // dashboard surfaces it so the operator knows to re-login the magnific.ai
  // tab. Mirrors google_flow_relogin_needed but lives in a Magnific-specific
  // key so the two providers' banner state never bleed across.
  magnific_relogin_needed: "false",
  // Loop seam mitigation tunables for the music_video render step.
  // Defaults match the prior module-level constants in
  // src/worker/steps/render-music-video.ts (trim_tail = LOOP_CLIP_TRIM_TAIL_S,
  // xfade = LOOP_CLIP_XFADE_S) so on-disk behavior is unchanged on a fresh DB.
  music_video_loop_trim_tail_seconds: "0.3",
  music_video_loop_xfade_seconds: "0.2",
  // Character-lock + style-lock plan. Defaults are the verbatim spec
  // text — keep in sync with the createDb INSERT OR IGNORE migration
  // statements below (the dev-DB upgrade path) and the tests under
  // __tests__/image/settings-defaults.test.ts.
  style_lock_description:
    "2D hand-drawn animation style, plain white background, pure black line work only, no color, no shading, no gradients, no 3D rendering, no photorealism, slight hand-drawn imperfection in linework. The character must be drawn in the exact same minimalist style as the reference ingredient.",
  character_lock_negative:
    "color, shading, gradient, 3D, photorealistic, vector-clean lines, multiple characters, child, cartoon mascot, anime, manga, smiling, happy expression",
  // Magnific runtime — defaults match the spec's "Settings" section.
  // `enabled` is false so a fresh DB doesn't auto-boot the runtime;
  // operators flip it after wiring up the magnific-ext install. The
  // user_data_dir / extension_path are operator-relative — the runtime
  // calls path.resolve() on them at start time.
  magnific_runtime_enabled: "false",
  magnific_runtime_user_data_dir: "data/magnific-userdata",
  magnific_runtime_window_visible: "false",
  magnific_runtime_extension_path: "extensions/magnific-ext",
};

export function seedDefaultSettings(db: DatabaseType): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
  );
  const insertAll = db.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      stmt.run(key, value);
    }
  });
  insertAll();
}

/**
 * Built-in workflow seeds. The two rows + their script-module step lists
 * shipped with HistForge. `seedDefaultWorkflows` stamps the lifecycle
 * columns (is_builtin, enabled, version, timestamps) on insert; this
 * carrier carries only the user-authored fields. Glue / module
 * (TTS/image/video) steps are inserted at materialization time from the
 * four provider columns — see `lib/workflows.ts:materializeStepList`.
 */
export type SeedWorkflow = {
  id: string;
  label: string;
  short_label: string;
  description: string;
  kind: "narrative" | "music_video";
  script_llm_provider: LlmProviderName | null;
  tts_provider: "ai33" | null;
  image_provider: "comfyui" | "google_flow" | "magnific" | null;
  video_provider: "comfyui" | "google_flow" | "magnific" | null;
  music_provider: "suno" | null;
  upscaler_provider: string | null;
  chunker_step:
    | "chunk_clips_then_images"
    | "chunk_images_only"
    | "chunk_clips_only"
    | null;
  /** Optional seed override of the `enabled` flag; omitted entries default to 1 (enabled). */
  enabled?: 0 | 1;
  steps: { step_name: string }[];
};

export const BUILTIN_WORKFLOWS: readonly SeedWorkflow[] = [
  {
    id: "comfyui",
    label: "ComfyUI (local images, local hook video)",
    short_label: "ComfyUI",
    description:
      "Local image generation and hook video via a self-hosted ComfyUI server.",
    kind: "narrative",
    script_llm_provider: "openrouter",
    tts_provider: "ai33",
    image_provider: "comfyui",
    video_provider: "comfyui",
    music_provider: null,
    upscaler_provider: null,
    chunker_step: "chunk_clips_then_images",
    steps: [
      { step_name: "research_outline" },
      { step_name: "write_hook" },
      { step_name: "write_chapters" },
    ],
  },
  {
    id: "google-flow",
    label: "Google Flow (cloud images, cloud hook video)",
    short_label: "Google Flow",
    description:
      "Cloud image generation and hook video via the Google Flow extension queue.",
    kind: "narrative",
    script_llm_provider: "openrouter",
    tts_provider: "ai33",
    image_provider: "google_flow",
    video_provider: "google_flow",
    music_provider: null,
    upscaler_provider: null,
    chunker_step: "chunk_clips_then_images",
    steps: [
      { step_name: "research_outline" },
      { step_name: "write_hook" },
      { step_name: "write_chapters" },
    ],
  },
  {
    id: "google-flow-images-only",
    label: "Google Flow (images only)",
    short_label: "GF Images",
    description:
      "Zoom-panned still images for the full narration — no hook clip section.",
    kind: "narrative",
    script_llm_provider: "openrouter",
    tts_provider: "ai33",
    image_provider: "google_flow",
    video_provider: null,
    music_provider: null,
    upscaler_provider: null,
    chunker_step: "chunk_images_only",
    steps: [
      { step_name: "research_outline" },
      { step_name: "write_hook" },
      { step_name: "write_chapters" },
    ],
  },
  {
    id: "google-flow-clips-only",
    label: "Google Flow (clips only)",
    short_label: "GF Clips",
    description:
      "Generated video clips for the full narration — no still-image section.",
    kind: "narrative",
    script_llm_provider: "openrouter",
    tts_provider: "ai33",
    image_provider: null,
    video_provider: "google_flow",
    music_provider: null,
    upscaler_provider: null,
    chunker_step: "chunk_clips_only",
    steps: [
      { step_name: "research_outline" },
      { step_name: "write_hook" },
      { step_name: "write_chapters" },
    ],
  },
  {
    id: "music-video-magnific-suno",
    label: "Music video (Magnific images + Suno music)",
    short_label: "Magnific × Suno",
    description:
      "Music-video pipeline: Magnific-generated loop image + clip, Suno-generated tracks.",
    kind: "music_video",
    script_llm_provider: null,
    tts_provider: null,
    image_provider: "magnific",
    video_provider: "magnific",
    music_provider: "suno",
    upscaler_provider: null,
    chunker_step: null,
    steps: [],
  },
  {
    id: "narrative-magnific-nano-banana",
    label: "Narrative — Magnific (Nano Banana 2)",
    short_label: "Magnific NB2",
    description:
      "Narrative still images via Magnific's Google Nano Banana 2 model, one Project per video.",
    kind: "narrative",
    script_llm_provider: "openrouter",
    tts_provider: "ai33",
    image_provider: "magnific",
    video_provider: null,
    music_provider: null,
    upscaler_provider: null,
    chunker_step: "chunk_images_only",
    // Enabled in S2: MagnificImageProvider.generateBatch now enqueues
    // image-batch rows and awaits the queue, replacing the throwing stub —
    // see the magnific-narrative spec.
    enabled: 1,
    steps: [
      { step_name: "research_outline" },
      { step_name: "write_hook" },
      { step_name: "write_chapters" },
    ],
  },
];

/**
 * Seed the two built-in workflow rows + their script-module step lists.
 * Idempotent: re-running preserves any operator edits via `INSERT OR
 * IGNORE`. The `is_builtin = 1` flag is what Phase 2's "Reset to default"
 * button uses to identify which rows it can reset to the shipped
 * definition; forgetting it here would silently break that flow.
 *
 * `videos.workflow_id` carries an FK to `workflows(id)` on greenfield
 * DBs (SQLite cannot retrofit FK constraints via ALTER on existing
 * columns), so this seed must run before any video insert can succeed.
 * `createDb` calls it on every open for the same reason — runtime paths
 * that bypass `db:init` (tests, ad-hoc connections) need the FK targets
 * present.
 */
export function seedDefaultWorkflows(db: DatabaseType): void {
  const insertWorkflow = db.prepare(
    `INSERT OR IGNORE INTO workflows
       (id, label, short_label, description, kind, script_llm_provider,
        tts_provider, image_provider, video_provider,
        music_provider, upscaler_provider,
        is_builtin, enabled, version, created_at, updated_at,
        chunker_step)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?, ?)`
  );
  const insertStep = db.prepare(
    "INSERT OR IGNORE INTO workflow_steps (workflow_id, position, step_name) VALUES (?, ?, ?)"
  );
  const seedAll = db.transaction(() => {
    for (const wf of BUILTIN_WORKFLOWS) {
      const now = Date.now();
      insertWorkflow.run(
        wf.id,
        wf.label,
        wf.short_label,
        wf.description,
        wf.kind,
        wf.script_llm_provider,
        wf.tts_provider,
        wf.image_provider,
        wf.video_provider,
        wf.music_provider,
        wf.upscaler_provider,
        wf.enabled ?? 1,
        now,
        now,
        wf.chunker_step
      );
      wf.steps.forEach((step, position) => {
        insertStep.run(wf.id, position, step.step_name);
      });
    }
  });
  seedAll();
}

/**
 * Lazy singleton around createDb(process.env.DATABASE_URL).
 * App code (API routes, worker) calls this. Tests and the db-init script
 * call createDb directly so they can control the path.
 */
let _db: DatabaseType | null = null;
export function getDb(): DatabaseType {
  if (!_db) {
    const path = process.env.DATABASE_URL;
    if (!path) {
      throw new Error(
        "DATABASE_URL is not set. Copy .env.example to .env and fill it in."
      );
    }
    _db = createDb(path);
  }
  return _db;
}

export function createDb(path: string): DatabaseType {
  // Create the parent directory for file-backed paths so fresh checkouts with
  // DATABASE_URL=./data/histforge.db just work. Skip for SQLite special paths
  // (":memory:" and ""), which are not filesystem targets.
  if (path && path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id                  TEXT PRIMARY KEY,
      label               TEXT NOT NULL,
      short_label         TEXT NOT NULL,
      description         TEXT,
      script_llm_provider TEXT,
      tts_provider        TEXT,
      image_provider      TEXT,
      video_provider      TEXT,
      music_provider      TEXT,
      upscaler_provider   TEXT,
      kind                TEXT NOT NULL DEFAULT 'narrative',
      is_builtin          INTEGER NOT NULL DEFAULT 0,
      enabled             INTEGER NOT NULL DEFAULT 1,
      version             INTEGER NOT NULL DEFAULT 1,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      chunker_step        TEXT
    );
    CREATE TABLE IF NOT EXISTS workflow_steps (
      workflow_id  TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      position     INTEGER NOT NULL,
      step_name    TEXT NOT NULL,
      PRIMARY KEY (workflow_id, position)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow
      ON workflow_steps(workflow_id, position);
    CREATE TABLE IF NOT EXISTS videos (
      id                    TEXT PRIMARY KEY,
      title                 TEXT NOT NULL,
      topic_info            TEXT NOT NULL,
      workflow_id           TEXT NOT NULL REFERENCES workflows(id) ON DELETE RESTRICT,
      workflow_snapshot     TEXT,
      visual_style_id       TEXT REFERENCES visual_styles(id) ON DELETE SET NULL,
      visual_style_snapshot TEXT,
      status                TEXT NOT NULL,
      current_step          TEXT,
      failed_step           TEXT,
      failed_reason         TEXT,
      started_at            INTEGER,
      finished_at           INTEGER,
      output_path           TEXT,
      delete_requested      INTEGER NOT NULL DEFAULT 0,
      paused                INTEGER NOT NULL DEFAULT 0,
      provided_script       TEXT,
      kind                  TEXT NOT NULL DEFAULT 'narrative',
      magnific_image_prompt TEXT,
      magnific_motion_prompt TEXT,
      suno_style_prompt     TEXT,
      song_count            INTEGER,
      repeat_factor         INTEGER,
      created_at            INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS video_steps (
      video_id      TEXT NOT NULL REFERENCES videos(id),
      step_name     TEXT NOT NULL,
      status        TEXT NOT NULL,
      started_at    INTEGER,
      finished_at   INTEGER,
      PRIMARY KEY (video_id, step_name)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key           TEXT PRIMARY KEY,
      value         TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS google_flow_accounts (
      id                   TEXT PRIMARY KEY,
      name                 TEXT NOT NULL,
      token                TEXT NOT NULL UNIQUE,
      quota_used_today     INTEGER NOT NULL DEFAULT 0,
      paused_until         INTEGER,
      last_seen_at         INTEGER,
      credits              INTEGER,
      credits_updated_at   INTEGER,
      enabled              INTEGER NOT NULL DEFAULT 1,
      recovery_reason      TEXT,
      recovery_required_at INTEGER,
      created_at           INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS google_flow_queue (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id              TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      chunk_id              TEXT,
      kind                  TEXT NOT NULL,
      mode                  TEXT NOT NULL,
      prompt                TEXT NOT NULL,
      reference_image       TEXT,
      start_frame           TEXT,
      end_frame             TEXT,
      output_path           TEXT NOT NULL,
      status                TEXT NOT NULL,
      assigned_account_id   TEXT REFERENCES google_flow_accounts(id) ON DELETE SET NULL,
      external_task_id      TEXT,
      result_url            TEXT,
      error_reason          TEXT,
      retry_count           INTEGER NOT NULL DEFAULT 0,
      moderation_round      INTEGER NOT NULL DEFAULT 0,
      priority              INTEGER NOT NULL DEFAULT 0,
      created_at            INTEGER NOT NULL,
      dispatched_at         INTEGER,
      completed_at          INTEGER,
      google_operation_id   TEXT,
      google_operation_project_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_google_flow_queue_pickup
      ON google_flow_queue (status, priority, id);
    CREATE TABLE IF NOT EXISTS magnific_queue (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id          TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      mode              TEXT NOT NULL,
      prompt            TEXT NOT NULL,
      reference_image   TEXT,
      output_path       TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      no_timeout        INTEGER NOT NULL DEFAULT 0,
      external_task_id  TEXT,
      result_url        TEXT,
      error_reason      TEXT,
      retry_count       INTEGER NOT NULL DEFAULT 0,
      created_at        INTEGER NOT NULL,
      dispatched_at     INTEGER,
      completed_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_magnific_queue_pickup
      ON magnific_queue (status, id);
    CREATE TABLE IF NOT EXISTS google_flow_video_projects (
      video_id         TEXT NOT NULL,
      account_id       TEXT NOT NULL,
      flow_project_id  TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      PRIMARY KEY (video_id, account_id),
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS moderation_events (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id          TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      chunk_id          TEXT NOT NULL,
      kind              TEXT NOT NULL,
      round             INTEGER NOT NULL,
      original_prompt   TEXT NOT NULL,
      rewritten_prompt  TEXT NOT NULL,
      reason_tag        TEXT,
      created_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_moderation_events_video_created
      ON moderation_events (video_id, created_at);
    CREATE TABLE IF NOT EXISTS visual_styles (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      prompt      TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);

  // Migration for DBs that predate the `paused` column. SQLite has no
  // ADD COLUMN IF NOT EXISTS, so we narrowly swallow the duplicate-column
  // error and rethrow anything else — silently ignoring all errors would
  // mask real bugs.
  try {
    db.exec(
      "ALTER TABLE videos ADD COLUMN paused INTEGER NOT NULL DEFAULT 0"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }

  // Same additive-migration pattern for deferred_until (unix-seconds
  // timestamp; null means "eligible now"). Used by the Flow step to
  // yield back to the orchestrator while all accounts are in cooldown.
  try {
    db.exec("ALTER TABLE videos ADD COLUMN deferred_until INTEGER");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }

  // chunker_step picks the variant chunker step a workflow runs (one of
  // chunk_clips_then_images / chunk_images_only / chunk_clips_only).
  // The DEFAULT covers existing rows on upgrade — every legacy workflow
  // is the clips-then-images shape. Greenfield CREATE TABLE relaxes this
  // to nullable (Plan 1 Phase 1.1 Task 2) so music_video rows can carry
  // null; legacy rows keep their non-null values.
  try {
    db.exec(
      "ALTER TABLE workflows ADD COLUMN chunker_step TEXT NOT NULL DEFAULT 'chunk_clips_then_images'"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }

  // Plan 1 Phase 1.1 Task 2: workflows.kind discriminates the row's
  // pipeline (narrative vs music_video). DEFAULT 'narrative' covers
  // existing rows on upgrade — every legacy workflow is narrative-shaped.
  // music_provider + upscaler_provider are music-video-only columns;
  // both nullable because narrative workflows leave them empty.
  try {
    db.exec(
      "ALTER TABLE workflows ADD COLUMN kind TEXT NOT NULL DEFAULT 'narrative'"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }
  try {
    db.exec("ALTER TABLE workflows ADD COLUMN music_provider TEXT");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }
  try {
    db.exec("ALTER TABLE workflows ADD COLUMN upscaler_provider TEXT");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }

  // Plan 1 Phase 1.1 Task 2: relax `script_llm_provider` and `chunker_step`
  // to nullable on legacy DBs. SQLite has no ALTER COLUMN, so we detect the
  // stale shape via PRAGMA and run the standard rename-create-copy-drop
  // table rebuild. The seed step below needs both columns nullable so the
  // `music-video-magnific-suno` builtin (script null, chunker null) can be
  // INSERTed by `seedDefaultWorkflows`. Skipped when the table already has
  // the relaxed shape (no-op on greenfield and re-runs).
  const wfCols = db.prepare("PRAGMA table_info(workflows)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const scriptCol = wfCols.find((c) => c.name === "script_llm_provider");
  const chunkerCol = wfCols.find((c) => c.name === "chunker_step");
  if (
    (scriptCol && scriptCol.notnull === 1) ||
    (chunkerCol && chunkerCol.notnull === 1)
  ) {
    db.exec(`
      CREATE TABLE workflows_new (
        id                  TEXT PRIMARY KEY,
        label               TEXT NOT NULL,
        short_label         TEXT NOT NULL,
        description         TEXT,
        script_llm_provider TEXT,
        tts_provider        TEXT,
        image_provider      TEXT,
        video_provider      TEXT,
        music_provider      TEXT,
        upscaler_provider   TEXT,
        kind                TEXT NOT NULL DEFAULT 'narrative',
        is_builtin          INTEGER NOT NULL DEFAULT 0,
        enabled             INTEGER NOT NULL DEFAULT 1,
        version             INTEGER NOT NULL DEFAULT 1,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        chunker_step        TEXT
      );
      INSERT INTO workflows_new
        (id, label, short_label, description, script_llm_provider,
         tts_provider, image_provider, video_provider, music_provider,
         upscaler_provider, kind, is_builtin, enabled, version,
         created_at, updated_at, chunker_step)
      SELECT id, label, short_label, description, script_llm_provider,
             tts_provider, image_provider, video_provider, music_provider,
             upscaler_provider, kind, is_builtin, enabled, version,
             created_at, updated_at, chunker_step
        FROM workflows;
      DROP TABLE workflows;
      ALTER TABLE workflows_new RENAME TO workflows;
    `);
  }

  // Same additive-migration pattern for workflow_snapshot (per-video
  // pinned JSON of the workflow row + its step list, written at create /
  // queue time so an in-flight run is not affected by later edits to
  // the live workflow row). The FK on `videos.workflow_id` is greenfield-
  // only — SQLite cannot retrofit a FK constraint via ALTER, so existing
  // DB users get the column but no FK enforcement.
  try {
    db.exec("ALTER TABLE videos ADD COLUMN workflow_snapshot TEXT");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }

  // Same additive-migration pattern for provided_script. When non-null,
  // queue-time prep writes it to `script/full_script.md` and pre-marks
  // the script-generation steps (01-05) as `done` so the orchestrator
  // skips them and starts the run at voiceover (step 06).
  try {
    db.exec("ALTER TABLE videos ADD COLUMN provided_script TEXT");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }

  // Same additive-migration pattern for the per-video visual-style FK and
  // its pinned snapshot. ALTER cannot retrofit a FK constraint on SQLite,
  // so existing DB users get the column without ON DELETE SET NULL — only
  // greenfield DBs get the constraint. The snapshot column is plain TEXT
  // (parsed as JSON at read time).
  try {
    db.exec("ALTER TABLE videos ADD COLUMN visual_style_id TEXT");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }
  try {
    db.exec("ALTER TABLE videos ADD COLUMN visual_style_snapshot TEXT");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }

  // Plan 1 Phase 1.1: `kind` discriminates the row's pipeline (narrative
  // vs music_video). DEFAULT 'narrative' covers existing rows on upgrade
  // — every legacy video is narrative-shaped. The four music-video-only
  // typed columns are nullable: they carry data only when kind='music_video';
  // per-kind required/forbidden invariants are enforced at the repo layer
  // (`createNewVideo`), not in SQL.
  try {
    db.exec(
      "ALTER TABLE videos ADD COLUMN kind TEXT NOT NULL DEFAULT 'narrative'"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }
  try {
    db.exec("ALTER TABLE videos ADD COLUMN magnific_image_prompt TEXT");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }
  // Music-video motion prompt — separate from magnific_image_prompt so
  // operators can drive Seedance with motion text that doesn't have to
  // read like a still-image prompt. Backfilled below for any pre-existing
  // music_video row so the worker step doesn't trip on NULL.
  try {
    db.exec("ALTER TABLE videos ADD COLUMN magnific_motion_prompt TEXT");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }
  // IS NULL guard: re-runs of the migration on a row whose form-supplied
  // motion prompt is already set must not clobber the operator's value.
  db.exec(
    "UPDATE videos SET magnific_motion_prompt = magnific_image_prompt || ' — slow cinematic motion, smooth loop, looping camera' WHERE kind = 'music_video' AND magnific_motion_prompt IS NULL AND magnific_image_prompt IS NOT NULL"
  );
  try {
    db.exec("ALTER TABLE videos ADD COLUMN suno_style_prompt TEXT");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }
  try {
    db.exec("ALTER TABLE videos ADD COLUMN song_count INTEGER");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }
  try {
    db.exec("ALTER TABLE videos ADD COLUMN repeat_factor INTEGER");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }

  // Per-video image chunk pacing override columns. Each is nullable
  // INTEGER; NULL means "fall through to the matching
  // image_chunk_*_seconds global setting" via getImageChunkPacing().
  // Additive ALTER per the duplicate-column-swallow pattern above so
  // upgraded DBs gain the columns and re-runs are no-ops.
  try {
    db.exec(
      "ALTER TABLE videos ADD COLUMN image_chunk_target_seconds INTEGER"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }
  try {
    db.exec("ALTER TABLE videos ADD COLUMN image_chunk_min_seconds INTEGER");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }
  try {
    db.exec("ALTER TABLE videos ADD COLUMN image_chunk_max_seconds INTEGER");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }

  // Per-video Magnific Project UUID. The narrative-magnific image path
  // caches the created Project's id here after first creation so later
  // chunks reuse it instead of re-creating a Project. Nullable TEXT;
  // NULL = no Project created yet. Additive ALTER per the
  // duplicate-column-swallow pattern above.
  try {
    db.exec("ALTER TABLE videos ADD COLUMN magnific_project_id TEXT");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }

  // moderation_round tracks how many times a queue row has been rewritten
  // by the in-step content-moderation loop. 0 means "original prompt".
  // Pre-existing failed-content-policy rows pick up the default and the
  // loop will treat them as round 0 → first rewrite is round 1.
  try {
    db.exec(
      "ALTER TABLE google_flow_queue ADD COLUMN moderation_round INTEGER NOT NULL DEFAULT 0"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }

  // google_operation_id + google_operation_project_id let a requeued task
  // resume polling instead of re-submitting. Set after the extension's
  // submit returns; consumed by next-task to tell the extension "the
  // operation is already alive, just poll." Both nullable: pending and
  // pre-submit dispatched rows have no operation yet.
  try {
    db.exec(
      "ALTER TABLE google_flow_queue ADD COLUMN google_operation_id TEXT"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }
  try {
    db.exec(
      "ALTER TABLE google_flow_queue ADD COLUMN google_operation_project_id TEXT"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }

  // Operator-gated reCAPTCHA recovery: when an account hits a reCAPTCHA
  // challenge, handleCaptcha stamps `recovery_reason = 'captcha'` and
  // `recovery_required_at = <now>`. The dispatch gate in next-task
  // short-circuits while `recovery_reason IS NOT NULL`; the operator
  // clears both via POST /api/flow/accounts/<id>/clear-captcha-recovery.
  // Both nullable: pre-existing rows have no recovery state.
  try {
    db.exec(
      "ALTER TABLE google_flow_accounts ADD COLUMN recovery_reason TEXT"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }
  try {
    db.exec(
      "ALTER TABLE google_flow_accounts ADD COLUMN recovery_required_at INTEGER"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }

  // google_flow image/video model migrations. All three are idempotent and
  // run on every open so existing installs don't have to re-run db:init:
  //  1) image_model used to be free-form text; coerce anything outside the
  //     new enum (legacy "GEM_PIX", typos, "") back to the default before
  //     getSetting can ZodError on it.
  //  2) video_quality was removed from the schema; drop any orphan row.
  //  3) video_model is new; INSERT OR IGNORE seeds it for upgraded DBs that
  //     don't go through seedDefaultSettings (only db:init invokes that).
  //     Keep this default in sync with DEFAULT_SETTINGS above.
  db.prepare(
    "UPDATE settings SET value = 'NARWHAL' WHERE key = 'google_flow_image_model' AND value NOT IN ('NARWHAL','GEM_PIX_2','IMAGEN_3_5')"
  ).run();
  db.prepare("DELETE FROM settings WHERE key = 'google_flow_video_quality'").run();
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('google_flow_video_model', 'veo_3_1_t2v_lite_low_priority')"
  ).run();

  // google_flow_hook_clip_seconds (Phase 2 of hook settings redesign):
  // per-clip duration enum for the Google Flow hook video provider,
  // encoded into the dispatched Veo videoModelKey at claim time. Seed
  // default for upgraded DBs that don't go through db:init. Keep in
  // sync with DEFAULT_SETTINGS above.
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('google_flow_hook_clip_seconds', '8')"
  ).run();

  // content-moderation settings: seed defaults on upgraded DBs that don't
  // re-run db:init. Same INSERT OR IGNORE pattern as google_flow_video_model
  // above. Keep the values in sync with DEFAULT_SETTINGS.
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('google_flow_content_moderation_enabled', 'true')"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('google_flow_content_moderation_max_rounds', '2')"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('google_flow_content_moderation_model', '')"
  ).run();

  // hook_video_clip_seconds was added after the initial schema; seed for
  // upgraded DBs that don't re-run db:init. Keep in sync with
  // DEFAULT_SETTINGS above. The companion `hook_length_seconds` is
  // seeded by its own migration block below — its fresh-DB fallback
  // INSERT covers the "no legacy hook_chunk_count row" case.
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('hook_video_clip_seconds', '8')"
  ).run();

  // video_encoder is new (ADR-0004): selectable Stage CD encoder. Seed
  // libx264 default for upgraded DBs that don't go through db:init.
  // Keep in sync with DEFAULT_SETTINGS above.
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('video_encoder', 'libx264')"
  ).run();

  // visual-prompts batching knobs (ADR-0002). Seed defaults on upgraded
  // DBs that don't re-run db:init. Keep in sync with DEFAULT_SETTINGS.
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('visual_prompts_batch_size', '8')"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('claude_cli_visual_prompts_concurrency', '2')"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('openrouter_visual_prompts_concurrency', '8')"
  ).run();
  // Image chunk pacing — seed defaults for upgraded DBs. The target
  // shipped earlier (above); min/max + the step 09 examples slot are the
  // foundation half of the per-video pacing override feature.
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('image_chunk_target_seconds', '8')"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('image_chunk_min_seconds', '4')"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('image_chunk_max_seconds', '12')"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('step_09_examples_json', '')"
  ).run();

  // Magnific runtime — seed defaults on upgraded DBs that never re-run
  // db:init. The runtime itself is noop in S1; these values configure
  // the future lifecycle (auto-boot toggle, persistent context dir,
  // window visibility, extension path). Keep in sync with DEFAULT_SETTINGS.
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('magnific_runtime_enabled', 'false')"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('magnific_runtime_user_data_dir', 'data/magnific-userdata')"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('magnific_runtime_window_visible', 'false')"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('magnific_runtime_extension_path', 'extensions/magnific-ext')"
  ).run();

  // Character-lock + style-lock plan. Two free-text settings consumed
  // by step 09's prompt-assembly post-processing. Seed defaults on
  // upgraded DBs that don't re-run db:init. Keep values in sync with
  // DEFAULT_SETTINGS above.
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('style_lock_description', ?)"
  ).run(
    "2D hand-drawn animation style, plain white background, pure black line work only, no color, no shading, no gradients, no 3D rendering, no photorealism, slight hand-drawn imperfection in linework. The character must be drawn in the exact same minimalist style as the reference ingredient."
  );
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('character_lock_negative', ?)"
  ).run(
    "color, shading, gradient, 3D, photorealistic, vector-clean lines, multiple characters, child, cartoon mascot, anime, manga, smiling, happy expression"
  );

  // act_distribution was removed from the schema. Drop any orphan row
  // so getAllSettings() returns a clean shape on upgraded DBs.
  db.prepare("DELETE FROM settings WHERE key = 'act_distribution'").run();

  // LLM settings restructure: one-shot fan-out from the legacy single-
  // model rows into the new per-purpose pair (script + visual) for each
  // provider. `model_name` and `claude_cli_model` carried one global
  // model each; the new schema gives every provider a script slot and a
  // visual slot so chunk enrichment / moderation can run on a cheaper
  // model than the script writer. INSERT OR IGNORE preserves operator
  // edits if the new rows were already set; the DELETE wipes the legacy
  // rows last so getAllSettings() doesn't surface them as unknown keys.
  // Stripped outright (no destination): `enrich_chunks_llm_provider`
  // (replaced by snapshot-pinned provider), `claude_cli_path` (binary
  // hardcoded), `claude_cli_extra_args` (extra-args splice dropped).
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) SELECT 'openrouter_script_model', value FROM settings WHERE key = 'model_name'"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) SELECT 'openrouter_visual_model', value FROM settings WHERE key = 'model_name'"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) SELECT 'claude_cli_script_model', value FROM settings WHERE key = 'claude_cli_model'"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) SELECT 'claude_cli_visual_model', value FROM settings WHERE key = 'claude_cli_model'"
  ).run();
  db.prepare("DELETE FROM settings WHERE key = 'model_name'").run();
  db.prepare("DELETE FROM settings WHERE key = 'claude_cli_model'").run();
  db.prepare(
    "DELETE FROM settings WHERE key = 'enrich_chunks_llm_provider'"
  ).run();
  db.prepare("DELETE FROM settings WHERE key = 'claude_cli_path'").run();
  db.prepare(
    "DELETE FROM settings WHERE key = 'claude_cli_extra_args'"
  ).run();

  // chapter_count + chapter_target_words were removed from the schema.
  // chapter_count is replaced by script_length_minutes (operator inputs
  // minutes; chapter count is derived at 6 min/chapter). Preserve the
  // operator's prior chapter_count preference by seeding
  // script_length_minutes = chapter_count × 6 (so 15 chapters → 90 min,
  // 20 → 120). The (a) → (b) → (c) order is load-bearing on first
  // execution: (a) must run before (c) deletes chapter_count, and (b)
  // is the fallback for DBs that never had chapter_count.
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) SELECT 'script_length_minutes', CAST(CAST(value AS INTEGER) * 6 AS TEXT) FROM settings WHERE key = 'chapter_count'"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('script_length_minutes', '90')"
  ).run();
  db.prepare("DELETE FROM settings WHERE key = 'chapter_count'").run();
  db.prepare("DELETE FROM settings WHERE key = 'chapter_target_words'").run();

  // hook_chunk_count was replaced by hook_length_seconds (operator inputs
  // total hook seconds; the chunker derives the count from
  // seconds / hook_video_clip_seconds at run time). Preserve the operator's
  // prior preference by seeding hook_length_seconds = round(count × clip).
  // The (a) → (b) → (c) order is load-bearing on first execution, mirroring
  // the chapter_count migration above: (a) must run before (c) deletes
  // hook_chunk_count, and (b) is the fallback for DBs that never had it.
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) SELECT 'hook_length_seconds', CAST(CAST(ROUND(c.v * s.v) AS INTEGER) AS TEXT) FROM (SELECT CAST(value AS REAL) AS v FROM settings WHERE key='hook_chunk_count') c, (SELECT CAST(value AS REAL) AS v FROM settings WHERE key='hook_video_clip_seconds') s"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('hook_length_seconds', '120')"
  ).run();
  db.prepare("DELETE FROM settings WHERE key = 'hook_chunk_count'").run();

  // Slug rename: enrich_chunks → generate_visual_prompts. Five idempotent
  // UPDATEs cover all rows that may carry the legacy slug. The LIKE
  // predicate on the snapshot scan ensures the scrub loop is a no-op on a
  // re-run. Unlike the research_characters scrub below — which is a step
  // *removal* and safely leaves dormant terminal rows alone — this is a
  // *rename*, so we drop the status filter: a failed/done video re-queued
  // via retry/restart would otherwise re-enter the pipeline with the
  // legacy slug and trip bootValidate.
  db.prepare(
    "UPDATE workflow_steps SET step_name = 'generate_visual_prompts' WHERE step_name = 'enrich_chunks'"
  ).run();
  db.prepare(
    "UPDATE video_steps SET step_name = 'generate_visual_prompts' WHERE step_name = 'enrich_chunks'"
  ).run();
  db.prepare(
    "UPDATE videos SET current_step = 'generate_visual_prompts' WHERE current_step = 'enrich_chunks'"
  ).run();
  db.prepare(
    "UPDATE videos SET failed_step = 'generate_visual_prompts' WHERE failed_step = 'enrich_chunks'"
  ).run();
  const legacyEnrichSnapshotRows = db
    .prepare(
      "SELECT id, workflow_snapshot FROM videos WHERE workflow_snapshot LIKE '%\"enrich_chunks\"%'"
    )
    .all() as Array<{ id: string; workflow_snapshot: string }>;
  if (legacyEnrichSnapshotRows.length > 0) {
    const updateEnrichSnapshot = db.prepare(
      "UPDATE videos SET workflow_snapshot = ? WHERE id = ?"
    );
    const renameAll = db.transaction(() => {
      for (const row of legacyEnrichSnapshotRows) {
        const parsed = JSON.parse(row.workflow_snapshot) as {
          steps: { step_name: string }[];
        };
        parsed.steps = parsed.steps.map((s) =>
          s.step_name === "enrich_chunks"
            ? { ...s, step_name: "generate_visual_prompts" }
            : s
        );
        updateEnrichSnapshot.run(JSON.stringify(parsed), row.id);
      }
    });
    renameAll();
  }

  // chunker_step backfill on videos.workflow_snapshot: in-flight runs
  // pin their workflow JSON at queue time, so a legacy snapshot lacks
  // the new field. Inject the default ("chunk_clips_then_images") on
  // any snapshot missing it. Runs unconditionally — terminal videos are
  // dormant but a future Restart re-snapshots from the live row, so
  // belt-and-suspenders covers the case where a done/failed video is
  // resumed against a stale snapshot.
  const legacyChunkerSnapshotRows = db
    .prepare(
      "SELECT id, workflow_snapshot FROM videos WHERE workflow_snapshot IS NOT NULL AND workflow_snapshot NOT LIKE '%\"chunker_step\"%'"
    )
    .all() as Array<{ id: string; workflow_snapshot: string }>;
  if (legacyChunkerSnapshotRows.length > 0) {
    const updateChunkerSnapshot = db.prepare(
      "UPDATE videos SET workflow_snapshot = ? WHERE id = ?"
    );
    const backfillAll = db.transaction(() => {
      for (const row of legacyChunkerSnapshotRows) {
        const parsed = JSON.parse(row.workflow_snapshot) as Record<
          string,
          unknown
        >;
        parsed.chunker_step = "chunk_clips_then_images";
        updateChunkerSnapshot.run(JSON.stringify(parsed), row.id);
      }
    });
    backfillAll();
  }

  // Slug rename: chunk → chunk_clips_then_images. Three idempotent UPDATEs
  // cover every table that may pin the legacy slug on an in-flight or
  // terminal video. Mirrors the enrich_chunks → generate_visual_prompts
  // block above but with two scopes intentionally omitted:
  //   • workflow_steps — chunk is glue, never user-authored. Per
  //     WorkflowSnapshot.steps docstring (src/types.ts), only script-module
  //     steps live there; chunk was always inserted by materializeStepList.
  //   • videos.workflow_snapshot JSON scrub — same reason; the snapshot's
  //     `steps[]` only stores script-module steps, so the legacy "chunk"
  //     slug never appeared in it.
  // What's left are the three runtime-state columns that *do* carry the
  // slug: video_steps.step_name (per-step status rows) and
  // videos.current_step / videos.failed_step (current-position pointers).
  db.prepare(
    "UPDATE video_steps SET step_name = 'chunk_clips_then_images' WHERE step_name = 'chunk'"
  ).run();
  db.prepare(
    "UPDATE videos SET current_step = 'chunk_clips_then_images' WHERE current_step = 'chunk'"
  ).run();
  db.prepare(
    "UPDATE videos SET failed_step = 'chunk_clips_then_images' WHERE failed_step = 'chunk'"
  ).run();

  // Slug rename: generate_main_images → generate_images (asset-type rename).
  // Same three-target shape as the chunk rename above — module-tier slug
  // inserted by materializeStepList, so workflow_steps and
  // workflow_snapshot.steps[] never carry it. Only the runtime-state
  // columns need rewriting so post-rename resumes don't dead-end on a
  // slug missing from REAL_STEPS.
  db.prepare(
    "UPDATE video_steps SET step_name = 'generate_images' WHERE step_name = 'generate_main_images'"
  ).run();
  db.prepare(
    "UPDATE videos SET current_step = 'generate_images' WHERE current_step = 'generate_main_images'"
  ).run();
  db.prepare(
    "UPDATE videos SET failed_step = 'generate_images' WHERE failed_step = 'generate_main_images'"
  ).run();

  // Slug rename: generate_hook_video → generate_clips (asset-type rename).
  // Same shape as the generate_main_images rename above.
  db.prepare(
    "UPDATE video_steps SET step_name = 'generate_clips' WHERE step_name = 'generate_hook_video'"
  ).run();
  db.prepare(
    "UPDATE videos SET current_step = 'generate_clips' WHERE current_step = 'generate_hook_video'"
  ).run();
  db.prepare(
    "UPDATE videos SET failed_step = 'generate_clips' WHERE failed_step = 'generate_hook_video'"
  ).run();

  // Enum rename: google_flow_queue.kind / moderation_events.kind values
  // "main_image" → "image" and "hook_video" → "clip" (asset-type rename).
  // Idempotent because the WHERE clause filters by old value; safe to run
  // on every open. The new values are a strict superset of legitimate
  // kinds at any given moment, so rewriting cannot collide with anything
  // already correctly stored.
  db.prepare(
    "UPDATE google_flow_queue SET kind = 'image' WHERE kind = 'main_image'"
  ).run();
  db.prepare(
    "UPDATE google_flow_queue SET kind = 'clip' WHERE kind = 'hook_video'"
  ).run();
  db.prepare(
    "UPDATE moderation_events SET kind = 'image' WHERE kind = 'main_image'"
  ).run();
  db.prepare(
    "UPDATE moderation_events SET kind = 'clip' WHERE kind = 'hook_video'"
  ).run();

  // research_characters was removed from REAL_STEPS. The worker's
  // bootValidate refuses to start while any non-terminal video pins
  // the slug in its workflow_snapshot.steps[], or while any workflow
  // row's step list still references it. Both ops are idempotent —
  // re-running on an already-scrubbed DB is a no-op.
  db.prepare(
    "DELETE FROM workflow_steps WHERE step_name = 'research_characters'"
  ).run();

  // SQLite DELETE doesn't renumber positions, so a workflow that had
  // research_characters mid-list (e.g. at position 1) now has a gap.
  // seedDefaultWorkflows below runs INSERT OR IGNORE against the new
  // BUILTIN_WORKFLOWS step lists — without compaction it fills the gap
  // with the new step list's same-position slug, leaving a duplicate
  // next to the leftover step that was already at the next position.
  // Predicate `MAX(position) >= COUNT(*)` selects only workflows with
  // a gap: for contiguous positions 0..N-1, MAX = N-1 < COUNT = N.
  const gapped = db
    .prepare(
      `SELECT workflow_id FROM workflow_steps
       GROUP BY workflow_id
       HAVING MAX(position) >= COUNT(*)`
    )
    .all() as Array<{ workflow_id: string }>;
  if (gapped.length > 0) {
    const compactAll = db.transaction(() => {
      for (const { workflow_id } of gapped) {
        const steps = db
          .prepare(
            "SELECT step_name FROM workflow_steps WHERE workflow_id = ? ORDER BY position"
          )
          .all(workflow_id) as Array<{ step_name: string }>;
        db.prepare(
          "DELETE FROM workflow_steps WHERE workflow_id = ?"
        ).run(workflow_id);
        const ins = db.prepare(
          "INSERT INTO workflow_steps (workflow_id, position, step_name) VALUES (?, ?, ?)"
        );
        steps.forEach((s, i) => ins.run(workflow_id, i, s.step_name));
      }
    });
    compactAll();
  }
  const legacySnapshotRows = db
    .prepare(
      "SELECT id, workflow_snapshot FROM videos WHERE status IN ('new','queued','in_progress') AND workflow_snapshot LIKE '%\"research_characters\"%'"
    )
    .all() as Array<{ id: string; workflow_snapshot: string }>;
  if (legacySnapshotRows.length > 0) {
    const updateSnapshot = db.prepare(
      "UPDATE videos SET workflow_snapshot = ? WHERE id = ?"
    );
    const scrubAll = db.transaction(() => {
      for (const row of legacySnapshotRows) {
        const parsed = JSON.parse(row.workflow_snapshot) as {
          steps: { step_name: string }[];
        };
        parsed.steps = parsed.steps.filter(
          (s) => s.step_name !== "research_characters"
        );
        updateSnapshot.run(JSON.stringify(parsed), row.id);
      }
    });
    scrubAll();
  }

  // One-shot cleanup of the legacy `style_prompt_default` setting key.
  // Replaced by per-video `visual_style_snapshot` (read by step 09).
  // Idempotent — DELETE with no match is a no-op.
  db.exec("DELETE FROM settings WHERE key = 'style_prompt_default'");

  // Built-in workflows are FK targets (greenfield videos.workflow_id
  // REFERENCES workflows(id) ON DELETE RESTRICT). Seed them on every
  // open so any path that bypasses `db:init` (tests, ad-hoc runtime
  // connections) still has the parent rows present. INSERT OR IGNORE
  // preserves operator edits — Phase 2's "Reset to default" is the
  // supported path for receiving updated built-in definitions.
  seedDefaultWorkflows(db);

  return db;
}
