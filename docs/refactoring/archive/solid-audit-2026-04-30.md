# SOLID Audit — 2026-04-30

**Mode**: Current-diff (unstaged + staged)
**Scope**: Video detail page reshape — `logExists` plumbing removed; artifact list regrouped under step-owned categories. 3 files changed in 1 domain.
**Domains analyzed**: domain-dashboard

## Summary

The route + page changes are net-positive cleanups: the `logExists` boolean that was plumbed from filesystem → API → server prop → client state is gone, replaced by treating `pipeline.log` as just another artifact in the new grouped panel. The substantive new code — ~95 lines of artifact-grouping logic — landed inside the already-large client component, which is where the SOLID concerns concentrate. The grouping introduces a hardcoded step-to-output-path mapping that duplicates knowledge already encoded in the worker step writers, and pushes `video-detail-client.tsx` past 730 lines.

## Findings Overview

| ID  | Domain           | Principle | Severity | Effort | Files                                       |
|-----|------------------|-----------|----------|--------|---------------------------------------------|
| 1   | domain-dashboard | SRP, DIP  | medium   | small  | `src/app/videos/[id]/video-detail-client.tsx` |
| 2   | domain-dashboard | OCP, DIP  | medium   | medium | `src/app/videos/[id]/video-detail-client.tsx` |
| 3   | domain-dashboard | SRP       | medium   | large  | `src/app/videos/[id]/video-detail-client.tsx` |
| 4   | domain-dashboard | OCP       | low      | small  | `src/app/videos/[id]/video-detail-client.tsx` |

## Findings Detail

### #1 — Artifact-grouping logic embedded in a client component
**Domain:** domain-dashboard | **Principle:** SRP, DIP | **Severity:** medium | **Effort:** small
**Files:** `src/app/videos/[id]/video-detail-client.tsx` (lines 60-154 for `humanizeStepName` / `ArtifactGroup` / `LOGS_GROUP_KEY` / `groupArtifactsByStep` / inner `ownerStep`)
**Recommendation:** Extract `humanizeStepName`, the `ArtifactGroup` type, `LOGS_GROUP_KEY`, `groupArtifactsByStep`, and the inner `ownerStep` into a new module under `src/lib/` — natural home is `src/lib/artifact-grouping.ts`, sibling to `project-files.ts` since both deal with the on-disk project layout. The client imports a pure function and calls it inside its existing `useMemo`.
**Why:** This is presentation-adjacent **business logic** about which step owns which file path — it has nothing to do with React state, polling, or rendering. Pulling it out follows the pattern already set by `lib/flow-summary.ts` (server-side aggregation lives in `lib/`, the client just renders it). The function is also pure and easy to unit-test in isolation; today it can only be exercised through React Testing Library against the whole component.

---

### #2 — `ownerStep()` duplicates step-output knowledge that lives in the worker steps
**Domain:** domain-dashboard | **Principle:** OCP, DIP | **Severity:** medium | **Effort:** medium
**Files:** `src/app/videos/[id]/video-detail-client.tsx` (the `ownerStep` function inside `groupArtifactsByStep`, lines ~92-128)
**Recommendation:** Make the step → output-path mapping derivable from a single source rather than a hand-maintained client-side switch. Two viable shapes: (a) each step in `src/worker/steps/` exports an `ownsArtifactPath(path: string): boolean` (or a `producedPaths: RegExp[]` declaration) and the workflow registry surfaces them; (b) in the near term, centralize a `STEP_PATH_RULES` table in the new `lib/artifact-grouping.ts` with one rule per step, so at least there's one mapping, not one hidden inside a client component. (a) closes the OCP loop; (b) is a clean staging point.
**Why:** The worker step writers — `01-research-outline.ts`, `03-write-hook.ts`, `05-assemble-script.ts`, `06-voiceover.ts`, `08-chunk.ts`, etc. — already declare exactly where each step writes its outputs. The new client function redeclares the same paths in a parallel switch chain. Adding a step, renaming an output, or relocating an artifact directory now requires updating both files; missing the second update doesn't fail loudly — files just silently fall into the "Other" bucket. This is the same OCP/DIP pattern the project gets right via `lib/image/provider.ts`; artifact grouping should follow suit instead of inventing a parallel registry.

