/**
 * Centralized banner-key constants — source of truth for WRITES to the
 * three Flow operator-attention settings. All `setSetting()` write sites
 * (both `set` and `clear`) go through these constants:
 *
 *   - The set writes inside FlowLifecycle methods that pair an account
 *     pause/recovery transition with a banner flag (`handleServiceOverload`,
 *     `handleCreateProjectFailed`, the relogin-needed clear inside
 *     `claimNextTask`).
 *   - The clear writes at the dismiss routes (`clear-create-project-failed`,
 *     `clear-relogin-needed`, the `status` endpoint's banner clear).
 *
 * Banner READ sites intentionally stay on string literals per
 * ADR-0007 §5 ("banner setSetting writes stay inline") and the followups
 * doc §1 known-gap entry. The reader surface (videos-page-state,
 * videos/[id]/page.tsx, lib/db.ts, lib/settings.ts, settings-tabs,
 * settings/google-flow-tab) reads `settings` rows by literal key and is
 * therefore out of scope here.
 */
export const FlowBannerKeys = {
  serviceOverloadUntil: "flow_service_overload_until",
  createProjectFailed: "flow_create_project_failed",
  reloginNeeded: "google_flow_relogin_needed",
} as const;
