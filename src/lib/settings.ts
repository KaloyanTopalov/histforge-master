import { z } from "zod";
import type { Database as DatabaseType } from "better-sqlite3";
import type { WorkflowSnapshot } from "@/types";
import { getDb } from "./db";
import { ENUM_VALUES } from "./settings-enums";

/**
 * Per-key validation + coercion schemas. Values are stored in the settings
 * table as TEXT; these schemas drive the string → native conversion on read
 * and native → validated-for-write on write.
 *
 * Ranges mirror docs/histforge-spec.md:217-233.
 */
const SETTING_SCHEMAS = {
  openrouter_script_model: z.string(),
  openrouter_visual_model: z.string(),
  claude_cli_script_model: z.string(),
  claude_cli_visual_model: z.string(),
  image_provider: z.enum(ENUM_VALUES.image_provider),
  comfyui_base_url: z.string(),
  comfyui_workflow_path: z.string(),
  comfyui_hook_video_workflow_path: z.string(),
  // Auto-flipped by the /api/flow/status session_expired event, auto-
  // cleared on the first successful next-task claim. Dashboard surfaces
  // the prompt so the operator knows to re-login in the Chrome profile.
  google_flow_relogin_needed: z
    .enum(["true", "false"])
    .transform((v) => v === "true"),
  // Set by the submit-result `create_project_failed` branch when the SW
  // can't talk to project.createProject — typically a trpc envelope drift.
  // Payload is JSON of {errorCode, httpStatus, taskId, when, accountId}.
  // Empty string means "no failure pending"; the dashboard banner reads
  // this verbatim and a Dismiss endpoint clears it.
  flow_create_project_failed: z.string(),
  // Set by the submit-result `service_overload` branch when Veo reports
  // backend congestion (PUBLIC_ERROR_HIGH_TRAFFIC). Stored as a Unix-
  // seconds string; empty = no event pending. The dashboard banner
  // parses defensively and self-clears when the timestamp elapses, so
  // stale values are harmless. No dismiss endpoint.
  flow_service_overload_until: z.string(),
  // Per-account pause length for `service_overload` events. Minutes-
  // scale because backend congestion typically clears in minutes, unlike
  // quota's hour-scale windows. Upper bound of 60 is deliberate: a
  // cooldown >60 min crosses into `handleQuota` territory and should be
  // tuned there instead.
  google_flow_service_overload_cooldown_minutes: z.coerce
    .number()
    .int()
    .min(1)
    .max(60),
  google_flow_account_cooldown_hours: z.coerce.number().int().min(1).max(24),
  google_flow_max_retries: z.coerce.number().int().min(0).max(10),
  google_flow_image_model: z.enum(ENUM_VALUES.google_flow_image_model),
  google_flow_video_model: z.enum(ENUM_VALUES.google_flow_video_model),
  google_flow_aspect_ratio: z.enum(ENUM_VALUES.google_flow_aspect_ratio),
  google_flow_image_aspect_ratio: z.enum(ENUM_VALUES.google_flow_image_aspect_ratio),
  // Per-clip duration for the Google Flow hook video provider, encoded
  // into the dispatched Veo `videoModelKey` at claim time. Stored as the
  // string form so the Zod schema can be a flat `z.enum(...)`; consumers
  // coerce via `Number(...)` where they need the numeric value.
  google_flow_hook_clip_seconds: z.enum(
    ENUM_VALUES.google_flow_hook_clip_seconds
  ),
  // Per-dispatch age cap consumed by the flow reaper (lib/flow-watcher).
  // Lower bound of 5 min keeps a transient-slow job from thrashing; 240
  // min upper bound lets operators widen it for very long jobs without
  // unbounded stuck-row risk.
  google_flow_dispatch_timeout_minutes: z
    .coerce.number()
    .int()
    .min(5)
    .max(240),
  aspect_ratio: z.enum(ENUM_VALUES.aspect_ratio),
  long_edge_px: z.coerce.number().int().positive(),
  framerate: z.enum(ENUM_VALUES.framerate).transform(Number),
  video_encoder: z.enum(ENUM_VALUES.video_encoder),
  // Provider's nominal hook clip length. Fractional allowed because
  // ComfyUI workflows can produce non-integer clip durations. The 60 s
  // ceiling is a sanity rail — a single hook clip longer than a minute
  // is non-sensical for the editorial 2-minute hook block. Phase 1
  // narrowed the meaning to ComfyUI-only; the Google Flow path reads
  // `google_flow_hook_clip_seconds` instead (Phase 2).
  hook_video_clip_seconds: z.coerce.number().min(1).max(60),
  // Total hook section length in seconds. The internal hook chunk count
  // is derived from this and the provider's per-clip seconds via
  // getDerivedHookChunkCount. Lower bound 4 = one shortest Flow clip
  // (4 s); upper bound 400 mirrors the prior `50 × 8 s` ceiling.
  hook_length_seconds: z.coerce.number().int().min(4).max(400),
  // Total chapter narration length in minutes. The internal chapter count
  // is derived from this via getDerivedChapterCount (6 min/chapter). Lower
  // bound 6 = 1 chapter; upper bound 600 = 10 hours. The Script tab's
  // spinner steps in 6-minute increments to align with the cadence; the
  // schema doesn't enforce divisibility — unaligned values are rounded.
  script_length_minutes: z.coerce.number().int().min(6).max(600),
  voice_id: z.string(),
  voiceover_model_id: z.enum(ENUM_VALUES.voiceover_model_id),
  voice_stability: z.coerce.number().min(0).max(1),
  voice_similarity: z.coerce.number().min(0).max(1),
  voice_style: z.coerce.number().min(0).max(1),
  voice_speed: z.coerce.number().min(0.7).max(1.2),
  voice_use_speaker_boost: z
    .enum(["true", "false"])
    .transform((v) => v === "true"),
  queue_state: z.enum(["running", "paused"]),
  // Content-policy moderation loop inside runGoogleFlowStep. When enabled,
  // failed-content-policy queue rows get rewritten by an LLM up to
  // max_rounds times before the step throws. model="" falls back to the
  // workflow-pinned provider's visual model; non-empty overrides it.
  google_flow_content_moderation_enabled: z
    .enum(["true", "false"])
    .transform((v) => v === "true"),
  google_flow_content_moderation_max_rounds: z.coerce
    .number()
    .int()
    .min(0)
    .max(10),
  google_flow_content_moderation_model: z.string(),
  // Chatterbox runs locally over HTTP — no API key. Base URL points at the
  // devnen/Chatterbox-TTS-Server wrapper (default port 8004). voice_mode
  // selects the wrapper's predefined-voice vs clone-reference path on
  // /tts; voice_filename names the file inside voices/ or
  // reference_audio/ respectively.
  chatterbox_base_url: z.string(),
  // Parallelism-capable Chatterbox sidecar (rsxdalv/chatterbox@fast)
  // — separate URL so devnen and the fast sidecar can coexist on
  // different ports. The voice settings below are reused unchanged
  // because the fast sidecar mirrors devnen's voices/ + reference_audio/
  // folder layout.
  chatterbox_fast_base_url: z.string(),
  chatterbox_voice_mode: z.enum(ENUM_VALUES.chatterbox_voice_mode),
  chatterbox_voice_filename: z.string(),
  // Chatterbox tuning. Ranges narrowed from the devnen wrapper's full
  // API bounds to the operator-useful subset (extreme values produce
  // unusable narration). HistForge sends these explicitly so what's
  // saved here is what runs, regardless of any edits made to the
  // wrapper's web UI sliders.
  chatterbox_temperature: z.coerce.number().min(0).max(1.5),
  chatterbox_exaggeration: z.coerce.number().min(0).max(2),
  chatterbox_cfg_weight: z.coerce.number().min(0).max(2),
  // Chatterbox-only playback rate. Sent as `speed_factor` on /tts.
  // Wider than `voice_speed` (the AI33/GenAIPro slider) because the
  // wrapper accepts 0.25–4 — the operator-useful subset of the
  // wrapper's full range.
  chatterbox_speed_factor: z.coerce.number().min(0.25).max(4),
  // Fast-path-only parallelism + chunking knobs. All three are passed
  // per-request to /tts/batch — no sidecar restart needed when the
  // operator tunes them. workers' upper bound (4) is owned here: the
  // sidecar accepts any positive int and grows its model pool to
  // match, so widening this cap won't require a sidecar redeploy.
  chatterbox_fast_max_chunk_chars: z.coerce.number().int().min(100).max(2000),
  chatterbox_fast_silence_ms: z.coerce.number().int().min(0).max(1000),
  chatterbox_fast_workers: z.coerce.number().int().min(1).max(4),
  // Visual-prompt generation tuning (step 09). The three knobs live
  // together because operators reason about visual-prompt throughput as
  // one decision: batch size × per-provider concurrency. K=1 is the
  // documented escape hatch — keep min(1) intentional. The wider
  // OpenRouter cap (1–32) reflects HTTP-bound parallelism; Claude CLI is
  // process-spawn-bound and stays tighter.
  visual_prompts_batch_size: z.coerce.number().int().min(1).max(16),
  claude_cli_visual_prompts_concurrency: z.coerce.number().int().min(1).max(8),
  openrouter_visual_prompts_concurrency: z.coerce.number().int().min(1).max(32),
  // Per-chunk target duration for chunk_images_only. Min 2s keeps the
  // chunker from emitting sub-sentence chunks; max 60s caps it at one
  // image per minute (the slowest pacing that still makes visual sense).
  image_chunk_target_seconds: z.coerce.number().int().min(2).max(60),
  // Hard floor for chunk_images_only. Lower bound 2s mirrors target's
  // floor (sub-sentence chunks make no sense); upper bound 20s — beyond
  // that the floor is fighting with target/max and the operator should
  // be raising target instead. z.coerce on numerics is non-negotiable —
  // the storage form is TEXT, so without coerce getSetting() returns the
  // raw string and the resolver silently emits string targets.
  image_chunk_min_seconds: z.coerce.number().int().min(2).max(20),
  // Soft ceiling for chunk_images_only. Lower bound 4 = min's floor + 2;
  // upper bound 60s matches target's. Single oversized sentences will
  // still exceed max with a logged warning — VO has no smaller atom than
  // a sentence.
  image_chunk_max_seconds: z.coerce.number().int().min(4).max(60),
  // Few-shot exemplar block for step 09's prompt template. Stored as a
  // JSON-encoded string; the consumer (step 09) is responsible for
  // parsing and gracefully degrading to an empty block on invalid JSON.
  // Validating-at-write would block partial saves while an operator is
  // iterating on the JSON, which is the common workflow for tuning the
  // examples.
  step_09_examples_json: z.string(),
  // Plan 2 Phase 2.1 Task 2: Magnific (music-video kind) settings. The
  // token is a per-instance secret (the magnific-ext extension's only
  // auth credential, used to validate the URL [token] segment on every
  // /api/magnific/* call). The two model fields are free-text in v1 so
  // operators can adopt new Magnific model slugs without a code update;
  // the next-task route projects them per-row based on mode. Dispatch
  // timeout reuses the Flow reaper's per-dispatch-age semantics; ranges
  // mirror google_flow_dispatch_timeout_minutes.
  magnific_token: z.string(),
  magnific_image_model: z.string(),
  magnific_video_model: z.string(),
  magnific_dispatch_timeout_minutes: z.coerce.number().int().min(5).max(240),
  // Auto-flipped by /api/magnific/status on session_expired events. Same
  // string-stored boolean coercion as google_flow_relogin_needed.
  magnific_relogin_needed: z
    .enum(["true", "false"])
    .transform((v) => v === "true"),
  // Loop seam mitigation tunables for runRenderMusicVideo. Fractional
  // seconds — mirror the hook_video_clip_seconds shape (z.coerce.number,
  // no .int()). Defaults match the constants the step used before these
  // were promoted to settings; bounds give operators room to dial each
  // knob without letting bad values brick a render. xfade=0 collapses
  // pass 2 to a -stream_loop mux (see render-music-video.ts).
  music_video_loop_trim_tail_seconds: z.coerce.number().min(0).max(5),
  music_video_loop_xfade_seconds: z.coerce.number().min(0).max(2),
  // Character-lock + style-lock plan. Both are free-text textareas
  // operators can edit in /settings/visual-style; both are
  // concatenated onto every assembled visual prompt in step 09 (see
  // post-processing in src/worker/steps/09-generate-visual-prompts.ts).
  // Empty string = "skip this segment". Provider-agnostic — affects
  // ComfyUI and Google Flow image paths alike.
  style_lock_description: z.string(),
  character_lock_negative: z.string(),
  // Magnific runtime — HistForge-managed Playwright Chromium that boots
  // the magnific-ext extension in a persistent context. `enabled` is the
  // master toggle (auto-boots the runtime on worker start, except in dev
  // — see src/worker/index.ts boot guard). `user_data_dir` is where
  // Playwright persists cookies/localStorage/IndexedDB across HistForge
  // restarts. `window_visible` flips the off-screen window into view for
  // debugging. `extension_path` points at magnific-ext on disk and is
  // configurable so a developer can point the runtime at a local checkout
  // of the extension.
  magnific_runtime_enabled: z
    .enum(["true", "false"])
    .transform((v) => v === "true"),
  magnific_runtime_user_data_dir: z.string(),
  magnific_runtime_window_visible: z
    .enum(["true", "false"])
    .transform((v) => v === "true"),
  magnific_runtime_extension_path: z.string(),
  // Operator-gated cleanup: when false (default), step 15 returns early
  // and preserves intermediates on disk. Same string-stored boolean
  // coercion as magnific_runtime_enabled — a corrupted non-"true"/"false"
  // value must surface as a parse error rather than silently coerce to
  // false (re-arming the destructive wipe).
  auto_cleanup_after_render: z
    .enum(["true", "false"])
    .transform((v) => v === "true"),
  // Origin the magnific runtime uses to derive the four extension
  // webhook URLs (next-task / submit-result / status / queue-summary)
  // when configuring the magnific-ext SW at start. Default matches the
  // dev server origin; ops override the row in prod. Free-text string so
  // any scheme://host:port shape Magnific can reach is accepted.
  histforge_base_url: z.string(),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type SettingValue<K extends SettingKey> = z.infer<
  (typeof SETTING_SCHEMAS)[K]
>;

function assertKnownKey(key: string): asserts key is SettingKey {
  if (!Object.prototype.hasOwnProperty.call(SETTING_SCHEMAS, key)) {
    throw new Error(`Unknown setting key: ${key}`);
  }
}

export function getSetting<K extends SettingKey>(
  key: K,
  db: DatabaseType = getDb()
): SettingValue<K> {
  assertKnownKey(key);
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  if (!row) {
    throw new Error(`Setting not seeded: ${key}`);
  }
  return SETTING_SCHEMAS[key].parse(row.value) as SettingValue<K>;
}

export type AllSettings = { [K in SettingKey]: SettingValue<K> };

export function getAllSettings(
  db: DatabaseType = getDb()
): AllSettings {
  const rows = db
    .prepare("SELECT key, value FROM settings")
    .all() as Array<{ key: string; value: string }>;
  const stored = new Map(rows.map((r) => [r.key, r.value]));

  const result = {} as AllSettings;
  for (const key of Object.keys(SETTING_SCHEMAS) as SettingKey[]) {
    const raw = stored.get(key);
    if (raw === undefined) {
      throw new Error(`Setting not seeded: ${key}`);
    }
    (result as Record<string, unknown>)[key] =
      SETTING_SCHEMAS[key].parse(raw);
  }
  return result;
}

/**
 * Derives the internal chapter count from the operator-facing
 * `script_length_minutes` setting at the canonical 6 minutes per chapter.
 * Steps 01/04/05 use this in place of the removed `chapter_count` setting.
 * The Zod `min(6)` bound guarantees the result is always ≥ 1, so no
 * explicit clamp is needed.
 */
export function getDerivedChapterCount(
  db: DatabaseType = getDb()
): number {
  return Math.round(getSetting("script_length_minutes", db) / 6);
}

/**
 * Provider-resolved per-clip duration for the hook section. Paired with
 * `getDerivedHookChunkCount` so the chunker's loop bound and per-chunk
 * target both flip atomically across the provider branch.
 *
 * - `video_provider === "google_flow"` reads the
 *   `google_flow_hook_clip_seconds` enum (storage form `"4"`/`"6"`/`"8"`)
 *   and coerces it via `Number(...)`. The dispatch route keeps the
 *   storage string verbatim as a lookup key into `VEO_MODEL_BY_SECONDS`,
 *   so the coercion is local to this helper.
 * - All other provider values (including `null` and `"comfyui"`) read
 *   `hook_video_clip_seconds` — the ComfyUI-only float.
 */
export function getHookClipSeconds(
  snapshot: WorkflowSnapshot,
  db: DatabaseType = getDb()
): number {
  if (snapshot.video_provider === "google_flow") {
    return Number(getSetting("google_flow_hook_clip_seconds", db));
  }
  return getSetting("hook_video_clip_seconds", db);
}

/**
 * Derives the hook chunk count from the operator-facing
 * `hook_length_seconds` and the provider-resolved per-clip seconds.
 * Step 08 (chunk) uses this in place of the removed `hook_chunk_count`
 * setting. Implemented in terms of `getHookClipSeconds` so the count
 * and per-chunk target cannot drift across the Phase-2 provider branch.
 * The Zod `min(4)` bound on `hook_length_seconds` plus `min(1)` on
 * `hook_video_clip_seconds` (and `"4"` on the Phase-2 enum) together
 * guarantee the result is ≥ 1, so no explicit clamp is needed.
 */
export function getDerivedHookChunkCount(
  snapshot: WorkflowSnapshot,
  db: DatabaseType = getDb()
): number {
  return Math.round(
    getSetting("hook_length_seconds", db) / getHookClipSeconds(snapshot, db)
  );
}

export function setSetting<K extends SettingKey>(
  key: K,
  value: SettingValue<K>,
  db: DatabaseType = getDb()
): void {
  assertKnownKey(key);
  // Settings are stored as TEXT; schemas parse the string form, so we
  // stringify first and validate that — which also catches out-of-range
  // numbers (since z.coerce.number() converts before range checks).
  const stringValue = String(value);
  SETTING_SCHEMAS[key].parse(stringValue);
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, stringValue);
}

