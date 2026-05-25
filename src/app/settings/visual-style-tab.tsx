"use client";

import type { AllSettings } from "@/lib/settings";
import { FieldGroup, Panel, TextArea } from "./field-primitives";
import { VisualStyleGallery } from "./visual-style-gallery";

interface VisualStyleTabProps {
  values: AllSettings;
  update: <K extends keyof AllSettings>(key: K, value: AllSettings[K]) => void;
  onDirtyChange: (dirty: boolean) => void;
  registerConfirmDiscard: (fn: (() => boolean) | null) => void;
}

/**
 * Visual Style tab. The gallery owns its own REST round-trips against
 * /api/visual-styles and reports its dirty state via the external
 * dirty channel. The two character-lock / style-lock textareas are
 * plain settings keys that ride the form's PATCH /api/settings flow
 * like every other tab — TAB_FIELDS["visual-style"] lists them so the
 * Save button + per-tab dirty-dot wire up automatically.
 */
export function VisualStyleTab({
  values,
  update,
  onDirtyChange,
  registerConfirmDiscard,
}: VisualStyleTabProps): JSX.Element {
  return (
    <div className="space-y-6">
      <VisualStyleGallery
        onDirtyChange={onDirtyChange}
        registerConfirmDiscard={registerConfirmDiscard}
      />
      <Panel className="space-y-4">
        <FieldGroup title="Character + style lock">
          <TextArea
            id="style_lock_description"
            label="Style lock description"
            value={values.style_lock_description}
            onChange={(v) => update("style_lock_description", v)}
            rows={5}
            hint="Appended verbatim to every assembled visual prompt. Tells the image model the fixed aesthetic. Leave empty to skip."
          />
          <TextArea
            id="character_lock_negative"
            label="Character lock negative"
            value={values.character_lock_negative}
            onChange={(v) => update("character_lock_negative", v)}
            rows={4}
            hint='Concatenated as "Negative: ..." onto every assembled visual prompt. Tells the image model what to avoid. Leave empty to skip.'
          />
        </FieldGroup>
      </Panel>
    </div>
  );
}
