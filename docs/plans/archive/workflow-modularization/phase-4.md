# Phase 4 — Claude CLI Script Provider + `enrich_chunks` Provider

**Cross-phase invariants:** [`README.md`](README.md) — Invariant B (snapshot `script_llm_provider` becomes runtime authority for `ctx.chat`), Invariant D (schema endpoint widens `providers.script` automatically), **Invariant E (per-module LLM resolution — introduced this phase)**

---

## Overview

Register a `claude_cli` LLM provider that shells out to the local `claude` binary, then split `StepContext`'s single `chat` field into two LLM entry points per Invariant E: `ctx.chat` resolved from `snapshot.script_llm_provider` (the field captured by Phase 1, finally consumed) and `ctx.enrichChat` resolved from a new global setting `enrich_chunks_llm_provider`. Delete the now-obsolete `llm_provider` global setting.

After Phase 4, a workflow with `script_llm_provider: "claude_cli"` runs the four script-module steps via `child_process.spawn("claude", ["-p", ...])`. The `enrich_chunks` glue step reads its provider from a separate live global setting; an operator can flip enrich-chunks providers without touching any workflow row.

---

## Current State

**After Phase 3:**
- Phase 1 captured `snapshot.script_llm_provider` but `resolveDeps` still reads `getLlmProvider(getSetting("llm_provider", db)).chat` at `src/worker/pipeline.ts:234-235`. The snapshot field is populated but unconsumed.
- Phase 2's `WorkflowRowSchema` enum already includes `"claude_cli"` (`src/lib/workflows-schema.ts:26`), and the editor offers it in the `script_llm_provider` Select with the suffix `"Claude CLI (coming in Phase 4)"` (`src/app/workflows/[id]/edit/edit-form.tsx:377-383`). Saving works; queuing a video with `claude_cli` selected fails at `getLlmProvider("claude_cli")` (`src/lib/llm/index.ts:12` — throws `"Unknown LLM provider: \"claude_cli\""`).
- Phase 3's `GET /api/workflows/schema` derives `providers.script` from `Object.keys(llmProviders)` (Invariant D); registering the new provider widens the response automatically, and Phase 3 Task 5's inline snapshot diffs accordingly.

