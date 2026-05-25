# SOLID Audit — 2026-05-10 — Claude CLI

**Mode**: Custom scope — all functionality connected to the **Claude CLI** LLM provider
**Scope**: 14 source files spanning the LLM provider registry, the Claude-CLI provider implementation, settings/schema sites that name the provider, the LLM settings tab, the workflow editor's script-provider field, the orchestrator's resolver, and the spec doc.
**Domains analyzed**: `domain-content-gen` (LLM provider registry, provider modules, `ChatOpts` / `ChatMessage` contract, `ctx.chat` / `ctx.enrichChat`), with cross-cuts into `domain-dashboard` (LLM settings tab, settings keys, settings-tabs roster) and `domain-workflows` (workflow row zod schema, workflow editor option list, schema API route).

**Files in scope (14):**
- `src/lib/llm/claude-cli.ts`
- `src/lib/llm/index.ts`
- `src/lib/llm/types.ts`
- `src/lib/llm/openrouter.ts` (sister provider — used to compare contract conformance)
- `src/lib/settings.ts` (claude_cli_path / claude_cli_model / claude_cli_extra_args schemas)
- `src/lib/settings-enums.ts` (`enrich_chunks_llm_provider` enum)
- `src/lib/settings-tabs.ts` (LLM tab field roster)
- `src/lib/db.ts` (defaults + `SeedWorkflow.script_llm_provider` type)
- `src/lib/workflows-schema.ts` (`script_llm_provider` zod enum)
- `src/app/settings/llm-tab.tsx` (LLM settings tab UI)
- `src/app/workflows/[id]/edit/edit-form.tsx` (script-provider select options)
- `src/app/api/workflows/schema/route.ts` (publishes registry catalog)
- `src/worker/pipeline.ts` (resolves `chat` and `enrichChat` from snapshot/setting)
- `docs/histforge-spec.md` (stale references to `llm_provider`)

## Summary

The Claude CLI surface is in good architectural shape at the core: `claude-cli.ts` itself is a focused 70-line module with a single concern (shell out, capture, surface errors), the recent stdin/stdout fix is well-commented, the `llmProviders` registry + `getLlmProvider` lookup is an exemplary OCP pattern, the schema API route already publishes `Object.keys(llmProviders)` as the canonical roster, and tests mock at the spawn boundary cleanly. The two real findings are both about *catalogue drift* — the same shape called out in today's earlier Chatterbox audit (`solid-audit-2026-05-10.md`, Findings #2/#3): the provider name pair `["openrouter", "claude_cli"]` is hand-maintained in five sites despite the registry being the source of truth, and the settings tab dispatches between sub-panels via a hardcoded ternary that silently defaults any unknown view to Claude CLI. A third finding is a cancellation gap: `ChatOpts` carries no `AbortSignal`, so script-module steps that hold `ctx.signal` cannot abort an in-flight chat call, even though the user-memory cancellation contract says providers must consume the signal. A fourth finding is a docs-only spec drift — the spec still says "only `openrouter`" and references a setting (`llm_provider`) that no longer exists.

## Findings Overview

| ID  | Domain              | Principle | Severity | Effort | Files                                                                                                                                        |
|-----|---------------------|-----------|----------|--------|----------------------------------------------------------------------------------------------------------------------------------------------|
| 1   | domain-content-gen  | OCP       | medium   | small  | `src/lib/llm/index.ts`, `src/lib/workflows-schema.ts`, `src/lib/settings-enums.ts`, `src/lib/db.ts`, `src/app/workflows/[id]/edit/edit-form.tsx`, `src/app/settings/llm-tab.tsx` |
| 2   | domain-dashboard    | OCP       | medium   | small  | `src/app/settings/llm-tab.tsx`                                                                                                               |
| 3   | domain-content-gen  | ISP / LSP | medium   | small  | `src/lib/llm/types.ts`, `src/lib/llm/openrouter.ts`, `src/lib/llm/claude-cli.ts`                                                            |
| 4   | domain-content-gen  | (docs)    | low      | small  | `docs/histforge-spec.md`                                                                                                                     |

## Findings Detail

### #1 — LLM provider name list is duplicated in 5 hand-maintained sites despite the registry being canonical
**Domain:** domain-content-gen | **Principle:** OCP | **Severity:** medium | **Effort:** small
**Files:** `src/lib/llm/index.ts`, `src/lib/workflows-schema.ts`, `src/lib/settings-enums.ts`, `src/lib/db.ts`, `src/app/workflows/[id]/edit/edit-form.tsx`, `src/app/settings/llm-tab.tsx`

