/**
 * DistroKid-related constants shared across the API route, the dashboard
 * settings form, and tests. Pure data — no DB or runtime imports.
 */

/** Exact phrase the operator must type to flip distrokid_dry_run=false via
 *  PATCH /api/settings. Defense-in-depth complement to step 06's hard-block. */
export const LIVE_MODE_CONFIRM_PHRASE =
  'I understand this triggers real DistroKid releases';
