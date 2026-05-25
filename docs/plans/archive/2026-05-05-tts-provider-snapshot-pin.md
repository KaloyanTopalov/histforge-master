# Snapshot-pin TTS provider per workflow

## Overview

A video's `tts_provider` is captured into `videos.workflow_snapshot` at queue time but ignored at runtime — both `pipeline.ts` and `06-voiceover.ts` resolve the provider via `getSetting("tts_provider", db)`. Toggling Settings → TTS while a workflow is in flight redirects its voiceover step to whichever provider is global at the moment step 6 fires. This contradicts the snapshot-pinning invariant that already governs `script_llm_provider`, `image_provider`, and `video_provider`. Fix: read `tts_provider` from the snapshot, then optionally remove the now-dead global setting and its Settings UI.

## Current State

- **Snapshot already carries the field:** `WorkflowSnapshot.tts_provider` (`src/types.ts:161`) is populated by `resolveSnapshot` at `src/lib/workflows.ts:55` and pinned into `videos.workflow_snapshot` at create / queue / requeue / retry time (Invariant B).
- **Materializer already honors it correctly:** `materializeStepList` skips the voiceover slot when `snapshot.tts_provider === null` (`src/lib/workflows.ts:97`). So the snapshot field is non-null whenever the voiceover step is actually materialized.
- **Two runtime sites read the global setting instead of the snapshot:**
  - `src/worker/pipeline.ts:296-297` — `resolveDeps` builds `ResolvedDeps.ttsProvider` from `getSetting("tts_provider", db)`. The neighbouring image/video resolutions at lines 302-311 read from `snapshot.image_provider` / `snapshot.video_provider`. Comment at line 277-278 explicitly calls out the divergence.
  - `src/worker/steps/06-voiceover.ts:33-34` — when `runVoiceover` is called standalone (without `deps.provider`), it falls back to `getSetting("tts_provider", getDb())`. In production `step.run` always passes `ctx.ttsProvider` via `deps.provider` (`06-voiceover.ts:83-89`), so the fallback is test-only — but it's also the pattern the domain-pipeline SKILL warns against (`Don't read settings or open providers inside step.run`, `.claude/skills/domain-pipeline/SKILL.md:157`).
- **Editor & schema already model the workflow column:** `WorkflowRowSchema.tts_provider` accepts `"ai33" | "genaipro" | null` (`src/lib/workflows-schema.ts:27`); the workflow editor exposes the dropdown (`src/app/workflows/[id]/edit/edit-form.tsx:390-401`).
- **Voice tuning settings are correctly global:** `voice_id`, `voiceover_model_id`, `voice_stability`, `voice_similarity`, `voice_style`, `voice_speed`, `voice_use_speaker_boost` are read by both providers (`ai33.ts:77-87`, `genaipro.ts:77-86`). They stay global. Only the provider *selection* needs to move to the snapshot.
- **Precedent for vestigial globals:** `image_provider` and `video_provider` global settings still exist in `ENUM_VALUES` (`src/lib/settings-enums.ts:23`) and `TAB_FIELDS["comfyui"]` (`src/lib/settings-tabs.ts:23`) but no runtime code consumes them after the Phase 5 modularization — they linger as a dead form field. Phase 2 of this plan can either match that precedent (do nothing) or actively delete the `tts_provider` equivalents to remove the user-facing Settings switcher that motivated this fix.

## Scope

**Doing:**
- Resolve `ttsProvider` in `pipeline.ts:resolveDeps` from `snapshot.tts_provider`, mirroring how image/video are resolved at lines 302-311.
- Make `runVoiceover` consume `deps.provider` only — drop the global-setting fallback and the unused settings/db imports it requires.
- Update the comment block at `pipeline.ts:272-278` so the documented invariant matches the new behavior.
- Update `docs/histforge-spec.md` references that describe `tts_provider` as the runtime selector.
- (Phase 2, optional) Remove the global `tts_provider` setting (schema, default, enum, tabs registry) and the provider switcher / "Active / Idle" UI from the Settings TTS panel that triggered the original investigation.

**Not doing:**
- Changing the workflow editor dropdown — it already models the per-workflow choice correctly.
- Touching voice tuning settings (stability, similarity, style, speed, model id, voice id, speaker boost). Those remain global.
- Migrating existing snapshots — `tts_provider` is already populated for every snapshot ever written; no backfill needed.
- Removing `image_provider` / `video_provider` global settings even though they're equally vestigial. Out of scope.

## Tasks

### Phase 1: Snapshot-pin at the orchestrator (fixes the bug)

- [x] **Task 1: Resolve `ttsProvider` from the snapshot in `resolveDeps`**
  **Files**: `src/worker/pipeline.ts`
  **What**: `ResolvedDeps.ttsProvider` must come from `snapshot.tts_provider`, not `getSetting("tts_provider", db)`. The snapshot is already parsed at `pipeline.ts:289`. Mirror the null-handling cast used by the image/video resolutions immediately below — if `snapshot.tts_provider` is null the slot is skipped at materialization, so the cast is safe (the `ctx.ttsProvider` field is never read).
  **Context**: Replace the line at `pipeline.ts:296-297`. The comment block at `pipeline.ts:272-278` currently says `tts_provider stays global-setting-driven; image_provider and video_provider read from the snapshot` — rewrite that paragraph to say all three module providers are snapshot-pinned, leaving only `enrich_chunks_llm_provider` as the live-global exception (Invariant E). Edge case: a snapshot from before the field existed cannot occur because `WorkflowSnapshot.tts_provider` has been part of every snapshot ever written by `resolveSnapshot` (`src/lib/workflows.ts:55`); no migration is needed.

- [x] **Task 2: Drop the global-setting fallback in `06-voiceover.ts`**
  **Files**: `src/worker/steps/06-voiceover.ts`
  **What**: `runVoiceover` must require `deps.provider`. Remove the `getTtsProvider(getSetting("tts_provider", getDb()))` fallback at line 33-34, drop the now-unused `getTtsProvider`, `getSetting`, and `getDb` imports at lines 4-6, and tighten the `VoiceoverDeps.provider` field accordingly (`provider: TtsProvider`, no longer optional). Update the JSDoc at lines 17-26 if it still alludes to the setting lookup.
  **Context**: `step.run` already passes `ctx.ttsProvider` (`06-voiceover.ts:86`), so production callers are unaffected. Tests in `__tests__/unit/worker/steps/voiceover.test.ts` always pass a mock provider via `deps.provider` (lines 57, 87, 116, 138), so no test changes are needed — but rerun the file to confirm. The domain-pipeline SKILL note at `.claude/skills/domain-pipeline/SKILL.md:157` (`Don't read settings or open providers inside step.run`) is the rationale for making this required.