**Patterns Phase 4 reuses:**
- LLM provider interface: `src/lib/llm/types.ts:18-20` (`LlmProvider.chat(messages, opts?)` returns `Promise<string>`). `ChatMessage` and `ChatOpts` shapes in the same file (lines 3–16).
- Existing provider as the model for `claude-cli.ts`: `src/lib/llm/openrouter.ts:23-78` — env-var guard, fetch + retry pattern, `db?` option threading, choice-shape validation. Adapt for spawn instead of fetch; drop the retry loop (master plan `docs/plans/2026-05-01-workflow-modularization.md:543` — CLI failures are usually deterministic, fail-fast and let the orchestrator's failure handling retry).
- LLM registry: `src/lib/llm/index.ts:6-16` — `Record<string, LlmProvider>` keyed by name; `getLlmProvider(name)` throws on unknown.
- Settings Zod schemas: `src/lib/settings.ts:12-100` (`SETTING_SCHEMAS` const). `getSetting`/`setSetting` at `:113-163`. Existing `llm_provider` enum at `:71`.
- Default settings: `src/lib/db.ts:11-46` (`DEFAULT_SETTINGS`). Existing `llm_provider: "openrouter"` at `:34`.
- `StepContext` interface: `src/worker/pipeline.ts:25-33` — current single `chat` field at `:30`. `buildStepContext` at `:148-162` (the function that threads `deps.chat` into per-step ctx at `:158`).
- `09-enrich-chunks.ts` call shape: `await chat([{ role: "user", content: prompt }], { db })` at `:62`. The `step.run` adapter at `:73-92` threads `ctx.chat` through (`chat: ctx.chat` at `:89`).
- Settings UI: `src/app/settings/settings-form.tsx`. `TABS` array at `:31-37` (entry `{ id: "openrouter", label: "OpenRouter" }` at `:34`). `TAB_FIELDS` at `:49-87` (openrouter fields at `:68` = `["llm_provider", "model_name", "style_prompt_default"]`). The `<TabsContent value="openrouter">` body at `:380-408` renders three fields: `llm_provider` `<SelectField>` (`:381-389`), `model_name` `<SelectField>` with hardcoded model list (`:390-401`), `style_prompt_default` `<TextArea>` (`:402-407`). Layout helpers `FieldGroup`/`FieldGrid`/`FieldLabel` at `:550-603`. Field components: `SelectField` `:705-738` (accepts `string[]` or `{label, value}[]`), `TextField` `:622-647` (with optional `hint`), `TextArea` `:649-670`.
- Collapsible primitive (already used in Google Flow's "Advanced" section at `:298-377`): `src/components/ui/collapsible.tsx` — Radix wrapper exporting `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent`.
- Test pattern for LLM providers: `__tests__/unit/lib/llm/openrouter.test.ts` — Vitest, in-memory DB via `createDb(":memory:")` + `seedDefaultSettings(db)`, `vi.fn().mockResolvedValue()` for `fetch` mocking, `retryDelayMs: 0` for deterministic retry tests.
- Spawn-faking precedent: `__tests__/unit/lib/align.test.ts:60-137` fakes `spawn` via dependency injection (a `spawnFn` parameter on the function under test). Phase 4's `claude-cli.ts` doesn't expose a `spawnFn` injection point on the `LlmProvider.chat` signature, so the new tests use `vi.mock("child_process")` instead — different mechanism, same idea.

**Other `ctx.chat` consumers (do NOT switch to `enrichChat`):**
- `01-research-outline.ts:109`, `02-research-characters.ts:61`, `03-write-hook.ts:77`, `04-write-chapters.ts:251` — script-module steps. Each file has a single `ctx.chat` site (the `step.run` adapter that threads it into the inner runner; the inner runners may make multiple LLM calls per invocation). `ctx.chat` correctly resolves to the snapshot's script provider.
- `generate-main-images-google-flow.ts:43`, `generate-hook-video-google-flow.ts:43` — image/video module steps that use `ctx.chat` for prompt rewriting. Per Invariant E, these continue to use `ctx.chat` (the script provider) after Phase 4.

**Confirmed absent (Phase 4 introduces):**
- `claude_cli_path`, `claude_cli_model`, `claude_cli_extra_args`, `enrich_chunks_llm_provider` — not declared in `SETTING_SCHEMAS` or `DEFAULT_SETTINGS`.
- No `vi.mock("child_process")` precedent in the test suite — Phase 4 establishes one. (The `align.test.ts` dependency-injection fake is a different mechanism; see Patterns above.)
- No `claude_cli` entry in `src/lib/llm/index.ts`'s `providers` record.

---

## Scope

**Doing:**
- `src/lib/llm/claude-cli.ts` (new) — `LlmProvider` implementing `chat` via `child_process.spawn`. Settings-driven config; no retry loop.
- Register `claude_cli` in `src/lib/llm/index.ts`.
- Add four global settings to `SETTING_SCHEMAS` and `DEFAULT_SETTINGS`: `enrich_chunks_llm_provider` (`z.enum(["openrouter", "claude_cli"])`), `claude_cli_path` (string, default `"claude"`), `claude_cli_model` (string, default `"claude-opus-4-7"`), `claude_cli_extra_args` (string, default `""`).
- Delete the `llm_provider` Zod schema from `SETTING_SCHEMAS` and its default from `DEFAULT_SETTINGS`. The DB row at key `llm_provider` becomes orphaned for existing dev DBs; harmless (no caller reads it after this phase).
- Add `enrichChat` field to `StepContext`. Rewire `resolveDeps`: `chat` from `snapshot.script_llm_provider`, `enrichChat` from `getSetting("enrich_chunks_llm_provider", db)`.
- Update `09-enrich-chunks.ts` to use `ctx.enrichChat`.
- Settings UI: rename the `openrouter` tab to `llm`. Inside the `llm` tab, three sections: General `FieldGroup` with `enrich_chunks_llm_provider` Select; OpenRouter Collapsible holding the existing `model_name` + `style_prompt_default` fields; Claude CLI Collapsible holding the three new fields with a help-line under `claude_cli_extra_args`.
- Drop the `"(coming in Phase 4)"` suffix on the `claude_cli` option in the workflow editor (Phase 2 Task 13 left this for Phase 4).
- Tests: provider unit (mocked spawn), integration (workflow with `claude_cli` runs script steps), enrich-chunks uses separate provider, Phase 3 schema-endpoint inline snapshot updated to include `claude_cli` in `providers.script`.

**Not doing:**
- Streaming Claude CLI output — master plan §Open Items. Phase 4 buffers stdout and returns the trimmed string.
- Quoted-string parsing for `claude_cli_extra_args` — whitespace split only via `extraArgs.split(/\s+/).filter(Boolean)` (master plan `docs/plans/2026-05-01-workflow-modularization.md:549`). A help-line under the field documents this. `shell-quote` upgrade is an Open Item.
- Promoting `enrich_chunks_llm_provider` to per-workflow — global only (master plan §Open Items). Per Invariant E, the rationale is in the README.
- Changing image/video steps' LLM resolution — Google Flow's `generate-*-google-flow.ts` continue to use `ctx.chat` per Invariant E. Phase 5 inherits this contract when it collapses the steps into provider registries.
- Re-snapshotting existing in-flight videos — Invariant B point 4 says snapshots are immutable after `queued`. Phase 1-onward snapshots already populate `script_llm_provider`, so the rewire is seamless for any pre-Phase-4 queued video. No data migration.
- Widening Phase 2's `WorkflowRowSchema` — the `script_llm_provider` enum already lists `["openrouter", "claude_cli"]` (Phase 2 Task 1).
- Touching Phase 3's `GET /api/workflows/schema` route code — `Object.keys(llmProviders)` automatically picks up the registered `claude_cli` (per Invariant D, Phases-that-touch). Only the inline snapshot test diffs.
- Any boot-time check that the `claude` binary exists — Phase 4 fails at first invocation (spawn ENOENT propagates via the spawn error event), not at boot. A pre-flight executable check is out of scope.

---

## Tasks

### Phase 4A — Provider implementation + registry

- [x] **Task 1: `src/lib/llm/claude-cli.ts` (new)**
  **Files:** `src/lib/llm/claude-cli.ts` (new)
  **What:** Export `claudeCliProvider: LlmProvider`. The `chat(messages, opts)` implementation:
  1. Resolve `db = opts.db ?? getDb()`.
  2. Read settings: `cliPath = getSetting("claude_cli_path", db)`, `model = opts.model ?? getSetting("claude_cli_model", db)`, `extraArgs = getSetting("claude_cli_extra_args", db)`. (`opts.model` override mirrors the openrouter precedent — `ChatOpts` already declares it at `src/lib/llm/types.ts:8-16`.)
  3. Build the prompt: `messages.map(m => m.content).join("\n\n")`. Roles are not preserved — the `claude` CLI's `-p` flag accepts a single prompt string. Multi-turn structuring is an Open Item (master plan §Open Items: "CLI provider streaming"); for v1 the four script steps use a single `user` message each, so concatenation is loss-free.
  4. Build the args: `["-p", prompt, "--model", model, ...parseArgs(extraArgs)]` where `parseArgs(s) = s.split(/\s+/).filter(Boolean)`.
  5. Call internal `spawnAndCapture(cliPath, args)`: wraps `child_process.spawn`, accumulates stdout chunks, accumulates stderr chunks, resolves with `stdout.trim()` on exit code 0, rejects with `new Error(\`claude exited with code ${code}: ${stderr}\`)` otherwise. Listens for the `"error"` event (e.g., ENOENT when `cliPath` is wrong) and rejects with the underlying error.
  **Context:** Modeled after `src/lib/llm/openrouter.ts:23-78` for the structural shape (env/setting reads, validation guard, single-shot call, descriptive error). Drop the 3-attempt exponential backoff (master plan `docs/plans/2026-05-01-workflow-modularization.md:543` — CLI failures are usually deterministic; let the orchestrator's per-step failure handling decide whether to retry). Keep `spawnAndCapture` private (file-local function); it's only used here. The trimmed-stdout convention matches what callers expect (the openrouter provider returns `choices[0].message.content` which is similarly normalized).

- [x] **Task 2: Register `claude_cli` in the LLM registry**
  **Files:** `src/lib/llm/index.ts`
  **What:** Add `claude_cli: claudeCliProvider` to the `providers` record at `:6-8`. Import `claudeCliProvider` from `./claude-cli`. After this change, `getLlmProvider("claude_cli")` returns the new provider; `Object.keys(providers)` is `["openrouter", "claude_cli"]`.
  **Context:** This single line widens `GET /api/workflows/schema`'s `providers.script` array automatically (Invariant D, Phase 4 row), unblocks the workflow editor's `claude_cli` option at runtime (Phase 2 Task 13's "(coming in Phase 4)" Select option), and is the only registry touch needed in this phase. Phase 3 Task 5's inline-snapshot test for the schema endpoint will diff — that's expected (Phase 3 documented it as deliberate churn).

### Phase 4B — Settings infrastructure

- [x] **Task 3: Add four new schemas to `SETTING_SCHEMAS`**
  **Files:** `src/lib/settings.ts`
  **What:** In `SETTING_SCHEMAS` (`:12-100`), add four entries:
  - `enrich_chunks_llm_provider: z.enum(["openrouter", "claude_cli"])`
  - `claude_cli_path: z.string()`
  - `claude_cli_model: z.string()`
  - `claude_cli_extra_args: z.string()`

  Schema-only — no transforms. `getSetting`/`setSetting` (`:113-163`) handle the SQLite TEXT round-trip without coercion since these are all strings/enums.
  **Context:** Pattern matches the existing string/enum entries in `SETTING_SCHEMAS` (e.g., `image_provider` enum at `:73`, `style_prompt_default` plain string). Adding to this single file extends `SettingsMap`/`SettingValue<K>` types automatically — `getSetting("enrich_chunks_llm_provider", db)` becomes type-safe at all call sites.

- [x] **Task 4: Add four new defaults to `DEFAULT_SETTINGS`; delete `llm_provider` default**
  **Status:** Add-portion done in Phase 4A commit `8776837`. Delete-portion landed at the end of Phase 4D paired with Task 5.
  **Files:** `src/lib/db.ts`
  **What:** In `DEFAULT_SETTINGS` (`:11-46`):
  - ~~Add: `enrich_chunks_llm_provider: "openrouter"`, `claude_cli_path: "claude"`, `claude_cli_model: "claude-opus-4-7"`, `claude_cli_extra_args: ""`.~~ (done in Phase 4A)
  - **Delete** the `llm_provider: "openrouter"` entry at `:34`. *(Deferred — see Status above.)*

  `seedDefaultSettings` uses `INSERT OR IGNORE`, so existing DB rows for `llm_provider` are preserved (orphaned but harmless). Fresh DBs from `npm run db:init` get only the four new keys, not `llm_provider`.
  **Context:** The default model `claude-opus-4-7` matches the master plan example (`docs/plans/2026-05-01-workflow-modularization.md:547`). It's a sensible v1 choice; users can override per-DB via the settings UI.

- [x] **Task 5: Delete `llm_provider` Zod schema**
  **Status:** Landed at the end of Phase 4D, paired with Task 4's delete-portion.
  **Files:** `src/lib/settings.ts`
  **What:** Remove the `llm_provider: z.enum(["openrouter"])` line at `:71`. After Tasks 7 (pipeline rewire) and 9 (settings UI rewrite) land, no caller references this key — removing the schema enforces that at compile time (TypeScript errors out any stray `getSetting("llm_provider", ...)`).
  **Context:** Order matters within Phase 4: Task 5 must land **after** Task 7 (deletes `pipeline.ts`'s `getSetting("llm_provider", db)` read) and Task 9 (deletes the `llm_provider` `<SelectField>` and removes the key from `TAB_FIELDS`). Otherwise the build breaks mid-task. The implementer should sequence as 1→2→3→4→6→7→8→9→10→5→11–14, or just hold this delete for the end of Phase 4B/C/D.

### Phase 4C — Pipeline wiring

- [x] **Task 6: Add `StepContext.enrichChat`**
  **Files:** `src/worker/pipeline.ts`
  **What:** In the `StepContext` interface (`:25-33`), add a new field after the existing `chat` (`:30`):
  ```
  enrichChat: (messages: ChatMessage[], opts?: ChatOpts) => Promise<string>;
  ```
  Same signature as `chat` — they're peers per Invariant E. Update `buildStepContext` (`:148-162`) to thread a new `deps.enrichChat` field through (alongside the existing `deps.chat` at `:158`).
  **Context:** Invariant E codifies the split: `chat` is for script-module steps (and image/video prompt rewriting), `enrichChat` is for `enrich_chunks` glue. Adding `enrichChat` as a peer rather than overloading `chat` makes the resolution path explicit at every call site — a step that needs LLM access picks the field corresponding to its semantic.

- [x] **Task 7: Rewire `resolveDeps` to use snapshot + global setting**
  **Files:** `src/worker/pipeline.ts`
  **What:** Two coordinated changes inside `resolveDeps`:

  **(a) Reorder `resolveDeps`'s body so the parsed snapshot is in scope before chat resolution.** Phase 1 Task 12 introduces a snapshot read + JSON parse but places it inside the `if (!steps)` block (which runs *after* the chat / tts / image provider resolution lines today). Phase 4 needs `snapshot.script_llm_provider` at chat-resolution time, so move the read+parse above the provider-resolution block. Result is roughly:
  ```
  const db = deps?.db ?? getDb();
  const projectsDir = ...;
  const promptsDir = ...;
  // NEW: read + parse snapshot once, used by both chat resolution and step materialization
  const snapshot = parseSnapshotFor(db, videoId);            // throws on null per Invariant B
  const chat       = deps?.chat       ?? getLlmProvider(snapshot.script_llm_provider).chat;
  const enrichChat = deps?.enrichChat ?? getLlmProvider(getSetting("enrich_chunks_llm_provider", db)).chat;
  const ttsProvider = ...;
  const imageProvider = ...;
  const steps = deps?.steps ?? materializeStepList(snapshot).map(slug => ...);
  ```
  The exact local name (`snapshot`, `wfSnapshot`, etc.) and helper-extraction are the implementer's choice; the constraint is that the snapshot be parsed once and used by both blocks.

  **(b) Replace** the current chat-resolution line (`chat: deps?.chat ?? getLlmProvider(getSetting("llm_provider", db)).chat` at `pipeline.ts:234-235`) with the two resolutions above. The provider lookup at `getLlmProvider("claude_cli")` no longer throws (Task 2 registered it), so a workflow with `script_llm_provider: "claude_cli"` queued before Phase 4 will start succeeding once Phase 4 deploys — its already-pinned snapshot field works without re-snapshotting.

  Add `enrichChat` to `ResolvedDeps` (`pipeline.ts:133-141`) alongside the existing `chat`. **`RunPipelineDeps` (`:125-127`) gets `enrichChat?` automatically** because it's derived as `Partial<Omit<StepContext, "log">>` — Task 6's `StepContext.enrichChat` propagates through. No explicit `RunPipelineDeps` edit needed; do not add one.
  **Context:** The other provider resolutions in `resolveDeps` (`ttsProvider`, `imageProvider`) are NOT touched by this phase; per Phase 1 Task 12's deferral note, those are still global-setting-driven and rewiring them to snapshot is out of Phase 4's scope. Phase 5 picks up `imageProvider`/`videoProvider` snapshot resolution alongside the registry collapse. The legacy comment block at `pipeline.ts:219-224` ("Provider lookups (`llm_provider`, `tts_provider`, `image_provider`) happen here") becomes stale — update to reflect the new resolution split (`script_llm_provider` from snapshot, `enrich_chunks_llm_provider`/`tts_provider`/`image_provider` from global settings).

- [x] **Task 8: `09-enrich-chunks.ts` switches to `ctx.enrichChat`**
  **Files:** `src/worker/steps/09-enrich-chunks.ts`
  **What:** At `:89`, change `chat: ctx.chat` → `chat: ctx.enrichChat`. No other change in the file. The inner `runEnrichChunks`'s local `EnrichChunksDeps.chat` parameter (`:15-18`) is typed `(messages, opts?: { db?: DatabaseType }) => Promise<string>`, which is structurally satisfied by `ctx.enrichChat`'s wider `(messages, opts?: ChatOpts) => Promise<string>` signature (extra optional fields on `ChatOpts` like `model` and `retryDelayMs` are ignored by the consumer).
  **Context:** This is the only step that switches. The other six `ctx.chat` consumers (`01`-`04`, `generate-*-google-flow.ts`) keep `ctx.chat` per Invariant E. Sanity-check post-edit: `Grep "ctx\.chat" src/worker/steps/` should return six hits, `Grep "ctx\.enrichChat" src/worker/steps/` should return one (this file).

### Phase 4D — Settings UI

- [x] **Task 9: Rename `openrouter` tab to `llm`; restructure into General + OpenRouter + Claude CLI sections**
  **Files:** `src/app/settings/settings-form.tsx`
  **What:** Four coordinated edits (the fourth is a one-liner; the renumbered tab id is the load-bearing change):
  1. **Tabs array (`:31-37`):** change `{ id: "openrouter", label: "OpenRouter" }` to `{ id: "llm", label: "LLM" }`. Position-stable (between `google-flow` and `ai33`).
  2. **`TAB_FIELDS` mapping (`:49-87`):** rename the `openrouter` key to `llm`. The new value is `["enrich_chunks_llm_provider", "model_name", "style_prompt_default", "claude_cli_path", "claude_cli_model", "claude_cli_extra_args"]`. Drop `"llm_provider"` from this list. The order matters for dirty-diff display in the form's "Unsaved changes" banner — keep enrich first (General), then OpenRouter fields, then Claude CLI fields.
  3. **Tab body render** (the `<TabsContent value="openrouter">` block at `:380-408` — currently renders `llm_provider` `<SelectField>`, `model_name` `<SelectField>`, `style_prompt_default` `<TextArea>`): rewrite to `<TabsContent value="llm">` containing:
     - One `<FieldGroup title="General">` containing a `<SelectField id="enrich_chunks_llm_provider" options={[{ label: "OpenRouter", value: "openrouter" }, { label: "Claude CLI", value: "claude_cli" }]} />`. Help-line under it: "LLM used by the `enrich_chunks` step. Global — applies to all workflows." (`SelectField` accepts the `{label, value}[]` form; see `:703` `SelectOption` type.)
     - One `<Collapsible>` labeled "OpenRouter" containing the existing `model_name` `<SelectField>` (preserve the hardcoded model list at `:394-399`) and the `style_prompt_default` `<TextArea>` — keep the field types the form already uses; **do not** convert either to a `<TextField>`.
     - One `<Collapsible>` labeled "Claude CLI" containing three `<TextField>`s for `claude_cli_path`, `claude_cli_model`, `claude_cli_extra_args`. Pass the help-line for `claude_cli_extra_args` via `TextField`'s existing `hint` prop (`:633` — already supports a `hint?: string` arg rendered as `<p className="text-xs text-muted-foreground">` at `:644`): `hint="Whitespace-separated tokens. Quoted strings not supported in v1 — use \`--flag value\` form, not \`--flag \"value with spaces\"\`."`.

  Delete the `llm_provider` `<SelectField>` block at `:381-389` entirely.

  4. **Deep-link compatibility:** The `?tab=openrouter` URL query is gated by `isTabId` (`:43-45`); after the rename it no longer matches, and `initialTab` (`:119-121`) silently falls back to the `comfyui` default. Acceptable — bookmarked links from before Phase 4 will land on the comfyui tab instead of erroring. No redirect/alias needed.
  **Context:** Collapsible primitive is the same one Google Flow's "Advanced" section uses (`:298-377`) — `<Collapsible><CollapsibleTrigger>…</CollapsibleTrigger><CollapsibleContent>…</CollapsibleContent></Collapsible>`. The trigger row in that example uses a `ChevronDown` icon plus a label; mirror it. Default-collapsed state is fine; the General section stays expanded by virtue of being a `FieldGroup` not a `Collapsible`. `FieldGroup` (`:550`) takes a `title` prop, not `label`. The General-section help-line for `enrich_chunks_llm_provider` is a paragraph below the `SelectField` (manual `<p className="text-xs text-muted-foreground">…</p>`) — `SelectField` does not currently expose a `hint` prop; an alternative is to add one (mirroring `TextField`'s) but that's a small refactor; a sibling `<p>` is the minimum-touch path.

- [x] **Task 10: Drop `"(coming in Phase 4)"` suffix on the editor's `claude_cli` option**
  **Files:** `src/app/workflows/[id]/edit/edit-form.tsx`
  **What:** In the `script_llm_provider` Select options (Phase 2 Task 13's `[{ value: "openrouter", label: "OpenRouter" }, { value: "claude_cli", label: "Claude CLI (coming in Phase 4)" }]`), change the second label to `"Claude CLI"`. No other change.
  **Context:** Phase 2 Task 13 explicitly left this as a Phase-4-removes-this hint. Now that the runtime works, the suffix becomes wrong — drop it to avoid user confusion.

### Phase 4E — Tests

- [x] **Task 11: Unit tests for `claude-cli.ts` provider via mocked `child_process.spawn`**
  **Status:** Test file landed alongside the provider in Phase 4A commit `8776837` (7 cases, all 6 spec behaviors plus a whitespace-only-extra-args edge case). Phase 4E only checked the box.
  **Files:** `__tests__/unit/lib/llm/claude-cli.test.ts` (new)
  **What:** Use `vi.mock("child_process")` to replace `spawn` with a controllable fake (returns an event-emitter-like object with `stdout`, `stderr`, and `.on("close" | "error", ...)` hooks). Each test passes its in-memory DB via `chat(msgs, { db })` so the provider's `opts.db ?? getDb()` fallback (Task 1 step 1) takes the explicit-`db` branch — avoids needing to mock `getDb()` per test. Cover:
  1. **Happy path:** `chat([{ role: "user", content: "hi" }], { db })` invokes `spawn` with `cliPath = "claude"`, `args[0] = "-p"`, `args[1] = "hi"`, `args[2] = "--model"`, `args[3]` matches the `claude_cli_model` setting (default `"claude-opus-4-7"` after `seedDefaultSettings`). Fake emits `stdout` chunks and `close(0)`; `chat` resolves to the trimmed concatenation.
  2. **Multi-message concat:** two messages get joined with `\n\n` as the prompt (`args[1]`).
  3. **`opts.model` override:** when `chat(msgs, { db, model: "claude-3.5-sonnet" })`, `args` includes that model instead of the setting value.
  4. **Extra args:** with `claude_cli_extra_args = "--max-turns 1 --verbose"` (set via `setSetting` on the in-memory DB), args end with `["--max-turns", "1", "--verbose"]`. Empty/whitespace-only setting yields no extra entries.
  5. **Non-zero exit:** fake emits `stderr` chunks then `close(1)`; `chat` rejects with an error containing "`exited with code 1`" and the captured stderr.
  6. **Spawn `error` event** (e.g., ENOENT for missing `claude` binary): fake emits `error(new Error("ENOENT"))`; `chat` rejects with that error.
  **Context:** Existing `__tests__/unit/lib/llm/openrouter.test.ts` is the structural template (in-memory DB via `createDb(":memory:") + seedDefaultSettings(db)`; vitest `vi.fn()` mocks). No precedent for `child_process.spawn` mocking in the suite — this test establishes one. Watch the import path: `vi.mock("child_process")` must be hoisted; if the test imports `claudeCliProvider` before the mock, vitest's auto-hoist handles it, but verify no side-effect import precedes the mock declaration.

- [x] **Task 12: Integration — workflow with `claude_cli` runs script steps via mocked CLI**
  **Status:** Landed in `__tests__/unit/worker/pipeline-claude-cli.test.ts`. Deviation from the plan-spec: step 04 (`write_chapters`) makes 2-3 chat calls (extract phase + per-batch chapter + per-batch story-so-far), so the per-step spawn count isn't 1:1 and the literal "spawn invoked four times" assertion is wrong. The test asserts `spawn.mock.calls.length >= 4` (proves every script step contributed at least one spawn) and that *every* spawn carries the seeded `claude_cli_model` — strictly stronger than pinning the fourth invocation alone.
  **Files:** `__tests__/unit/worker/pipeline-claude-cli.test.ts` (new) — mirrors the existing `__tests__/unit/worker/pipeline.test.ts` and `pipeline-workflow.test.ts` location convention. (No `__tests__/integration/` directory exists in the repo today.)
  **What:** Seed a workflow `comfyui-cli` (clone of `comfyui` with `script_llm_provider: "claude_cli"`) by directly inserting into the `workflows` and `workflow_steps` tables on the in-memory DB (it's a custom workflow, so `seedDefaultWorkflows` doesn't seed it; copy the four script-module slugs from `BUILTIN_WORKFLOWS[0].steps`). Mock `child_process.spawn` at the module boundary so every call returns a canned response. `createNewVideo` (which writes the `comfyui-cli` snapshot per Invariant B) → `transitionNewToQueued` → run the pipeline. Assert:
  - `spawn` was invoked four times (once per script step).
  - The fourth invocation's args include `--model` followed by the seeded `claude_cli_model` value.
  - Each of steps 01–04 has `video_steps.status = 'done'` after the run.
  - The video's snapshot (parsed from `videos.workflow_snapshot`) preserves `script_llm_provider: "claude_cli"`.

  **Where to stop:** Pass an explicit `steps` override to `runPipeline` containing only the four script steps from `REAL_STEPS`. This avoids running `assemble_script` (which would read non-existent chapter `.md` files since the spawn-mock returns a canned string, not a real markdown chapter) and avoids pulling in TTS/image/video providers. Test pattern reference: `pipeline-workflow.test.ts:84-100` already passes a custom `Step[]` array to `runPipeline`; mirror that.
  **Context:** Pattern reference at `__tests__/unit/worker/pipeline.test.ts` and `pipeline-workflow.test.ts` (existing tests use mocked `Step[]` arrays plus a fake `db`). For Phase 4, the test must seed real workflow + step DB rows so `resolveDeps` reads a real snapshot and `getLlmProvider("claude_cli")` resolves the registered provider. The mock is at `child_process.spawn` only — the rest of the chain (`getLlmProvider` → `claudeCliProvider.chat` → `spawnAndCapture` → `spawn`) runs as production code. Do **not** mock `getLlmProvider`, `chat`, or any LLM-layer code — that would defeat the integration test.

- [x] **Task 13: `enrich_chunks` reads from `enrich_chunks_llm_provider`**
  **Files:** `__tests__/unit/worker/steps/enrich-chunks.test.ts` (extend — file already exists; add cases for the chat→enrichChat split)
  **What:** Seed a video with `snapshot.script_llm_provider: "claude_cli"` and global setting `enrich_chunks_llm_provider: "openrouter"`. Mock both providers' `chat` with distinct return values. Run step 09. Assert:
  - The OpenRouter mock was called (because `enrich_chunks_llm_provider = "openrouter"`).
  - The Claude CLI mock was NOT called (this is a glue step, not script).

  Inverse case: flip the global setting to `claude_cli` mid-run between two videos; the second video's enrich call hits the Claude mock even though the first video's didn't. Proves the global setting is read live, not snapshot-pinned (Invariant E mutability column).
  **Context:** The test stubs `StepContext` directly rather than going through `resolveDeps` — pass a `ctx` with `chat` and `enrichChat` set to two distinct vi.fn(). Verifies the routing in `09-enrich-chunks.ts` (Task 8): the step calls `enrichChat`, not `chat`.

- [x] **Task 14: Update Phase 3 schema-endpoint inline snapshot**
  **Files:** `__tests__/api/workflows/schema/route.test.ts`
  **What:** Phase 3 Task 5 documented this as expected churn: `providers.script` shifts from `["openrouter"]` to `["openrouter", "claude_cli"]` once Task 2 registers the new provider. Run the test, accept the snapshot diff via `vitest -u`, commit. No test logic change.
  **Context:** Phase 3 Task 5's comment block ("Phase 4 will widen `providers.script` to `[\"openrouter\", \"claude_cli\"]` ... the inline snapshot is intentionally brittle ... the snapshot diff is the surface where reviewers see the contract change") authorizes this edit. Make it a single dedicated commit so the reviewer can audit the contract change in isolation.

---

## Done Criteria

(From master plan §Phase 4 Done criteria, `docs/plans/2026-05-01-workflow-modularization.md:575-579`, plus Invariant E enforcement.)

- A user toggles a workflow's `script_llm_provider` to `claude_cli`, queues a video, and the four script steps shell out to `claude -p ... --model ...`. The CLI is invoked via `child_process.spawn`, returning trimmed stdout. Non-zero exit fails the step with stderr in the error message.
- `enrich_chunks` runs against whichever provider `enrich_chunks_llm_provider` names at the moment the step executes, independent of any one workflow's `script_llm_provider`. Toggling the setting between videos takes effect immediately for the next enrich-step invocation (live, not snapshot-pinned per Invariant E).
- Settings UI shows a `LLM` tab (renamed from `OpenRouter`) with three sections: General (`enrich_chunks_llm_provider` Select), OpenRouter Collapsible (existing `model_name` + `style_prompt_default`), Claude CLI Collapsible (`claude_cli_path` + `claude_cli_model` + `claude_cli_extra_args`). The old `llm_provider` SelectField is gone. The help-line under `claude_cli_extra_args` documents the whitespace-split semantics.
- Workflow editor's `script_llm_provider` Select shows `Claude CLI` without the `(coming in Phase 4)` suffix.
- `getLlmProvider("claude_cli")` returns a registered provider; `Object.keys(llmProviders) === ["openrouter", "claude_cli"]`.
- `GET /api/workflows/schema` returns `providers.script: ["openrouter", "claude_cli"]` with no endpoint code change (Invariant D guarantee). Phase 3 Task 5's inline snapshot is updated and committed.
- The four `ctx.chat` script-module call-sites (`01-research-outline.ts`, `02-research-characters.ts`, `03-write-hook.ts`, `04-write-chapters.ts`) and the two image/video Google Flow steps (`generate-main-images-google-flow.ts`, `generate-hook-video-google-flow.ts`) keep using `ctx.chat`. Only `09-enrich-chunks.ts` uses `ctx.enrichChat`. Verified by grep across `src/worker/steps/`.
- Global `llm_provider` Zod schema is deleted from `SETTING_SCHEMAS`; default deleted from `DEFAULT_SETTINGS`. `Grep '"llm_provider"' src/` returns zero hits across runtime code (orphaned DB rows in dev databases are acceptable; new DBs from `npm run db:init` don't seed it). **Pattern note:** use the quoted-string form `'"llm_provider"'` rather than the bare `llm_provider`, because the bare form also matches the unrelated `snapshot.script_llm_provider` field reference in `pipeline.ts` and the `script_llm_provider` column name elsewhere — those are valid post-Phase-4 references and must NOT be flagged.
- `pipeline.ts:234-235`'s old `getLlmProvider(getSetting("llm_provider", db))` call is replaced by snapshot-driven `chat` resolution and a global-setting-driven `enrichChat` resolution. `Grep '"llm_provider"' src/worker/` (quoted form) returns zero hits.
- The `resolveDeps` body is reordered so the parsed snapshot precedes the provider-resolution block (Task 7 (a)). The snapshot read becomes unconditional (used by both chat and step resolution); tests that override `deps.steps` now also need a non-null `videos.workflow_snapshot` — already true for Phase 1 fixtures (Phase 1 Tasks 19–20 seed snapshots via `createNewVideo`).
- Existing tests pass with the single authorized exception of Task 14's snapshot regeneration (Phase 3's schema-endpoint inline snapshot diffs to reflect `providers.script: ["openrouter", "claude_cli"]`). The new tests in Tasks 11–13 pass; Task 14 reduces to a one-line `vitest -u` and a focused commit.

---

## References

- Cross-phase invariants: [`README.md`](README.md) — Invariant B (snapshot consumption), Invariant D (schema endpoint widening), Invariant E (per-module LLM resolution — introduced this phase)
