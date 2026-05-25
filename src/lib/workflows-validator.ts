import type { WorkflowSnapshot } from "@/types";
import { materializeStepList } from "@/lib/workflows";
import { REAL_STEPS } from "@/worker/steps";

/**
 * Input-availability validator for the workflow editor (Phase 3). Walks
 * a snapshot in materialized order and flags steps whose declared
 * `inputs` are not produced by any prior step. Warnings are advisory —
 * saves are never blocked.
 *
 * Lives at the lib boundary because both API routes and the editor's
 * fetch-driven validate flow consume it. README Invariant D pins the
 * `ValidationWarning` shape; consumers (Phase 6 drafts UI) depend on it.
 */

/**
 * Match a `produces` entry against an `inputs` entry. Returns true iff a
 * downstream consumer reading `required` would be satisfied by an
 * upstream producer declaring `provided`.
 *
 * Supported pattern subset: `*` within a path segment (compiles to
 * `[^/]*`). No `**`, no character classes, no braces — Phase 3 step
 * files only use single-segment `*`. The regex is anchored with `^`/`$`
 * so a literal does not match a longer string with the same suffix.
 *
 * Implementation note: we compile `provided` into a regex and test it
 * against `required`. This single operation covers all three cases —
 * literal==literal, glob-provided vs literal-required, literal-provided
 * vs glob-required (because `*` literally matches itself through the
 * `[^/]*` regex class).
 */
export function globMatches(provided: string, required: string): boolean {
  if (provided.includes("**") || required.includes("**")) {
    throw new Error(
      `Unsupported glob pattern '**' in input-availability check: provided='${provided}', required='${required}'`
    );
  }
  const escaped = provided.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const pattern = "^" + escaped.replace(/\*/g, "[^/]*") + "$";
  return new RegExp(pattern).test(required);
}

export type ValidationWarning = {
  step_name: string;
  missing_input: string;
  message: string;
};

export type ValidationResult = {
  ok: boolean;
  warnings: ValidationWarning[];
};

/**
 * Walk the materialized step list, accumulate `produces` patterns into
 * an "available" set, and warn whenever a step's `inputs` entry is not
 * satisfied by any prior step's producers.
 *
 * Critical invariant: `produces` accumulate even when the step's own
 * inputs warned. The walk does not abort — we want all consumers to
 * surface, not just the first. This is what bounds the empty-`steps`
 * test to two warnings on `assemble_script` rather than cascading down
 * the rest of the pipeline.
 *
 * DB-derived inputs (e.g., `videos.title`) are never in `step.inputs`
 * by convention, so they're implicitly satisfied.
 */
export function validateInputAvailability(
  snapshot: WorkflowSnapshot
): ValidationResult {
  const slugs = materializeStepList(snapshot);
  const stepsByName = new Map(REAL_STEPS.map((s) => [s.name, s]));

  const warnings: ValidationWarning[] = [];
  const available: string[] = [];

  for (const slug of slugs) {
    const step = stepsByName.get(slug);
    if (!step) continue; // bootValidate is the source of truth for this; skip silently here.

    const inputs = step.inputs ?? [];
    for (const required of inputs) {
      const satisfied = available.some((provided) =>
        globMatches(provided, required)
      );
      if (!satisfied) {
        const label = step.label ?? step.name;
        warnings.push({
          step_name: step.name,
          missing_input: required,
          message: `${label} needs '${required}' but no prior step produces it`,
        });
      }
    }

    const produces = step.produces ?? step.outputs;
    for (const p of produces) available.push(p);
  }

  return { ok: warnings.length === 0, warnings };
}

/**
 * Kind-aware workflow consistency check. Per ADR-0011 §Consequences this
 * is the single entry point boot + editor surfaces call; branching on
 * `snapshot.kind` lives only here. Narrative snapshots delegate to the
 * existing chunker rule; music_video snapshots assert the seeded provider
 * triple (image=magnific, video=magnific, music=suno) and that the
 * narrative-only fields (`script_llm_provider`, `tts_provider`,
 * `chunker_step`) are all null.
 *
 * Violations are advisory (warnings, not errors) at the API boundary;
 * `bootValidate` upgrades the same warnings to fail-fast so a
 * misconfigured row can't reach the runner.
 */
