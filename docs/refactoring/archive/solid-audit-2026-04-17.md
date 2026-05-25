# SOLID Audit — 2026-04-17

**Mode**: Full audit
**Scope**: All source files referenced by the four domain skills — 15 pipeline steps, 3 worker-core modules, 14 API routes, 6 dashboard pages/islands, and the shared lib layer (LLM, TTS, image, align, render, Freepik, db, settings, prompts).
**Domains analyzed**: domain-pipeline, domain-content-gen, domain-media, domain-dashboard

## Summary

The codebase is generally healthy — the provider registries (TTS, image), file-based step handoff, and Settings Zod layer are genuinely well-designed and should be preserved. The main SOLID debt clusters in three areas: (1) every pipeline step re-implements the same dependency-resolution prelude, (2) raw SQL is scattered across ~10 dashboard routes with no repository boundary, and (3) the step registry is spread across three files that must be kept in lockstep when steps are added or reordered. None of these are actively breaking anything; all three will make the next round of pipeline work harder than it needs to be.

## Findings Overview

| ID  | Domain             | Principle | Severity | Effort | Files                                                          |
|-----|--------------------|-----------|----------|--------|----------------------------------------------------------------|
| 1   | domain-content-gen | SRP/DIP   | high     | medium | `src/worker/steps/0[1-5].ts`, `09-enrich-chunks.ts`, `06/07/08/10/11/14/15` |
| 2   | domain-dashboard   | DIP/SRP   | high     | medium | `src/app/api/**/route.ts`, `src/app/**/page.tsx`               |
| 3   | domain-pipeline    | OCP       | medium   | medium | `src/worker/pipeline.ts`, `src/worker/steps/index.ts`, step files |
| 4   | domain-pipeline    | DRY/SRP   | medium   | small  | `src/worker/runner.ts`, `src/worker/pipeline.ts`               |
| 5   | domain-dashboard   | DRY/SRP   | medium   | small  | `src/app/videos/[id]/page.tsx`, `src/app/api/videos/[id]/route.ts` |
| 6   | domain-content-gen | OCP/DIP   | medium   | medium | `src/lib/openrouter.ts`, all content steps                     |
| 7   | domain-media       | SRP       | low      | small  | `src/lib/render.ts`                                            |
| 8   | domain-media       | DRY       | low      | small  | `src/worker/steps/08-chunk.ts`                                 |
| 9   | domain-dashboard   | DRY       | low      | small  | `src/app/api/topics/[id]/route.ts`, `src/app/api/topics/[id]/queue/route.ts` |
| 10  | domain-media       | DRY       | low      | medium | `src/lib/tts/ai33.ts`, `src/lib/image/comfyui.ts`              |

## Findings Detail

### #1 — Every step re-implements the same dependency-resolution prelude
**Domain:** domain-content-gen (spreads to media/pipeline) | **Principle:** SRP/DIP | **Severity:** high | **Effort:** medium
**Files:** `src/worker/steps/01-research-outline.ts`, `02-research-characters.ts`, `03-write-hook.ts`, `04-write-chapters.ts`, `05-assemble-script.ts`, `06-voiceover.ts`, `07-align.ts`, `08-chunk.ts`, `09-enrich-chunks.ts`, `10-generate-main-images.ts`, `11-generate-hook-images.ts`, `12-freepik-hook-videos.ts`, `13-download-hook-videos.ts`, `14-render.ts`, `15-cleanup.ts`
**Recommendation:** Widen the `Step` interface (`src/worker/pipeline.ts:34`) so the orchestrator passes a `StepContext` — `{ db, projectsDir, promptsDir, log, chat, ttsProvider, imageProvider }` — instead of only `videoId`. Each step's `run()` then receives resolved dependencies and stops re-deriving them. Keep the per-step `deps` override pattern for tests, but have it extend the orchestrator-supplied context instead of recreating it from scratch.
**Why:** Every single step module starts with the same 3–5 lines resolving `db`/`projectsDir`/`promptsDir`/`chat` from optional deps + `getDb()` + env vars + hardcoded defaults. That's 15 copies of the same resolution logic. When "./projects" changes, env var naming changes, or a new cross-cutting dep (e.g., a metrics sink, a new logger) gets added, every step has to be touched. The orchestrator already has a clean `RunPipelineDeps` injection story — it just stops at the step boundary instead of flowing through.