`src/lib/llm/index.ts` is the canonical source: `llmProviders = { openrouter, claude_cli }`, and `Object.keys(llmProviders)` is already exposed by `src/app/api/workflows/schema/route.ts` as the official catalog. But every other consumer of the provider name list duplicates the literal pair manually:

- `src/lib/workflows-schema.ts:26` — `script_llm_provider: z.enum(["openrouter", "claude_cli"])`
- `src/lib/settings-enums.ts:44` — `enrich_chunks_llm_provider: ["openrouter", "claude_cli"]`
- `src/lib/db.ts:88` — `SeedWorkflow.script_llm_provider: "openrouter" | "claude_cli"`
- `src/app/workflows/[id]/edit/edit-form.tsx:383-386` — inline `[{ value: "openrouter", label: "OpenRouter" }, { value: "claude_cli", label: "Claude CLI" }]`
- `src/app/settings/llm-tab.tsx:26-32` — `PROVIDER_VIEW_OPTIONS = [{ value: "openrouter", label: "OpenRouter" }, { value: "claude_cli", label: "Claude CLI" }]`

Adding a third backend (e.g. `ollama`) requires six coordinated edits with no compile-time link between them: register in the runtime registry, then mirror the name into the workflow zod enum, the settings enum, the seed-workflow type union, the workflow editor options list, and the LLM tab view options. The `enrich_chunks_llm_provider` enum already has the right shape via `ENUM_VALUES` and a compile-time guard (`_assertEnumKeysAreSettingKeys`), but its *values* are still a hand-typed pair.

There's a circular-import constraint to respect: `settings-enums.ts` is intentionally client-safe (no `db` / `node:` imports) per its header comment, so it can't import `llmProviders` directly because `claude-cli.ts` and `openrouter.ts` both import `settings.ts`, which imports `settings-enums.ts`. The fix is to add a tiny no-deps name module rather than import from the registry.

**Recommendation:** Add `src/lib/llm/names.ts` (or extend `src/lib/llm/types.ts`) that exports

- `LLM_PROVIDER_NAMES` — a `readonly` tuple of provider IDs (`["openrouter", "claude_cli"] as const`)
- `LlmProviderName` — the union derived from the tuple

Add a compile-time guard in `src/lib/llm/index.ts` that asserts `keyof typeof llmProviders === LlmProviderName` (mirrors the `_assertEnumKeysAreSettingKeys` shape in `settings-enums.ts`). Then derive every consumer from the names tuple:

- `workflows-schema.ts` — `z.enum(LLM_PROVIDER_NAMES as unknown as [LlmProviderName, ...LlmProviderName[]])`
- `settings-enums.ts` — `enrich_chunks_llm_provider: LLM_PROVIDER_NAMES`
- `db.ts` — `SeedWorkflow.script_llm_provider: LlmProviderName`
- The two UI option lists — map `LLM_PROVIDER_NAMES` to `{ value, label }` using a label table that mirrors `SETTING_OPTION_LABELS` (already present in `settings-enums.ts:84-87`).

**Why:** Adding a provider becomes one runtime-registry edit plus a one-line addition to the names tuple — every other site updates by inference. Today's six-place edit has no compile-time link, so a forgotten site (the workflow editor's option list, for example) would silently fail at runtime: a user picks the new provider in Settings (where the tab knows it), saves, and the workflow editor would refuse to render it because the inline options array doesn't include the new value. Same shape as the TTS audit's Finding #2 in `solid-audit-2026-05-10.md`; the LLM side has no equivalent `meta.ts` yet, so this finding stands alone.

---

### #2 — `<LlmTab>` switches sub-panels via a hardcoded ternary that silently defaults to Claude CLI
**Domain:** domain-dashboard | **Principle:** OCP | **Severity:** medium | **Effort:** small
**Files:** `src/app/settings/llm-tab.tsx`

`llm-tab.tsx:71-75` selects which provider sub-panel renders by a ternary:

```
{view === "openrouter" ? <OpenRouterView … /> : <ClaudeCliView … />}
```

Two SOLID issues fall out:

1. **Implicit fallback.** The `else` arm renders `<ClaudeCliView>` for *any* non-`openrouter` value. If a future provider name is added to the `view` state's union but its panel hasn't been wired up yet, the user picks (say) `ollama` from the dropdown and the tab silently shows the Claude CLI fields. There's no compile-time check that every member of the view union has a matching panel.
2. **Closed for extension.** Adding a third panel means changing this ternary into an else-if chain (or a `switch`), then changing it again for the fourth. The OCP-friendly shape — providers register their UI alongside their runtime — isn't in place.

