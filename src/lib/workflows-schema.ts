import { z } from "zod";
import { REAL_STEPS } from "@/worker/steps";
import { LLM_PROVIDER_NAMES, type LlmProviderName } from "@/lib/llm/names";
import {
  IMAGE_PROVIDER_NAMES,
  type ImageProviderName,
} from "@/lib/image/names";

/**
 * Per-row Zod schemas for the `workflows` table. These validate the
 * columns on individual workflow rows — they are NOT global setting
 * keys (those live in `src/lib/settings.ts`).
 *
 * The `steps[].step_name` enum is derived at module load from the
 * subset of `REAL_STEPS` whose `module === "script"`. Phase 2's editor
 * only lets the user reorder/add/remove the script-module steps; glue
 * (assemble, align, chunk, render, cleanup) and TTS/image/video
 * provider steps are inserted at materialization time from the four
 * provider columns. Adding a new script step is enough to make it
 * pickable here — no schema edit needed.
 *
 * `WorkflowRowSchema` is a kind-discriminated union over `narrative` and
 * `music_video`. The narrative branch derives its `image_provider` enum
 * from `IMAGE_PROVIDER_NAMES` (`lib/image/names.ts`), which now includes
 * `magnific` because the Magnific image provider is registered. The
 * music_video branch hard-codes the v1 provider triple (image=magnific,
 * video=magnific, music=suno) with `z.literal`. Narrative `video_provider`
 * stays `comfyui | google_flow` — magnific-as-video is music-video-only —
 * and `suno` has no runtime provider registry, so both remain literals on
 * the music_video branch alone.
 *
 * Backward compat: payloads omitting `kind` default to `narrative` via the
 * outer `z.preprocess`, so pre-Phase-1.2 AI-skill drafts round-trip cleanly.
 */
const SCRIPT_STEP_NAMES = REAL_STEPS.filter((s) => s.module === "script").map(
  (s) => s.name
);

const SharedRowFields = {
  id: z.string().regex(/^[a-z0-9-]+$/, "kebab-case slug"),
  label: z.string().min(1).max(120),
  short_label: z.string().min(1).max(40),
  description: z.string().max(500).nullable().optional(),
  enabled: z.coerce.boolean().optional(),
};

export const NarrativeRowSchema = z.object({
  ...SharedRowFields,
  kind: z.literal("narrative"),
  script_llm_provider: z.enum(
    LLM_PROVIDER_NAMES as unknown as [LlmProviderName, ...LlmProviderName[]]
  ),
  tts_provider: z
    .enum(["ai33", "genaipro", "chatterbox", "chatterbox-fast"])
    .nullable(),
  image_provider: z
    .enum(
      IMAGE_PROVIDER_NAMES as unknown as [
        ImageProviderName,
        ...ImageProviderName[],
      ]
    )
    .nullable(),
  video_provider: z.enum(["comfyui", "google_flow"]).nullable(),
  // Narrative rows always carry null for the music-video-only columns;
  // accepting absent or null keeps round-trip parity with legacy export
  // payloads that pre-dated these columns.
  music_provider: z.null().optional(),
  upscaler_provider: z.null().optional(),
  chunker_step: z
    .enum([
      "chunk_clips_then_images",
      "chunk_images_only",
      "chunk_clips_only",
    ])
    .default("chunk_clips_then_images"),
  steps: z
    .array(
      z.object({
        step_name: z.enum(SCRIPT_STEP_NAMES as [string, ...string[]]),
      })
    )
    .min(0),
});

const MusicVideoRowSchema = z.object({
  ...SharedRowFields,
  kind: z.literal("music_video"),
  // ADR-0011 §Decision 3: narrative-only fields must be null on
  // music_video rows. v1's only valid provider triple is Magnific × Suno.
  script_llm_provider: z.null(),
  tts_provider: z.null(),
  image_provider: z.literal("magnific"),
  video_provider: z.literal("magnific"),
  music_provider: z.literal("suno"),
  upscaler_provider: z.null().optional(),
  chunker_step: z.null(),
  steps: z
    .array(
      z.object({
        step_name: z.enum(SCRIPT_STEP_NAMES as [string, ...string[]]),
      })
    )
    .max(0),
});

const RowDiscriminatedUnion = z.discriminatedUnion("kind", [
  NarrativeRowSchema,
  MusicVideoRowSchema,
]);

/**
 * Wrap the discriminated union in a `z.preprocess` that defaults missing
 * `kind` to `narrative`. `z.discriminatedUnion` itself cannot carry a
 * default on the discriminator (Zod throws on construction), so the
 * preprocess is the only way to honor pre-Phase-1.2 payloads that omit
 * the field — the canonical case for legacy AI-skill drafts.
 */
export const WorkflowRowSchema = z.preprocess((input) => {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    if (!("kind" in obj) || obj.kind === undefined) {
      return { ...obj, kind: "narrative" };
    }
  }
  return input;
}, RowDiscriminatedUnion);

/**
 * PATCH body shape. `id` is intentionally omitted — the slug is the URL
 * primary key and must never be writable. `kind` is also omitted — ADR-0011
 * §Decision 1 pins it at creation. `expected_version` is required for
 * optimistic-concurrency; the route handler returns 409 on mismatch.
 *
 * Plan 1 Phase 1.2 Task 4: the editor PATCH surface is narrative-only
 * (Phase 1.4 Task 8 introduces a music-video PATCH gate); this schema
 * therefore derives from the narrative branch.
 *
 * Zod's default `.strip()` mode drops unknown keys silently, so a body
 * carrying `id` (or `is_builtin`, `version`, etc.) is parsed without
 * those fields ever reaching the handler.
 */
export const WorkflowPatchSchema = NarrativeRowSchema.omit({
  id: true,
  kind: true,
})
  .partial()
  .extend({ expected_version: z.coerce.number().int().min(1) });

/**
 * Import body shape. Identical to `WorkflowRowSchema` — the import
 * endpoint reuses the canonical row shape. `is_builtin` is intentionally
 * absent: a sneaky `is_builtin: 1` in an imported JSON is silently
 * stripped by Zod, and the import endpoint hardcodes the flag (0 for new
 * rows, preserved for overwrites).
 */
export const WorkflowImportSchema = WorkflowRowSchema;