- [x] **Task 3: Update the spec to match the new runtime contract**
  **Files**: `docs/histforge-spec.md`
  **What**: The line at `:446` (`The active provider is determined by the tts_provider setting`) and the line at `:1166` (`Provider registry selects by tts_provider`) describe the old global-setting behavior. Rewrite both to say the active provider is selected from `snapshot.tts_provider`, mirroring how the spec already describes `image_provider` / `video_provider`. Also touch up the Settings page section at `:984` — its "the active provider … is picked via a radiogroup" sentence becomes inaccurate after Phase 1 even if Phase 2 is deferred (the radiogroup still renders but the worker no longer reads it); reword it to note the global setting is vestigial pending Phase 2. Leave the Settings table at `:275` (the row is real until Phase 2 deletes the schema entry) and the workflow-row spec at `:1130` alone here — those are Phase 2 / already-correct.
  **Context**: Spec is the canonical reference per CLAUDE.md, so doc drift on this exact contract is what made the bug invisible for so long (Phase 1 of the workflow modularization explicitly deferred the rewiring at `docs/plans/archive/workflow-modularization/phase-1.md:339`). Keep the doc edit tight: it's a fact change, not a rewrite.

### Phase 2: Remove the vestigial global setting and the Settings switcher (optional)

- [x] **Task 4: Delete the global `tts_provider` setting**
  **Files**: `src/lib/settings.ts`, `src/lib/db.ts`, `src/lib/settings-enums.ts`, `src/lib/settings-tabs.ts`, `__tests__/unit/lib/settings.test.ts`, `__tests__/components/settings/settings-form.test.tsx`
  **What**: Drop only the DEFAULTS entry at `src/lib/db.ts:33` (do **not** touch the `BUILTIN_WORKFLOWS` rows at `src/lib/db.ts:91` and `:108` — those are workflow-row seeds whose `tts_provider` column is the per-workflow choice that drives runtime after Phase 1 and must keep its `"ai33"` value). Drop the schema entry at `src/lib/settings.ts:65`, the enum entry at `src/lib/settings-enums.ts:48` (the `tts_provider` array), and the field reference inside `TAB_FIELDS["tts"]` at `src/lib/settings-tabs.ts:49`. Remove the matching assertions in `__tests__/unit/lib/settings.test.ts` at lines 52, 125, 127, 182, and the `initialSettings.tts_provider` fixture at `__tests__/components/settings/settings-form.test.tsx:52` so the seed shape stays in sync with `AllSettings`. Leave the `tts/` subtree (`src/lib/tts/meta.ts`, `src/lib/tts/index.ts`, `src/lib/tts/ai33.ts`, `src/lib/tts/genaipro.ts`) untouched — those are still consumed via `getTtsProvider(snapshot.tts_provider)` after Phase 1.
  **Context**: After Phase 1 nothing reads the setting; this task removes the now-orphan column-ish state. Confirm zero remaining `getSetting(.*tts_provider` matches in `src/` before merging. The `voice_id`, `voiceover_model_id`, and voice-tuning settings stay; only the `tts_provider` global itself is removed. Workflow-row `tts_provider` (schema, snapshot, seed values) is unaffected.