**Recommendation:** Replace the ternary with a `Record<LlmProviderName, React.ComponentType<LlmTabProps>>` lookup. Move `OpenRouterView` and `ClaudeCliView` to their own files (`src/app/settings/llm-providers/openrouter.tsx`, `…/claude-cli.tsx`) following the same shape as the existing tab-per-file layout used elsewhere in `src/app/settings/`. The tab body becomes:

```
const PROVIDER_VIEWS: Record<LlmProviderName, React.ComponentType<LlmTabProps>> = {
  openrouter: OpenRouterView,
  claude_cli: ClaudeCliView,
};
const View = PROVIDER_VIEWS[view];
return <View values={values} update={update} />;
```

If `LlmProviderName` is centralized per Finding #1, TypeScript will fail at compile time when a new name is added to the union but no panel is registered.

**Why:** The ternary's `else` branch hides a category of bug (silently rendering the wrong panel for an unknown view value). A `Record` keyed by the name union makes that bug a compile error. Same fix shape as the TTS audit's Finding #3 in today's earlier audit, narrower scope here because there are only two providers — but the cost of doing it now is small, and it prevents the next provider addition from accidentally relying on the implicit fallback.

---

### #3 — `ChatOpts` lacks `AbortSignal`; `ctx.chat()` ignores the orchestrator's cancellation port
**Domain:** domain-content-gen | **Principle:** ISP / LSP | **Severity:** medium | **Effort:** small
**Files:** `src/lib/llm/types.ts`, `src/lib/llm/openrouter.ts`, `src/lib/llm/claude-cli.ts`

The orchestrator threads `ctx.signal: AbortSignal` into every step (`pipeline.ts:32-49`) precisely so long-running steps can cancel mid-call. The cancellation contract is project-wide policy (per the user-memory note: *"StepContext.signal is the single AbortSignal threaded through providers; new long-running steps must consume it (don't reinvent shouldCancel).*"). Yet `ChatOpts` (`src/lib/llm/types.ts:8-16`) carries only `model`, `db`, and `retryDelayMs` — no `signal`. So script-module steps that hold the signal cannot pass it through `chat()`, and neither provider implementation looks for one.

Concrete consequences:

- `write_chapters` makes ~`chapter_count / BATCH_SIZE` batched LLM calls plus a `story_so_far` summary call per batch. With `chapter_count=15`, that's a dozen-plus calls per video. Today, when a user clicks Delete on the in-flight video, the cancellation watcher flips `ctx.signal`, but the in-flight batch still completes — it has no way to learn the signal was aborted.
- `openrouter.ts:51` calls `fetch(ENDPOINT, init)`. `RequestInit.signal` accepts an `AbortSignal` directly — wiring it is one assignment.
- `claude-cli.ts:41` spawns `claude`. A `child.kill()` call gated on `signal.addEventListener('abort', …)` (with cleanup on `close`) terminates the subprocess; this is the established pattern for long-running provider calls.

This is the only LSP-flavored gap between `openrouterProvider` and `claudeCliProvider` that isn't already documented as an intentional difference (retries are intentionally absent from the CLI provider — `claude-cli.ts:14-16` calls this out — so that asymmetry is fine). Cancellation is *not* documented as intentionally absent; it's just missing from the interface.

**Recommendation:**
1. Add `signal?: AbortSignal` to `ChatOpts` in `src/lib/llm/types.ts`.
2. In `openrouter.ts:39`, set `init.signal = opts.signal`. (The retry loop already swallows non-2xx; an `AbortError` should propagate without retry — check `signal.aborted` between attempts.)
3. In `claude-cli.ts`, register `opts.signal?.addEventListener("abort", () => child.kill())` inside the spawn promise, with a removeEventListener cleanup on `close`.
4. Update `pipeline.ts:294-297` to pass `signal: ctx.signal` when binding `ctx.chat` and `ctx.enrichChat`, or more cleanly, have the resolver hand back callables that pre-bind the signal so steps don't have to remember.