/**
 * Resolved per-video image chunk pacing triple. The chunker
 * (`08-chunk-images-only.ts`) reads this exactly once at step entry.
 */
export interface ImageChunkPacing {
  target: number;
  min: number;
  max: number;
}

/**
 * Thrown by `getImageChunkPacing` when the resolved triple violates
 * `min ≤ target ≤ max`. Constructor message includes every component so
 * the operator can see which knob — per-video column override or global
 * setting — needs adjustment.
 */
export class ImageChunkPacingInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageChunkPacingInvariantError";
  }
}

/**
 * Resolves per-video image chunk pacing. Each of (target, min, max)
 * reads the matching video-row override column first; NULL falls through
 * to the global setting of the same name. The resolved triple is
 * validated against `min ≤ target ≤ max` — chunker entry must fail loudly
 * rather than emit garbage chunks if the operator's column override
 * conflicts with the surrounding globals.
 *
 * The video parameter is intentionally a `Pick` of the three columns so
 * callers can pass any object shape that carries them (the full `Video`
 * row, a partial DTO, or a hand-built fixture).
 */
export function getImageChunkPacing(
  video: {
    image_chunk_target_seconds: number | null;
    image_chunk_min_seconds: number | null;
    image_chunk_max_seconds: number | null;
  },
  db: DatabaseType = getDb()
): ImageChunkPacing {
  const target =
    video.image_chunk_target_seconds ??
    getSetting("image_chunk_target_seconds", db);
  const min =
    video.image_chunk_min_seconds ??
    getSetting("image_chunk_min_seconds", db);
  const max =
    video.image_chunk_max_seconds ??
    getSetting("image_chunk_max_seconds", db);
  if (!(min <= target && target <= max)) {
    throw new ImageChunkPacingInvariantError(
      `Resolved image chunk pacing violates min ≤ target ≤ max: min=${min}, target=${target}, max=${max}. ` +
        `Check the per-video override columns (image_chunk_target_seconds, image_chunk_min_seconds, image_chunk_max_seconds) and the matching global settings.`
    );
  }
  return { target, min, max };
}

