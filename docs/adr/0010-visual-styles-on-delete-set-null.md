---
status: accepted
date: 2026-05-18
---

# Visual styles use `ON DELETE SET NULL` because the snapshot insulates running jobs

## Context

The Visual Style settings tab is being replaced with a CRUD gallery of named visual-style prompts. Operators pick one per video on the `/videos` creation modals; the choice is stored on the `videos` row as `visual_style_id` (FK) plus `visual_style_snapshot` (full-row JSON pinned at create and re-pinned at `transitionNewToQueued`). Step 09 (`generate_visual_prompts`) reads the snapshot — never the live gallery row — and injects `snapshot.prompt ?? ""` into the `style_prompt` template variable.

The closest precedent is the `workflows` registry: `videos.workflow_id` is `NOT NULL` with `ON DELETE RESTRICT`, and a `countVideosUsingWorkflow` repo function gates deletion in the UI. The `videos.workflow_snapshot` column was added so running jobs are insulated from gallery edits, but the FK semantics were not relaxed to match — RESTRICT and snapshot together belt-and-braces the in-flight-job guarantee.

For `visual_styles` we want operators to delete freely while iterating. The question is whether to mirror `workflows` (RESTRICT + count-gate UI) or relax to `SET NULL` now that the snapshot is the authoritative runtime source.

Descriptive research of the current setting, the per-video flow, and the workflows precedent is in [`docs/research/2026-05-18-visual-style-gallery.md`](../research/2026-05-18-visual-style-gallery.md).

## Decision

1. **`videos.visual_style_id` is `TEXT NULL` with `ON DELETE SET NULL`.** Operators can delete any gallery row at any time. Referencing videos keep their snapshot; their FK column becomes `NULL`.

2. **Display reads the title from the snapshot, not from a join.** The `/videos/[id]` detail page shows `JSON.parse(visual_style_snapshot).title ?? "Default"`. This keeps the displayed style attribution stable across gallery deletes for finished videos.

3. **No `countVideosUsingStyle` repo function and no delete-gating UI.** Delete is unconditional from the operator's perspective; a `ConfirmDialog` is the only friction.

4. **Snapshot is the authoritative runtime contract.** Step 09 reads `videos.visual_style_snapshot.prompt`; it never joins to `visual_styles`. `NULL` snapshot → empty `style_prompt` template variable (matches the "Default (no style)" UI option, which maps to `visual_style_id: null`).

## Considered options (rejected)

**Mirror `workflows`: `ON DELETE RESTRICT` + `countVideosUsingStyle` + UI gate.** Rejected because the snapshot was specifically added to remove the safety argument for RESTRICT. The combination would force operators through a "can't delete — 4 videos use this" flow whose only benefit (join-time integrity for finished videos' style attribution) is recovered for free by reading the title from the snapshot. The repo function, the UI gate, and the friction would all pay rent for a guarantee the snapshot already provides.

**`ON DELETE CASCADE`.** Rejected immediately — deleting a style would delete videos. Not even adjacent to what operators expect.

**Builtin `is_builtin = 1` "Default" row with `id = 'default'`, FK `NOT NULL`.** Rejected because it imports the `workflows` lifecycle (`is_builtin`, `enabled`, version-gating mutations) just to encode "no style chosen." A nullable FK encodes the same thing structurally without dragging in lifecycle fields. It also makes the builtin row a tempting place to put a non-empty house style, which would silently reintroduce the `style_prompt_default` problem under a new name.

## Consequences

- **Divergence from `workflows` FK semantics is intentional and visible.** A future reader inspecting the schema will see `videos.workflow_id` (NOT NULL, RESTRICT) next to `videos.visual_style_id` (NULL, SET NULL). This ADR is the answer to "why the inconsistency?": workflows pre-date the snapshot-as-authoritative-source pattern and keep RESTRICT as legacy belt-and-braces; visual styles ship with snapshot as the primary mechanism and need only one of the two.
- **The snapshot column carries the title for display.** Any UI that shows a video's visual style reads from the snapshot. Joining `videos` to `visual_styles` to display the title is wrong — it would render "Default" for any video whose style was later deleted, even though the snapshot still has the original title.
- **The migration story is one DELETE.** No backfill, no count-gating, no soft-delete tombstone needed. The existing `style_prompt_default` setting row is dropped; in-flight videos keep their NULL snapshot and get an empty style prompt (test data only at the time of this ADR, so no production loss).
- **Spec entries at §4 (settings table), §6.3 (step 09 input), §11 (style prompt source), and §16.1 (Visual Style tab description) update to reflect the new source: `videos.visual_style_snapshot.prompt` rather than `settings.style_prompt_default`.**
- **Out of scope of this ADR:** the gallery UI layout (master-detail), the disclosure-preview in the creation modals, alphabetical ordering, warn-before-discard semantics, and the `auto-select-after-create` / `select-next-after-delete` micro-UX — all separately decided in the same design conversation but not load-bearing schema choices that need an ADR record.
