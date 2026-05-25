/**
 * Known Suno model identifiers (the `mv` field of the
 * /api/generate/v2-web/ payload). Used by the dashboard to render a
 * dropdown for `channel.suno_model` instead of forcing the operator to
 * remember opaque strings.
 *
 * The list is curated, NOT exhaustive — Suno ships new models on their own
 * cadence and renames them. When a new flagship lands, capture its `mv`
 * string from DevTools (one Custom-tab generation, find the v2-web/ POST,
 * copy the `mv` value), then add it here. The dropdown shows these
 * curated options plus an "Other / custom..." escape for any string the
 * operator pastes manually.
 *
 * Custom models (Suno's "personas as fine-tuned models") are NOT a separate
 * API field — they ride on `mv` with the syntax `chirp-custom:<uuid>`. So
 * the user's custom models go in this same list.
 */
export type SunoModelOption = {
  /** The exact string Suno's API expects in the `mv` field. */
  value: string;
  /** Operator-friendly name shown in the dropdown. */
  label: string;
  /** Optional one-line note shown after the label (e.g., "current default"). */
  hint?: string;
};

export const SUNO_MODELS: readonly SunoModelOption[] = [
  {
    value: 'chirp-fenix',
    label: 'Fenix',
    hint: 'previous flagship; longer single-shot songs, strong vocal quality',
  },
  {
    value: 'chirp-crow',
    label: 'v5 (Crow)',
    hint: 'newest model as of late 2025',
  },
  {
    value: 'chirp-custom:b24fbc2b-04b8-4838-8029-8e9489db3d4b',
    label: 'Kane Victor (custom)',
    hint: 'fine-tuned voice/style — tuned on your own Suno account',
  },
];

/** True when the given string isn't one of the curated options. */
export function isCustomSunoModel(value: string): boolean {
  return !SUNO_MODELS.some((m) => m.value === value);
}
