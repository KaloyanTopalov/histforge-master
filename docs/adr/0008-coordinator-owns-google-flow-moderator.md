---
status: accepted
date: 2026-05-17
---

# Coordinator owns the Google Flow content-policy moderator; provider opts stay LLM-free

## Context

`ImageProvider.generateBatch`'s opts surface declares a non-optional `chat: (messages, opts?) => Promise<string>` callback ([`src/lib/image/types.ts:11`](../../src/lib/image/types.ts)). The video side mirrors it ([`src/lib/video/types.ts:11`](../../src/lib/video/types.ts)). The interface advertises a dependency that exists for one implementation's benefit: only `googleFlowImageProvider` and `googleFlowVideoProvider` consume `opts.chat` — both forward it verbatim into `GoogleFlowStepDeps.chat`, which `runGoogleFlowStep` hands to `maybeModerate`, the single consumption point in the entire image/video path ([`src/worker/steps/google-flow-common.ts:331`](../../src/worker/steps/google-flow-common.ts)). The two ComfyUI adapters declare `chat` to satisfy the type and never read it; one names the ignore in a leading docstring ([`src/lib/video/comfyui.ts:6-14`](../../src/lib/video/comfyui.ts)).

This is the depth-audit's classic "one-adapter makes a seam" failure ([`docs/refactoring/depth-audit-2026-05-12.md`](../refactoring/depth-audit-2026-05-12.md), suggestion #5). It leaks LLM coupling to every caller of any image or video provider, forces 6 test files to stub `chat` purely to satisfy the type, and creates an "optional seam at the boundary" cope inside `maybeModerate` ([`google-flow-common.ts:295-305`](../../src/worker/steps/google-flow-common.ts)) that treats missing-deps as "moderation off" — a workaround for the leak itself. Descriptive research with code references is in [docs/research/2026-05-17-image-provider-moderation-seam.md](../research/2026-05-17-image-provider-moderation-seam.md).

## Decision

Move the moderation seam from the *provider's* opts to the *coordinator's* deps; build the moderator and the per-run Google Flow providers in `runPipeline` after `controller = new AbortController()`. Specifically:

1. **`ImageProviderGenerateBatchOpts` and `VideoProviderGenerateBatchOpts` drop `chat` and `promptsDir`.** Provider interfaces stop mentioning LLMs entirely. The remaining opts are the cross-cutting transport fields a provider actually consumes: `db?, log?, videoId, projectsDir, pollIntervalMs?, nowSec?, nowMs?, signal?`.

2. **New `PromptModerator` interface in [`src/lib/moderator.ts`](../../src/lib/moderator.ts).** `interface PromptModerator { moderate(items: ModerationItem[], round: number): Promise<Map<string, string>> }` plus `createPromptModerator({ chat, promptsDir?, db? })` factory. The existing free function `moderateBatch` becomes the body of `moderate` (no longer exported). The narrower `chat` opt-type (`{ db?, model? }`) stays — the moderator does not see signal directly; signal is folded transitively via the injected chat.

3. **`GoogleFlowStepDeps.moderator: PromptModerator` is required.** Replaces `chat?` + `promptsDir?`. `maybeModerate`'s gate collapses to the enabled-setting check alone — the missing-deps "moderation off" cope at lines 295-305 is deleted. The `moderateBatch(items, round, { db, promptsDir, chat })` call becomes `deps.moderator.moderate(items, round)`.

4. **`getImageProvider` / `getVideoProvider` become dep-aware.** Signature: `getImageProvider(name: string, deps: { moderator: PromptModerator }): ImageProvider`. Routes `"google_flow"` through `makeGoogleFlowImageProvider(deps.moderator)`; stateless providers (`comfyui`) stay singletons in the existing `imageProviders` registry. Mirrored for video.

5. **Per-run construction moves from `resolveDeps` to `runPipeline`.** `resolveDeps` shrinks: returns un-signal-folded `chat`/`visualPromptChat` + the snapshot + `ttsProvider` (unchanged). No longer constructs `imageProvider`/`videoProvider`. `runPipeline` adds a per-run setup block after `controller = new AbortController()`: folds `controller.signal` into both chat wrappers, builds `moderator = createPromptModerator({ chat: signalFoldedVisualChat, promptsDir, db })`, then `imageProvider = getImageProvider(snapshot.image_provider, { moderator })` and likewise for video. `buildStepContext` stops signal-folding (already folded upstream) and just surfaces the precomputed wrappers/providers + step-scoped `log`.

6. **The model-override path is preserved.** `createPromptModerator`'s body still reads `google_flow_content_moderation_model` and threads it via `opts.model` to the injected chat — the visual-model fallback at [`pipeline.ts:334-337`](../../src/worker/pipeline.ts) continues to win when the setting is empty. No setting changes, no UI changes, no behaviour change for operators.

## Considered options (rejected)

