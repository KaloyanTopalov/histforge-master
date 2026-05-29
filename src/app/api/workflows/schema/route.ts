import { NextResponse } from "next/server";
import { REAL_STEPS } from "@/worker/steps";
import { llmProviders } from "@/lib/llm";
import { ttsProviders } from "@/lib/tts";
import { imageProviders } from "@/lib/image";
import { videoProviders } from "@/lib/video";

/**
 * Live workflow catalog consumed by the editor and Phase 6's AI skill.
 * Stable shape per README Invariant D — `for_each` is always present
 * (`null` when the step file omits it), `produces` is resolved here
 * (defaulting to `outputs`) so consumers do not re-derive the default.
 * All four `providers.*` arrays come from `Object.keys(<registry>)`
 * (Invariant D) — adding a provider to a registry surfaces it here.
 *
 * Read-only and stateless: no DB access, no settings lookups.
 */
export async function GET() {
  const steps = REAL_STEPS.map((s) => ({
    name: s.name,
    module: s.module,
    label: s.label,
    description: s.description,
    inputs: s.inputs ?? [],
    produces: s.produces ?? s.outputs,
    for_each: s.for_each ?? null,
  }));

  return NextResponse.json({
    // Must enumerate every value seen on `steps[].module`; the music_video
    // tag was added in Plan 1 Phase 1.3 alongside the six music-video
    // stubs, and omitting it here would leave the catalog internally
    // inconsistent (steps reference a module the modules list disclaims).
    modules: ["script", "tts", "image", "video", "glue", "music_video"],
    steps,
    providers: {
      script: Object.keys(llmProviders),
      tts: Object.keys(ttsProviders),
      image: Object.keys(imageProviders),
      video: Object.keys(videoProviders),
    },
    // Surface the kind discriminator so the AI-skill drafts importer can
    // author music_video drafts too. `providers.*` are registry-derived
    // (the `Object.keys` calls above), so `magnific` now appears in both
    // `image` and `video` — the Magnific providers are registered. There is
    // no music-provider registry, so `suno` (the music_video music slot) is
    // not enumerated here; it lives only in `WorkflowImportSchema`'s
    // discriminated union.
    kinds: ["narrative", "music_video"],
  });
}