---

### #2 — Raw SQL scattered across dashboard routes with no data-access boundary
**Domain:** domain-dashboard | **Principle:** DIP/SRP | **Severity:** high | **Effort:** medium
**Files:** `src/app/api/topics/route.ts`, `src/app/api/topics/[id]/route.ts`, `src/app/api/topics/[id]/queue/route.ts`, `src/app/api/videos/route.ts`, `src/app/api/videos/[id]/route.ts`, `src/app/api/videos/[id]/retry/route.ts`, `src/app/api/videos/[id]/restart/route.ts`, `src/app/api/videos/[id]/files/[...path]/route.ts`, `src/app/videos/[id]/page.tsx`, `src/app/videos/page.tsx`, `src/app/topics/page.tsx`
**Recommendation:** Extract a small repository layer under `src/lib/repos/` — `topics.ts` (findById, list, create, updateFields, archive, hardDelete), `videos.ts` (findById, list, create, markFailed, markRunning, reset, restart), `steps.ts` (rows by video, upsertPending, markStatus). Routes then read/write through repos; routes keep HTTP/validation/transaction-orchestration, repos keep SQL. Do not introduce an ORM — keep `better-sqlite3` direct, just behind named functions.
**Why:** `SELECT * FROM videos WHERE id = ?` is hand-written in at least 5 places (`videos/[id]/route.ts:36`, `retry/route.ts:24`, `restart/route.ts:27`, `files/[...path]/route.ts:63`, `videos/[id]/page.tsx:41`). Changing the `videos` schema means grepping every route. Routes mix HTTP parsing, Zod validation, SQL, transaction choreography, and response shaping — adding a `deleted_at` column or moving to a soft-delete model would ripple through a dozen files. The worker (`pipeline.ts`, `runner.ts`) is already accumulating the same smell — consolidating these now before more routes are added is cheaper than after.

---

### #3 — Adding a step requires editing three separate lists kept in lockstep
**Domain:** domain-pipeline | **Principle:** OCP | **Severity:** medium | **Effort:** medium
**Files:** `src/worker/pipeline.ts` (STEP_ORDER, STEP_OUTPUTS), `src/worker/steps/index.ts` (REAL_STEPS), each step module's `name` property
**Recommendation:** Extend the `Step` interface with an `outputs: readonly string[]` field. Each step module owns its own name + outputs + cleanup. Derive `STEP_ORDER` and `STEP_OUTPUTS` from `REAL_STEPS` inside pipeline.ts. Only `REAL_STEPS` (in `steps/index.ts`) then controls ordering and is the single place to edit when adding or reordering a step.
**Why:** Today, adding a step requires: (a) create the file with the right numeric prefix, (b) add to `STEP_ORDER` at the right index, (c) add to `STEP_OUTPUTS` with the matching key, (d) add to `REAL_STEPS` at the matching position, (e) set the step's `name` to exactly match. Five places, no compile-time check that they agree — the domain-pipeline skill already warns "step order must match". That's a classic OCP smell: extension (new step) requires modification in multiple places. Consolidating also eliminates one class of bugs where a step's `name` accidentally diverges from its STEP_ORDER key.

---

### #4 — Pause-gate logic duplicated between runner and pipeline
**Domain:** domain-pipeline | **Principle:** DRY/SRP | **Severity:** medium | **Effort:** small
**Files:** `src/worker/runner.ts:24-29` (isQueueIdle), `src/worker/pipeline.ts:239-242`
**Recommendation:** Export `isQueueIdle(db)` from `runner.ts` (or move to a shared `src/worker/pause.ts`), and have `pipeline.ts`'s between-step check call it instead of inlining `getSetting("queue_state") === "paused" || getSetting("freepik_relogin_needed")`.
**Why:** The pause semantics are spec-defined and will evolve together (e.g., when a third pause condition is added for disk-full protection, rate-limit backoff, etc.). Two inline copies mean both must be updated in sync — silent drift would mean "the runner idles but the orchestrator doesn't pause between steps" or vice versa. Small change, low risk, removes a persistent paper-cut.