---

### #3 — `video-detail-client.tsx` has grown to 730 lines mixing five+ concerns
**Domain:** domain-dashboard | **Principle:** SRP | **Severity:** medium | **Effort:** large
**Files:** `src/app/videos/[id]/video-detail-client.tsx`
**Recommendation:** Continue the modular split that's already underway in this directory (`_shared`, `video-actions.tsx`, `flow-accounts-strip.tsx`). Specifically: move `ModerationPanel` + `ModerationRow` to a sibling `flow-moderation-panel.tsx`; move the artifacts `<Card>` to `artifacts-panel.tsx`; move `FlowCountsRow` into a Flow-related sibling alongside the existing `FlowAccountsStrip`. The orchestrator keeps polling, top-level state, and overall layout. Pure helpers (`formatDuration`, `stepDuration`, `totalDuration`, `truncate`) can move to a single colocated `_utils.ts` or stay inline — they're not the concern.
**Why:** The skill describes this file as "a client orchestrator (owns polling + dialog state) plus per-table / per-action child components." That contract is already drifting — the orchestrator now also owns the moderation rendering tree, the flow progress card layout, and the artifact grouping/rendering. Editing any one of those means scrolling through unrelated code in the same file, and any change to the polling loop sits in the same diff as cosmetic adjustments to the moderation row. The split is mechanical (no interface changes), and several siblings are already in place — this is a continuation, not a redesign.

---

### #4 — `humanizeStepName` regex hardcodes the provider list
**Domain:** domain-dashboard | **Principle:** OCP | **Severity:** low | **Effort:** small
**Files:** `src/app/videos/[id]/video-detail-client.tsx` (lines 65-73)
**Recommendation:** Either source the provider suffix list from a single registry (image / video providers are already enumerated under `lib/image/`), or accept the coupling and add a one-line comment that the regex must track the provider-step naming convention. If item #1 lands and this function moves to `lib/artifact-grouping.ts`, fold a `PROVIDER_SUFFIXES` constant in alongside.
**Why:** The regex `/_(comfyui|google_flow)$/` silently fails open if a third image/video provider lands — the suffix won't strip, and `humanizeStepName` will return `"Generate main images veo"` instead of `"Generate main images"`. Not catastrophic, but it's the sort of cosmetic regression that lands without a test signal. Low severity because grouping still works (the step name stays unique), only the display is off.

## Priority Action Plan

### Immediate (high impact, small effort)
- **#1** — Extract artifact-grouping into `lib/artifact-grouping.ts`. Pure mechanical move; unblocks #2 and tightens the orchestrator file.

### Next Sprint (medium severity)
- **#2** — Centralize the step → output-path mapping so adding a step doesn't require editing a client component.
- **#3** — Continue the modular split of `video-detail-client.tsx` (moderation panel, artifacts panel, flow counts).

### Backlog
- **#4** — Lock `humanizeStepName`'s provider list to the registry, or just comment the coupling.

## How to Act on This

Pick the items you want to tackle and pass their IDs to `/create-plan`:

```
/create-plan Refactor items #1, #2 from docs/refactoring/solid-audit-2026-04-30.md
```

The plan will use this audit as input — each item has the files, the what, and the why already specified.

## Notes

**Positive**: removing the `logExists` plumbing was a clean SRP win. The previous design was a single boolean traversing four layers (filesystem `existsSync` → API field → server prop → client state) just to gate one link. Now logs are first-class artifacts inside the grouped panel — fewer moving parts, same UX, no special-case code path. Worth keeping in mind as the model for future "should we plumb a flag, or should we treat it as data?" questions.

**Cross-cutting**: items #1 and #2 reinforce the same principle the project already applies in `lib/ai/provider.ts` and `lib/image/provider.ts` — the dashboard is reaching back across that line for artifact ownership. Closing that loop also makes future provider/step additions cheaper.