export function validateWorkflowConsistency(
  snapshot: WorkflowSnapshot
): ValidationResult {
  if (snapshot.kind === "music_video") {
    return validateMusicVideoConsistency(snapshot);
  }
  return validateChunkerStepConsistency(snapshot);
}

/**
 * Music-video provider/glue invariants. The v1 music-video workflow has
 * exactly one valid provider triple — Magnific images, Magnific clips,
 * Suno music — and the narrative-only fields must be null. Each violation
 * is reported as its own warning so the editor can highlight every offending
 * field at once.
 *
 * `step_name: 'music_video'` tags warnings consistently for UI grouping;
 * `missing_input` carries the offending column name.
 */
function validateMusicVideoConsistency(
  snapshot: WorkflowSnapshot
): ValidationResult {
  const warnings: ValidationWarning[] = [];
  const requireValue = (
    column:
      | "image_provider"
      | "video_provider"
      | "music_provider",
    expected: string,
    actual: string | null
  ): void => {
    if (actual !== expected) {
      warnings.push({
        step_name: "music_video",
        missing_input: column,
        message: `music_video workflows require ${column} = '${expected}' (got ${
          actual === null ? "null" : `'${actual}'`
        }).`,
      });
    }
  };
  const requireNull = (
    column: "script_llm_provider" | "tts_provider" | "chunker_step",
    actual: string | null
  ): void => {
    if (actual !== null) {
      warnings.push({
        step_name: "music_video",
        missing_input: column,
        message: `music_video workflows require ${column} to be null (none) — got '${actual}'.`,
      });
    }
  };

  requireValue("image_provider", "magnific", snapshot.image_provider);
  requireValue("video_provider", "magnific", snapshot.video_provider);
  requireValue("music_provider", "suno", snapshot.music_provider);
  requireNull("script_llm_provider", snapshot.script_llm_provider);
  requireNull("tts_provider", snapshot.tts_provider);
  requireNull("chunker_step", snapshot.chunker_step);

  return { ok: warnings.length === 0, warnings };
}

/**
 * Structural rule (ADR 0006 §5) coupling `chunker_step` to the provider
 * columns. Each chunker variant emits chunks of exactly one or both asset
 * types; the matching provider must be set, the irrelevant one must not.
 *
 *   chunk_clips_then_images → image_provider !== null && video_provider !== null
 *   chunk_images_only       → image_provider !== null && video_provider === null
 *   chunk_clips_only        → image_provider === null && video_provider !== null
 *
 * Narrative-only — `validateWorkflowConsistency` is the kind-aware entry
 * point that routes music_video snapshots elsewhere.
 */
export function validateChunkerStepConsistency(
  snapshot: WorkflowSnapshot
): ValidationResult {
  const { chunker_step, image_provider, video_provider } = snapshot;

  // chunker_step is nullable on music_video snapshots (Plan 1 Phase 1.1
  // Task 2). The narrative-only validator returns clean for null — Phase
  // 1.2 Task 3 introduces a kind-aware entry point that won't call this
  // helper for music_video.
  if (chunker_step === null) {
    return { ok: true, warnings: [] };
  }

  const warnings: ValidationWarning[] = [];
  const need = (column: "image_provider" | "video_provider"): void => {
    warnings.push({
      step_name: chunker_step,
      missing_input: column,
      message: `${chunker_step} requires ${column} to be set.`,
    });
  };
  const forbid = (column: "image_provider" | "video_provider"): void => {
    warnings.push({
      step_name: chunker_step,
      missing_input: column,
      message: `${chunker_step} requires ${column} to be null (none) — this chunker emits no chunks of that asset type.`,
    });
  };

  switch (chunker_step) {
    case "chunk_clips_then_images":
      if (image_provider === null) need("image_provider");
      if (video_provider === null) need("video_provider");
      break;
    case "chunk_images_only":
      if (image_provider === null) need("image_provider");
      if (video_provider !== null) forbid("video_provider");
      break;
    case "chunk_clips_only":
      if (video_provider === null) need("video_provider");
      if (image_provider !== null) forbid("image_provider");
      break;
    default:
      // Unknown chunker_step — bootValidate's REAL_STEPS check is the
      // source of truth for slug membership; silently pass here.
      break;
  }

  return { ok: warnings.length === 0, warnings };
}