**A — Registry-level decorator** (`imageProviders.google_flow = withModeration(rawAdapter, llmRouter)`, the depth-audit's option (a)). Rejected because moderation is not a before/after hook around `generateBatch` — it's interleaved inside `runGoogleFlowStep`'s queue-poll loop (`runModerationLoop` at [`google-flow-common.ts:193-243`](../../src/worker/steps/google-flow-common.ts), alternating `waitForFlowQueue` with `maybeModerate`). A `withModeration` wrapper would either have to reimplement the queue loop inside the decorator or hollow out `runGoogleFlowStep` into an injectable, neither of which delivers the conceptual cleanliness the decorator suggests. The seam advertised wouldn't be where the work happens.

**B — Adapter holds moderator privately** (the depth-audit's option (b)). Factory `createGoogleFlowImageProvider({ moderator })` returns an `ImageProvider` whose body still forwards `moderator` into `GoogleFlowStepDeps`. Rejected because the adapter is currently a ~25-line forwarder — moving the moderator construction up one frame (from "opts" to "factory arg") doesn't close the leak, it just renames it. Both providers would still need identical wiring at the registry. The real coupling point is `runGoogleFlowStep`, not the provider.

**γ — Drop the `imageProviders` registry entirely** in favour of an explicit switch in `resolveDeps`. Rejected because the registry's "validate unknown provider name" branch is real (one place to fail loudly) and the switch would have to be duplicated for video. Keeping the registry for stateless providers and adding a one-line case-branch in `getImageProvider(name, deps)` is the minimal invasive change.

**β — Moderator accepts `signal` at call time** (`moderate(items, round, { signal? })`). Rejected because it widens the moderator's interface (signal becomes an explicit per-call arg) and diverges from the existing "fold signal once at the boundary, forget" pattern — `buildStepContext` folds `controller.signal` into chat/visualPromptChat once so that no consumer downstream needs to thread it. Decision (5) preserves that pattern; the moderator's interface stays narrow.

**Plain callable type** (`type PromptModerator = (items, round) => Promise<Map>`). Rejected because `LlmProvider`, `ImageProvider`, `VideoProvider`, and `TtsProvider` are all object-with-method shapes — a future reader scanning provider-like deps would have to remember the moderator alone is callable. Symmetry buys more than the one method name avoids.

**Keep `moderateBatch` exported alongside the factory.** Rejected because parallel APIs are a permanent maintenance tax; the migration cost (one-pattern sed across `__tests__/unit/lib/moderator.test.ts`) is paid once.

**Bundle with depth-audit #3 (LLM router).** Rejected because the two refactors are orthogonal after picking the coordinator-owns shape: #3 changes how `resolveDeps` resolves "what model for purpose X"; this ADR changes where the moderator construction lives. The interaction point — `createPromptModerator`'s chat-source — survives both refactors unchanged. Bundling inflates the diff without compositional benefit, and audit #3's design is itself unsettled.

## Consequences

- **Provider interface contract shrinks.** `ImageProvider` and `VideoProvider` `generateBatch` opts no longer mention LLMs. A future image provider (e.g., a Stability AI adapter) faces a strictly smaller surface.
- **Test surface is net-simplified.** ~6 type-stub `noChat = (): Promise<string> => Promise.resolve("")` lines disappear across the four provider test files (image+video × google_flow+comfyui). The 4 behavioral tests in `moderator.test.ts` migrate mechanically from `moderateBatch(items, round, deps)` to `createPromptModerator(deps).moderate(items, round)`. The `startWithModerator(chatStub)` helper in `google-flow-common.test.ts:108-137` migrates to take a moderator (or constructs one internally from the chat stub). Two assertions in `generate-images.test.ts:50` and `generate-clips.test.ts:48` (`opts.chat === visualPromptChat`) get deleted along with the field.
- **A small test helper appears.** `__tests__/helpers/no-op-moderator.ts` exports `noOpModerator: PromptModerator = { moderate: async () => new Map() }` for ad-hoc step tests that exercise `runGoogleFlowStep` without driving rewrites. Replaces the previous "just don't pass `chat`" escape hatch the production gate accommodated.
- **`buildStepContext` simplifies.** No longer folds signal into chat/visualPromptChat — that fold moves to the per-run setup in `runPipeline`. The doc-block at `pipeline.ts:206-207` shifts location and slightly retitles.
- **`resolveDeps` shrinks** by ~10 lines (provider construction moves out). `runPipeline` grows by ~8 lines (per-run setup block). Net: ~2 lines smaller, with a more honest division of responsibility — `resolveDeps` = snapshot + model + LLM-wrapper resolution; `runPipeline` = per-run wiring that needs the controller.
- **`pipeline.ts:286-310` doc-block updates** to reflect that the moderator's chat-source is the (signal-folded) `visualPromptChat`, and that the `opts.model` override path is now inside `createPromptModerator`.
- **CONTEXT.md is unchanged.** `PromptModerator` is implementation-level; no domain term is added. The "moderation" concept is already operator-visible via the three `google_flow_content_moderation_*` settings.
- **Out of scope:** depth-audit #3 (LLM router) — orthogonal, separately tracked. The current per-purpose model resolution (`<provider>_script_model` / `<provider>_visual_model` + `google_flow_content_moderation_model` override) stays. The moderator continues to read its own override setting; consolidation into a router-driven purpose enum is a future refactor.
- **Reversibility note.** The post-refactor seam is *deeper* than the pre-refactor seam: the provider interface drops a field, the moderator gets named, and the coordinator dep stops being optional. Restoring the `chat:` field on provider opts later — even partially, e.g. for a new image provider that needs LLM access for some other reason — would be a structural rework, not a one-line addition. The right escape valve for "a new provider needs the LLM" is a per-provider seam on that provider's *factory*, not re-adding the field to the shared interface.