---

### #5 — `listFiles` file-tree walker duplicated between page and API
**Domain:** domain-dashboard | **Principle:** DRY/SRP | **Severity:** medium | **Effort:** small
**Files:** `src/app/videos/[id]/page.tsx:18-34`, `src/app/api/videos/[id]/route.ts:13-28`
**Recommendation:** Extract to `src/lib/project-files.ts` with a single exported `listProjectFiles(projectDir)`. Both the page and the API route import it.
**Why:** Identical recursive walker implementations in two files. Also — the server page and the API return essentially the same payload (video + steps + artifacts + logExists + queueState); both walk the filesystem server-side. A small `loadVideoDetail(id, db)` helper in `src/lib/repos/videos.ts` (or a new `src/lib/video-detail.ts`) would let the page render and the API both compose from one source. Pairs naturally with finding #2.

---

### #6 — LLM client has no provider abstraction (unlike TTS and image)
**Domain:** domain-content-gen | **Principle:** OCP/DIP | **Severity:** medium | **Effort:** medium
**Files:** `src/lib/openrouter.ts`, all content steps that import `chat` from it
**Recommendation:** Mirror the TTS/image pattern: `src/lib/llm/types.ts` (`ChatProvider` interface), `src/lib/llm/index.ts` (`getChatProvider(name)` registry), `src/lib/llm/openrouter.ts` (the current implementation). Add an `llm_provider` setting (enum `"openrouter"` for now). Steps resolve via the registry instead of importing `chat` directly. Adding a direct-Anthropic or direct-OpenAI client then becomes a one-file drop-in.
**Why:** The project already demonstrates this pattern well for TTS and image (`lib/tts/index.ts:6-16`, `lib/image/index.ts:6-16`) — the LLM layer is the inconsistent outlier. Right now, switching to a direct Anthropic/OpenAI/local-model integration requires modifying `openrouter.ts` itself or every step that imports it. Not urgent — OpenRouter covers most needs — but the next time someone wants to cut spend or add a local fallback, this friction will appear. Also: six content steps currently allow `chat` override via `deps.chat` individually; a central registry override would be uniform.

---

### #7 — `render.ts` ffmpeg argv construction is half extracted, half inline
**Domain:** domain-media | **Principle:** SRP | **Severity:** low | **Effort:** small
**Files:** `src/lib/render.ts`
**Recommendation:** Extract `buildHookConcatArgs`, `buildHookTailArgs`, `buildFinalConcatArgs`, `buildHookMainCrossfadeArgs`, `buildAudioMuxArgs` alongside the existing `buildSegmentArgs`/`buildPlaceholderArgs`/`buildXfadeFilterGraph`. Keep `render()` as a pure stage orchestrator that calls these + `exec`.
**Why:** Stage B (per-segment) and placeholder generation have dedicated testable argv builders; Stages A (hook concat), D (hook→main crossfade), and E (audio mux) build their argv inline inside the 200-line `render()` function. The inconsistency is confusing — new contributors can't tell if they should add a builder or inline. Also, the inline stages are untestable in isolation (they're gated on exec side-effects). Low severity because the code works and is well-commented, but worth doing next time someone touches render.

---

### #8 — Hook and main chunking share the same nearest-boundary math
**Domain:** domain-media | **Principle:** DRY | **Severity:** low | **Effort:** small
**Files:** `src/worker/steps/08-chunk.ts`
**Recommendation:** Extract a `splitByTargetDuration(sentences, targetSeconds)` that both hook-group-building and main-chunk-building use. Hook wraps it in a fixed-count constraint, main wraps it in a walk-to-end loop.
**Why:** Both loops walk sentences, track cumulative duration, and pick the nearest-boundary cutoff with identical logic. Not a hot spot today — chunking is deterministic and covered by the algorithm tests — but the duplication will tempt someone into fixing a bug in one copy and missing the other.

---

### #9 — `findTopic` helper not shared between topic routes
**Domain:** domain-dashboard | **Principle:** DRY | **Severity:** low | **Effort:** small
**Files:** `src/app/api/topics/[id]/route.ts:26-32` (has `findTopic` helper), `src/app/api/topics/[id]/queue/route.ts:15-17` (inlines the same query)
**Recommendation:** Folded into finding #2 — a topics repo function replaces both. If finding #2 is deferred, at minimum move `findTopic` to a shared module.
**Why:** Small duplication, low stakes, but it's pointing at the same underlying need as #2 (data-access boundary).