**Why:** Closes the cancellation contract for script-module steps. The `ctx.signal` thread is the project's single cancellation port (per user memory); chat callers shouldn't have to invent their own polling. Today's behavior — a Delete request waits for the next chat call to complete before honoring the user's intent — is invisible to the operator and turns "cancel now" into "cancel after the next 60-second LLM call." The fix is small, the failure mode is real, and the interface change is additive (existing callers don't need to change).

---

### #4 — Spec doc still says "only `openrouter`" and references a setting that doesn't exist
**Domain:** domain-content-gen | **Principle:** (docs) | **Severity:** low | **Effort:** small
**Files:** `docs/histforge-spec.md:257`, `docs/histforge-spec.md:1219`

CLAUDE.md says the spec is the source of truth for design decisions. Two places in the spec still describe a single-LLM world:

- Line 257: ```| llm_provider | enum | openrouter | LLM backend (only openrouter today) |```
- Line 1219: ```Provider registry selects by llm_provider setting (currently only openrouter).```

Both lines reference a setting key (`llm_provider`) that doesn't exist in `lib/settings.ts`. The actual shape is two distinct keys per Invariant E (`domain-content-gen` skill, "LLM Provider Registry"):

- `script_llm_provider` — column on `workflows`, snapshot-pinned per workflow
- `enrich_chunks_llm_provider` — global, live, used by step 09

…and there are now two backends (`openrouter`, `claude_cli`).

**Recommendation:** Replace both lines with the current shape. Add the three Claude-CLI settings (`claude_cli_path`, `claude_cli_model`, `claude_cli_extra_args`) to the settings table, and rewrite §20's `lib/llm/` bullet to list both backends and explain the snapshot/live split.

**Why:** This is the documentation half of Finding #1. The spec is canonical for design decisions per CLAUDE.md, and a reader who consults it before reading code will miss the entire Claude CLI surface. Effort is trivial, audience is anyone onboarding to the LLM side.

---

## Priority Action Plan

### Immediate (medium severity, small effort)
- **#1** — Centralize the LLM provider names in a no-deps module; derive zod enum, settings enum, seed-workflow type, and the two UI option lists from it. Closes the catalogue-drift surface.
- **#2** — Replace the LLM tab's ternary view-dispatch with a `Record<LlmProviderName, ComponentType>` lookup; extract the two sub-views to their own files. Folds cleanly into #1 (the lookup type closes over `LlmProviderName`).
- **#3** — Add `signal?: AbortSignal` to `ChatOpts`; wire it into both providers and have the orchestrator pre-bind `ctx.signal` on `ctx.chat` / `ctx.enrichChat`. Closes the cancellation contract for script steps.

### Backlog (low severity)
- **#4** — Update `docs/histforge-spec.md:257` and `:1219` to reflect the current two-provider shape and the snapshot/live split.

## How to Act on This

Pick the items you want to tackle and pass their IDs to `/create-plan`:

```
/create-plan Refactor items #1, #2, #3 from docs/refactoring/solid-audit-2026-05-10-claude-cli.md
```

The plan will use this audit as input — each item has the files, the what, and the why already specified.

## Notes

**Positive patterns worth preserving:**

- **`claude-cli.ts` itself.** 70 lines, single responsibility (shell out, capture, surface errors), with high-quality "why" comments explaining the recent stdin-close and stdout-in-error fixes. Reference SRP shape for a thin provider module.
- **`llmProviders` registry + `getLlmProvider` lookup.** One file, one entry per provider, callable lookup with explicit-throw on unknown name. Reference OCP shape on the runtime side. The schema-route consumer already derives from `Object.keys(llmProviders)` — that is the pattern Finding #1 asks every other consumer to mirror.
- **Test boundary mocking.** Both `claude-cli.test.ts` and `pipeline-claude-cli.test.ts` mock at the system boundary (`node:child_process.spawn`) and run real registry / repo / settings code through. Exactly the seam-at-the-boundary pattern the codebase prefers; keep this shape for any future provider that shells out.
- **Per-provider settings keys (`claude_cli_path`, `claude_cli_model`, `claude_cli_extra_args`).** Namespaced by the provider slug, easy to find by grep, easy to add. (`model_name` for OpenRouter is the legacy unprefixed key — minor inconsistency, not worth flagging.)

**Cross-domain observation:** Findings #1 and #2 mirror the May 10 Chatterbox audit's Findings #2 and #3 (`docs/refactoring/solid-audit-2026-05-10.md`). Both surfaces have the same "registry-canonical, consumers-hand-maintained" drift, and both have the same fix shape. If the team opts to add an LLM-side `meta.ts` (mirroring `src/lib/tts/meta.ts`) instead of a names-only module, the `label` field in the tab/editor option lists could move there too — but the LLM surface is small enough today that the names-only module is the lighter fix.

**No domain coverage gap detected** — every Claude-CLI-touching file maps cleanly to `domain-content-gen` (provider, registry, types, orchestrator binding), `domain-dashboard` (settings tab, settings keys, defaults), or `domain-workflows` (zod schema, workflow editor option list, schema API route).