- [x] **Task 5: Remove the provider switcher from the Settings TTS panel**
  **Files**: `src/app/settings/tts-settings.tsx`, `__tests__/components/settings/settings-form.test.tsx`
  **What**: Delete the `ProviderSwitch`, `ProviderPill`, and `ActiveProviderBanner` components from `tts-settings.tsx` (lines 175-350) along with the `TAGLINES` map (lines 36-39), the `active`/`tts_provider` derivations at lines 57, 62-69, and the `TtsProviderId` / `TtsProviderMeta` / `TTS_PROVIDER_META` imports that become unused. Replace the deleted top-of-panel UI with a single neutral header that introduces the voice-tuning controls, or fold the section heading into "Voice & Model". Update the field-rendering test at `__tests__/components/settings/settings-form.test.tsx:290-313` ("renders all eight TTS fields when the TTS tab is active"): drop the radiogroup assertions at lines 294-299, retitle the test from "eight" to "seven", and confirm the remaining six voice-tuning + speaker-boost assertions still pass.
  **Context**: This is the UX fix that prompted the investigation — without it, the TTS tab still shows a misleading "Active / Idle" provider switcher that no longer corresponds to anything the worker reads. The user-design-taste memory ([memory/user_design_taste.md](../../.claude/projects/C--Users-alexa-Desktop-histforge/memory/user_design_taste.md)) calls out simplistic, scannable layouts and "derive-don't-duplicate inputs" — keep the replacement minimal, not a redesign. After this task the TTS tab shows only what's actually shared across providers (voice id, model, sliders, speaker boost), which is the truth of what's global.

- [x] **Task 6: Finish the spec update**
  **Files**: `docs/histforge-spec.md`
  **What**: Drop the `tts_provider` row from the global-settings table at `:275`. Re-edit the Settings TTS panel description at `:984` (which Task 3 already hedged) so it now states the active provider is chosen per workflow in the workflow editor and the Settings panel only carries the shared voice configuration.
  **Context**: Pairs with Task 4. Leave the workflow-row spec at `:1130` and the per-step contract at `:446` alone — Task 3 already updated step 6, and the workflow row's `tts_provider` is exactly what now drives runtime.

## References

- `src/worker/pipeline.ts:289-311` — snapshot read + provider resolution block; image/video pattern to mirror.
- `src/worker/steps/06-voiceover.ts:27-60` — step entry with the global-setting fallback to remove.
- `src/lib/workflows.ts:42-109` — `resolveSnapshot` and `materializeStepList`; confirms `tts_provider` is already snapshot-pinned and the materializer already honors null.
- `src/types.ts:157-165` — `WorkflowSnapshot` shape.
- `src/lib/workflows-schema.ts:27` — workflow row schema accepts `"ai33" | "genaipro" | null`.
- `.claude/skills/domain-pipeline/SKILL.md:157` — "Don't read settings or open providers inside step.run" rationale.
- `docs/plans/archive/workflow-modularization/phase-1.md:89-90,339-340` — original deferral note for `tts_provider` rewiring; this plan closes it.
- `docs/research/2026-05-04-tts-providers.md:125,148` — research note that documented the same divergence.