---

### #10 — Task-submit-then-poll scaffolding duplicated in AI33 and ComfyUI providers
**Domain:** domain-media | **Principle:** DRY | **Severity:** low | **Effort:** medium
**Files:** `src/lib/tts/ai33.ts` (submitTask + pollUntilReady), `src/lib/image/comfyui.ts` (submitPrompt + pollUntilComplete)
**Recommendation:** Consider an async job helper at `src/lib/async-job.ts` with `submitThenPoll({submit, poll, shouldRetry, onUnknown, onError, onDone})`. Both providers plug their endpoint-specific bits into the same flow.
**Why:** The outer shape is the same — POST to submit, loop with sleep and tolerant retry on network/malformed responses, validate status, detect error terminal vs done terminal, extract result. But the response schemas, terminal-state logic, and retry rules differ enough that a shared helper risks becoming "configuration-as-code." Low severity — keep as a candidate for when a third provider (e.g., Replicate, a Whisper-based aligner service) lands and the three-way similarity justifies the abstraction. Do not refactor speculatively.

## Priority Action Plan

### Immediate (high severity, small–medium effort)
- **#1** — Widen Step interface with a StepContext so every step stops re-resolving db/projectsDir/promptsDir/chat
- **#2** — Extract topic/video/step repositories so routes stop mixing HTTP and SQL

### Next Sprint (medium severity)
- **#3** — Collapse STEP_ORDER/STEP_OUTPUTS/REAL_STEPS into one step-registry by adding `outputs` to the Step interface
- **#4** — Dedupe `isQueueIdle` between runner and pipeline
- **#5** — Extract shared `listProjectFiles` (pairs with #2)
- **#6** — Add LLM provider registry mirroring the TTS/image pattern

### Backlog (low severity)
- **#7** — Extract the remaining render stage builders for consistency
- **#8** — Share chunking nearest-boundary logic between hook/main
- **#9** — Share `findTopic` between topic routes (folds into #2)
- **#10** — Consider a shared async-job helper for provider polling (only when a third poll-based provider appears)

## How to Act on This

Pick the items you want to tackle and pass their IDs to `/create-plan`:

```
/create-plan Refactor items #1, #3 from docs/refactoring/solid-audit-2026-04-17.md
```

The plan will use this audit as input — each item has the files, the what, and the why already specified.

## Notes

**Positive patterns worth preserving**

- **Provider registries (`lib/tts/`, `lib/image/`)** — textbook DIP. Steps depend on `TtsProvider` / `ImageProvider` abstractions; concrete providers register themselves. Adding a backend is a one-file drop-in. Finding #6 is about extending this pattern, not replacing it.
- **Settings system (`lib/settings.ts` + `lib/db.ts`)** — single Zod schema map gives string-storage ↔ typed-read coercion in one place. Enum-based provider selection has a compile-time-checked surface. Don't touch.
- **Orchestrator's `RunPipelineDeps` injection** — clean test seam that lets the pipeline be exercised without real step modules. The fix in #1 builds on this pattern, extending it from the pipeline boundary down into individual steps.
- **File-based step handoff** — documented in domain-content-gen; keeps steps independently testable and resumable. This is a deliberate spec decision, not debt.
- **Atomic multi-table writes use `db.transaction()` consistently** — queue-topic linkage, retry reset, restart, session-lost handling. Don't break this discipline during #2.
- **Defense-in-depth path traversal (`files/[...path]/route.ts`)** — four checks by design. If #2 extracts a file-serving helper, preserve every layer.

**Cross-cutting observations**

- Findings #1, #3, and #6 all point at the same underlying friction: the step/provider composition seam could be tightened. Doing #1 first makes #3 and #6 smaller.
- Findings #2, #5, and #9 all point at the absence of a repository boundary. A single extraction pass picks all three up at once.
- The `domain-*` skills already encode a lot of this structural understanding in their `references/current-state.md` files — updating those after the refactor is part of the done definition.
