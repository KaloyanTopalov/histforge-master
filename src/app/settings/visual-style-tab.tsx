"use client";

import { VisualStyleGallery } from "./visual-style-gallery";

interface VisualStyleTabProps {
  onDirtyChange: (dirty: boolean) => void;
  registerConfirmDiscard: (fn: (() => boolean) | null) => void;
}

/**
 * Thin wrapper around the gallery. The tab no longer owns any settings
 * fields — the gallery component talks to /api/visual-styles directly
 * and reports its dirty state upward via the SettingsForm external
 * dirty channel (see TAB_FIELDS["visual-style"] being empty).
 */
export function VisualStyleTab({
  onDirtyChange,
  registerConfirmDiscard,
}: VisualStyleTabProps): JSX.Element {
  return (
    <VisualStyleGallery
      onDirtyChange={onDirtyChange}
      registerConfirmDiscard={registerConfirmDiscard}
    />
  );
}
