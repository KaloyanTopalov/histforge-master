# Claude CLI SOLID Refactor (Findings #1–#4)

## Overview

Operationalize all four findings from `docs/refactoring/solid-audit-2026-05-10-claude-cli.md`. Three small refactors plus a docs update: centralize the LLM provider name list so adding a backend is a one-line edit (not six); replace the LLM tab's hardcoded ternary view-dispatch with a typed `Record` lookup keyed by the centralized name union; close the cancellation contract by adding `AbortSignal` to `ChatOpts` and wiring it into both providers; and bring `docs/histforge-spec.md` in line with today's two-provider, two-key reality.

## Current State

**Canonical LLM registry (good):**
- `src/lib/llm/index.ts:7-10` — `llmProviders = { openrouter, claude_cli }`. Lookup via `getLlmProvider(name)` at `src/lib/llm/index.ts:12-18`.
- `src/app/api/workflows/schema/route.ts:33` — already publishes `Object.keys(llmProviders)` as the public catalog.

**Hand-maintained name duplicates (the drift surface, finding #1):**
- `src/lib/workflows-schema.ts:26` — `script_llm_provider: z.enum(["openrouter", "claude_cli"])`.
- `src/lib/settings-enums.ts:44` — `enrich_chunks_llm_provider: ["openrouter", "claude_cli"]` (with label overrides at `:84-87`).
- `src/lib/db.ts:88` — `SeedWorkflow.script_llm_provider: "openrouter" | "claude_cli"`.
- `src/app/workflows/[id]/edit/edit-form.tsx:383-386` — inline option list.
- `src/app/settings/llm-tab.tsx:26-32` — `PROVIDER_VIEW_OPTIONS`.

**Constraint:** `src/lib/settings-enums.ts:1-10` is intentionally client-safe (header comment). It cannot import `llmProviders` directly because `claude-cli.ts` and `openrouter.ts` import `settings.ts`, which imports `settings-enums.ts`. The fix is a no-deps name module rather than a registry import.

**Tab view-dispatch ternary (finding #2):**
- `src/app/settings/llm-tab.tsx:71-75` — `view === "openrouter" ? <OpenRouterView/> : <ClaudeCliView/>`. The `else` branch silently catches any unknown view value.
- The two sub-views (`OpenRouterView`, `ClaudeCliView`) live inline in the same file at `:97-122` and `:126-154`.

**Cancellation gap (finding #3):**
- `src/lib/llm/types.ts:8-16` — `ChatOpts` has only `model`, `db`, `retryDelayMs` — no `signal`.
- `src/lib/llm/openrouter.ts:39-51` — builds `init` and calls `fetch(ENDPOINT, init)`; no signal propagated; retry loop at `:48-74` swallows all errors.
- `src/lib/llm/claude-cli.ts:39-67` — spawns child via `spawnAndCapture`; no abort hook.
- `src/worker/pipeline.ts:37-38, 49` — `StepContext` exposes `chat`, `enrichChat`, and `signal`. Steps already hold `ctx.signal` (`pipeline.ts:42-49`).
- `src/worker/pipeline.ts:190-191` — `buildStepContext` binds `chat: deps.chat` and `enrichChat: deps.enrichChat` directly with no signal closure.
- `src/worker/pipeline.ts:293-297` — resolver picks providers from snapshot/setting and exposes `.chat` raw.
- `src/worker/cancellation.ts:113-123` — `throwIfAborted(signal)` already exists (AbortError-shaped throw). Reusable.
- Existing precedent for this pattern: `src/lib/tts/chatterbox.ts:34, 144` threads `opts.signal` straight into `fetch`.

**Spec drift (finding #4):**
- `docs/histforge-spec.md:257` — settings table lists `llm_provider` (a key that doesn't exist) with "only openrouter today".
- `docs/histforge-spec.md:1219` — §20 says "Provider registry selects by `llm_provider` setting (currently only openrouter)".
- The actual settings are `claude_cli_path`, `claude_cli_model`, `claude_cli_extra_args` (registered at `src/lib/settings.ts:74-76`) and the two provider keys are `script_llm_provider` (snapshot, on `workflows`) and `enrich_chunks_llm_provider` (global setting).

**Test seams (must keep passing):**
- `__tests__/unit/lib/llm/claude-cli.test.ts` — mocks `node:child_process.spawn` at the system boundary.
- `__tests__/unit/lib/llm/openrouter.test.ts` — mocks `global.fetch`.
- `__tests__/unit/worker/pipeline-claude-cli.test.ts` — end-to-end via `runPipeline` with spawn mocked.

## Scope

**Doing**: Findings #1 (name centralization), #2 (tab Record-dispatch + extract sub-views), #3 (signal in `ChatOpts` + provider wiring + pipeline pre-bind), and #4 — replace the stale `llm_provider` row in the spec's settings table with rows for the three Claude CLI settings (`claude_cli_path`, `claude_cli_model`, `claude_cli_extra_args`), and rewrite §20's `lib/llm/` bullet.

**Not doing**:
- An LLM-side `meta.ts` mirroring `src/lib/tts/meta.ts`. The audit explicitly calls a names-only module the lighter fix today; revisit only when a third backend lands.
- Renaming the legacy `model_name` setting (OpenRouter's unprefixed key). The audit calls it out as "minor inconsistency, not worth flagging".
- Touching the outer shape of `SETTING_OPTION_LABELS` in `src/lib/settings-enums.ts`. The values for `enrich_chunks_llm_provider` will derive from the new label table (Task 1.4), but the labels-by-setting-key shape stays.
- Refactoring the TTS / image / video provider option lists in `src/app/workflows/[id]/edit/edit-form.tsx` (`:393-399`, `:407-411`, `:420-425`). The audit asks only for the `script_llm_provider` list; the others are sister-domain drift surfaces handled elsewhere.
- Adding cancellation-on-abort to non-LLM providers. Chatterbox already has it (`src/lib/tts/chatterbox.ts:144`); other surfaces are out of scope here.

## Tasks

### Phase 1: Centralize provider names + replace LLM tab ternary

**Vertical slice rationale:** Findings #1 and #2 fold together — the `Record<LlmProviderName, …>` lookup in #2 closes over the union introduced in #1, and once #1 is in place TypeScript will error at compile time if a future name is added without a panel. Doing them in one slice means at the end of the phase every consumer of the provider-name list (zod, settings enum, seed type, two UI option lists, the tab dispatch) is derived from one tuple.

- [x] **Task 1.1: Add the canonical names module**
  **Files**: `src/lib/llm/names.ts` (new)
  **What**: Export a `readonly` tuple of provider IDs (`LLM_PROVIDER_NAMES`), the union type derived from it (`LlmProviderName`), and a label table mapping each ID to its operator-facing label (e.g. `OpenRouter`, `Claude CLI`). Module must be no-deps (no `db`, no `node:` imports — same client-safety constraint as `src/lib/settings-enums.ts:1-10`).
  **Context**: Mirror the `as const` shape of `ENUM_VALUES` in `src/lib/settings-enums.ts:22-46` — that pattern is what every other consumer will derive from. The label table can mirror the inner-key constraint shape used in `SETTING_OPTION_LABELS` (`src/lib/settings-enums.ts:65-92`) so a typo on a value fails to compile. Resist the urge to expand into a full meta module (envKey, endpoint, etc.) — the audit explicitly calls names-only the lighter fix; an LLM `meta.ts` is a future consideration only.

- [x] **Task 1.2: Add a registry-vs-names compile-time guard**
  **Files**: `src/lib/llm/index.ts`
  **What**: Tighten the `Record<string, LlmProvider>` on `llmProviders` (`src/lib/llm/index.ts:7`) to `Record<LlmProviderName, LlmProvider>`, and add a compile-time assertion that `keyof typeof llmProviders === LlmProviderName`. The `Object.keys(llmProviders)` consumer at `src/app/api/workflows/schema/route.ts:33` is unaffected — `Object.keys` returns `string[]` regardless of the Record's key type. Re-export `LlmProviderName` and `LLM_PROVIDER_NAMES` from this file so consumers do not need to import from a sibling.
  **Context**: Mirror the `_assertEnumKeysAreSettingKeys` shape in `src/lib/settings-enums.ts:53-57` — same `extends X ? true : never` trick, same `void _assert…` to silence the unused-var lint.

- [x] **Task 1.3: Derive the workflow zod enum from the tuple**
  **Files**: `src/lib/workflows-schema.ts`
  **What**: Replace the inline `z.enum(["openrouter", "claude_cli"])` at `src/lib/workflows-schema.ts:26` with a derivation from `LLM_PROVIDER_NAMES`.
  **Context**: Zod's `.enum()` requires a non-empty tuple type — use the same `as unknown as [LlmProviderName, ...LlmProviderName[]]` cast pattern (or its `[T, ...T[]]` equivalent) that the audit's recommendation calls out. Keep the existing module's circular-import constraints intact: `workflows-schema.ts` already imports `@/worker/steps`, so importing from `src/lib/llm/names.ts` is fine.

- [x] **Task 1.4: Derive `enrich_chunks_llm_provider` values and labels from the names module**
  **Files**: `src/lib/settings-enums.ts`
  **What**: Replace the literal `["openrouter", "claude_cli"]` array at `src/lib/settings-enums.ts:44` with `LLM_PROVIDER_NAMES`. Replace the inline `enrich_chunks_llm_provider` block of `SETTING_OPTION_LABELS` at `:84-87` with a derivation that reads from the names label table (Task 1.1) so labels live in exactly one place. The outer `SETTING_OPTION_LABELS` shape stays as-is.
  **Context**: This is the file with the strictest import constraint (header comment at `:1-10` — must stay client-safe, no `db`/`node:`). The new `src/lib/llm/names.ts` module is exactly the same shape, so it satisfies the constraint by construction. The inner-key TypeScript constraint on `LabelOverrides` (`:65-69`) means a typo on a value still fails to compile — verify after the change. Verify the existing `_assertEnumKeysAreSettingKeys` guard at `:53-57` still compiles.

- [x] **Task 1.5: Type `SeedWorkflow.script_llm_provider` from the union**
  **Files**: `src/lib/db.ts`
  **What**: Replace the inline `"openrouter" | "claude_cli"` union at `src/lib/db.ts:88` with `LlmProviderName`.
  **Context**: `src/lib/db.ts` is the worker/server side, so importing from `src/lib/llm/names.ts` carries no client-bundle concern. Verify `BUILTIN_WORKFLOWS` at `:95+` still type-checks against the narrowed type — both seed values (`openrouter`) are in the union, so this should be a no-op at runtime.

- [x] **Task 1.6: Derive the workflow editor's `script_llm_provider` option list**
  **Files**: `src/app/workflows/[id]/edit/edit-form.tsx`
  **What**: Replace the inline `[{value: "openrouter", label: "OpenRouter"}, ...]` array at `src/app/workflows/[id]/edit/edit-form.tsx:383-386` with a `LLM_PROVIDER_NAMES.map(...)` pulling label from the names label table.
  **Context**: This file is a `"use client"` page (`:1`) so the import target must stay client-safe — the no-deps `names.ts` from Task 1.1 satisfies this. The sibling TTS / image / video option lists in this file are out of scope (see "Not doing"). Touch only the `script_llm_provider` SelectField.

- [x] **Task 1.7: Derive `PROVIDER_VIEW_OPTIONS` from the tuple**
  **Files**: `src/app/settings/llm-tab.tsx`
  **What**: Replace `PROVIDER_VIEW_OPTIONS` at `src/app/settings/llm-tab.tsx:26-32` with a derivation from `LLM_PROVIDER_NAMES` + the names label table. Type the `view` state as `LlmProviderName` directly and drop the local `ProviderView` alias at `:24`.
  **Context**: After Task 1.4 makes `enrich_chunks_llm_provider`'s storage type derive from the names tuple, `LlmProviderName` and `AllSettings["enrich_chunks_llm_provider"]` will be the same type — so the alias becomes redundant. The ternary at `:71-75` still exists at the end of this task; Task 1.8 replaces it.

- [x] **Task 1.8: Replace the LLM tab ternary with a typed `Record` lookup**
  **Files**: `src/app/settings/llm-tab.tsx`
  **What**: Replace the ternary at `src/app/settings/llm-tab.tsx:71-75` with a `Record<LlmProviderName, React.ComponentType<LlmTabProps>>` lookup keyed by `view`, then render `<View values={values} update={update} />`. The two sub-view components are still inline in this file at this point — Task 1.9 extracts them.
  **Context**: This is the OCP fix for Finding #2. The `Record<LlmProviderName, …>` type means TypeScript will error if a future provider name is added to the tuple but no panel is registered, which is exactly what the audit calls out: "A `Record` keyed by the name union makes that bug a compile error."

- [x] **Task 1.9: Extract `OpenRouterView` and `ClaudeCliView` to their own files**
  **Files**: `src/app/settings/llm-providers/openrouter.tsx` (new), `src/app/settings/llm-providers/claude-cli.tsx` (new), `src/app/settings/llm-tab.tsx`
  **What**: Move the two sub-view components from `src/app/settings/llm-tab.tsx:97-154` into their own files under `src/app/settings/llm-providers/`. Move the `Section` primitive (`:160-188`) somewhere both files can import — either a third file in the same folder or keep it shared in `llm-tab.tsx` and re-export. The `LlmTabProps` interface (`:17-20`) needs to be importable too. Update the `Record` lookup from Task 1.8 to import the components from their new homes.
  **Context**: Same shape as the existing tab-per-file layout under `src/app/settings/`. Keep "use client" on the new files. The audit calls out this folder structure explicitly (`src/app/settings/llm-providers/openrouter.tsx`, `…/claude-cli.tsx`) — match those paths so future provider panels follow the same convention.

### Phase 2: Close the cancellation contract for `ctx.chat` / `ctx.enrichChat`

**Vertical slice rationale:** Finding #3 is genuinely cross-cutting (interface + 2 providers + orchestrator), but it's all one capability — "the user clicks Delete on a video; an in-flight LLM call aborts now, not after this batch". Splitting it into a "types-only" phase, then a "providers" phase, then a "pipeline" phase would leave the codebase in a state where the type exists but nothing honors it, which is worse than no change. Do all four edits in one slice and verify with the existing pipeline-claude-cli integration test.

- [x] **Task 2.1: Add `signal?: AbortSignal` to `ChatOpts`**
  **Files**: `src/lib/llm/types.ts`
  **What**: Add `signal?: AbortSignal` to the `ChatOpts` interface at `src/lib/llm/types.ts:8-16`. Document why (one short line — "honored by both providers; aborts in-flight fetch / kills the spawned CLI"); existing comments in this file already follow that single-line style.
  **Context**: This is the contract change that the next two tasks honor. Additive, so no existing caller breaks. The re-export in `src/lib/llm/index.ts:5` and `src/lib/llm/openrouter.ts:5` and `src/lib/llm/claude-cli.ts:6` already surface `ChatOpts` to consumers — nothing to change there.

- [x] **Task 2.2: Honor `opts.signal` in the OpenRouter provider**
  **Files**: `src/lib/llm/openrouter.ts`, `__tests__/unit/lib/llm/openrouter.test.ts`
  **What**: Wire `opts.signal` into the `fetch` call at `src/lib/llm/openrouter.ts:51` (set `init.signal = opts.signal`). Inside the retry loop at `:48-74`, the `catch` arm currently swallows every error and proceeds to the next attempt; add a guard that re-throws immediately when `signal?.aborted` is true (or when the caught error is an AbortError) — a cancelled call must not respect the exponential-backoff schedule. The thrown error must match the AbortError shape used elsewhere in the codebase (`src/worker/cancellation.ts:113-123`: `Error` with `name = "AbortError"`). Add a unit test asserting that an aborted signal causes `chat()` to reject with an AbortError-shaped error and not sleep through retries (use `retryDelayMs: 0`, assert fetch is called at most once).
  **Context**: Reuse `throwIfAborted` from `src/worker/cancellation.ts` for the eager-throw if doing so does not introduce a worker → lib import. If it does, mirror the shape locally — do not duplicate the helper. Pattern precedent for testing abort: `__tests__/unit/lib/tts/chatterbox.test.ts` mocks fetch and asserts `signal` propagation.

- [x] **Task 2.3: Honor `opts.signal` in the Claude CLI provider**
  **Files**: `src/lib/llm/claude-cli.ts`, `__tests__/unit/lib/llm/claude-cli.test.ts`
  **What**: Extend `spawnAndCapture` (`src/lib/llm/claude-cli.ts:39-67`) to take an optional `signal: AbortSignal | undefined`; have `chat` pass `opts.signal` through. Inside the spawn promise, register an abort listener on the signal that calls `child.kill()` and rejects the promise with an AbortError-shaped error matching `src/worker/cancellation.ts:113-123` (`Error` with `name = "AbortError"`). Remove the listener in the `close` handler so the signal isn't held after the spawn completes, and so the kill-induced `close` (non-zero exit code) does not also fire the existing `claude exited with code …` rejection. Add unit tests: (a) firing the signal kills the child and the promise rejects with an AbortError; (b) listener is removed after a normal close so a later abort does not double-fire.
  **Context**: `child.kill()` typically triggers a non-zero `close` event; the abort branch should win over the exit-code branch when the signal fired. Order operations so that an abort always rejects with the AbortError shape, never the `claude exited with code …` shape. The `child.on("error", reject)` path at `:52` is independent and should keep its current behavior.

- [x] **Task 2.4: Pre-bind `ctx.signal` in the pipeline so script steps don't have to**
  **Files**: `src/worker/pipeline.ts`, `__tests__/unit/worker/pipeline-claude-cli.test.ts` (extend, don't replace)
  **What**: At `src/worker/pipeline.ts:190-191`, change `chat: deps.chat` / `enrichChat: deps.enrichChat` to closures that fold `ctx.signal` into the `opts` object before delegating. End-state: a script step calling `ctx.chat(messages)` (no opts) gets cancellation for free; a step that passes its own `opts` still has `signal` set unless it explicitly overrides. Document the binding briefly — one comment line — so the next reader doesn't think the closures are accidental.
  **Context**: The seven existing call sites (`src/worker/steps/01-research-outline.ts:109`, `02-research-characters.ts:61`, `03-write-hook.ts:77`, `04-write-chapters.ts:251`, `09-enrich-chunks.ts:89`, `generate-hook-video.ts:43`, `generate-main-images.ts:47`) all pass `chat: ctx.chat` to a sub-helper without opts. They'll inherit the signal automatically — no per-step changes needed. Verify by running the full test suite. The integration test `__tests__/unit/worker/pipeline-claude-cli.test.ts` exercises the four script steps end-to-end via spawn; extend it (or add a sibling test) that aborts the controller mid-run and asserts the spawn child receives a `kill`. The `controller` is built at `src/worker/pipeline.ts:363`; the test already has access to the runner's deps.

### Phase 3: Spec doc alignment

Single-file docs update; independent of code changes, runs last so the spec reflects the post-refactor surface.

- [x] **Task 3.1: Replace the stale `llm_provider` line in the settings table**
  **Files**: `docs/histforge-spec.md`
  **What**: Remove `docs/histforge-spec.md:257` (`| llm_provider | enum | openrouter | LLM backend (only openrouter today) |`). Replace with rows for the three Claude CLI settings (`claude_cli_path`, `claude_cli_model`, `claude_cli_extra_args`) — types and defaults pulled from `src/lib/settings.ts:74-76` and the corresponding entries in `seedDefaultSettings` in `src/lib/db.ts`.
  **Context**: The two real provider keys (`script_llm_provider`, `enrich_chunks_llm_provider`) belong in different places in the spec — `script_llm_provider` is a workflow column, not a setting; `enrich_chunks_llm_provider` is a setting. Place the latter in the settings table and reference the former in the workflows section if a row doesn't already exist for it. Match the table's existing column conventions (Key | Type | Default | Notes).

- [x] **Task 3.2: Rewrite §20's `lib/llm/` bullet**
  **Files**: `docs/histforge-spec.md`
  **What**: Replace `docs/histforge-spec.md:1219` to list both backends (`openrouter`, `claude_cli`), describe the snapshot-pinned vs live split (`script_llm_provider` is on the workflow snapshot, `enrich_chunks_llm_provider` is a global live setting), and mention that adding a provider is one new file + one registry entry — same operational shape as the `lib/tts/` bullet on `:1220`.
  **Context**: The TTS bullet at `:1220` is a near-perfect template (provider registry, snapshot-pinned, "one new file + one registry entry"). Mirror its phrasing for consistency. After Phase 1 lands, mention the `LLM_PROVIDER_NAMES` tuple as the centralized name list — but only if the references are useful for an onboarding reader, not just trivia.

## References

- Audit: `docs/refactoring/solid-audit-2026-05-10-claude-cli.md`
- Sister TTS audit (same fix shape, finding #2/#3): `docs/refactoring/solid-audit-2026-05-10.md`
- Cancellation contract origin: `docs/plans/archive/2026-05-01-mid-step-cancellation.md`
- Existing AbortError helper: `src/worker/cancellation.ts:113-123`
- Existing precedent for `signal` threaded into `fetch`: `src/lib/tts/chatterbox.ts:34, 144`
- Pattern precedent for compile-time guard: `src/lib/settings-enums.ts:53-57`
- Pattern precedent for centralized provider metadata: `src/lib/tts/meta.ts`
