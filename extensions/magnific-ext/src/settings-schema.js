// Magnific HITL — settings schema
// Single source of truth for every chrome.storage.local-backed tunable.
// Loaded as a classic script in the service worker only — via
// background.js importScripts, after constants.js (so
// DEFAULT_POLL_INTERVAL_SEC resolves) and before settings.js. The popup
// reads the same chrome.storage.local keys directly with a hardcoded
// key list on open (see popup.js loadConfig), but writes go through the
// message router (updateWebhooks / setVerboseLogging /
// setPollIntervalSec) so the SW remains the sole storage writer. The
// popup does not import this schema.
//
// Adding a tunable means appending one entry here; settings.js
// reads/coerces it on the SW side, and the popup is updated
// independently to surface it.
//
// Entry shape: { key, default, kind, enumValues?, normalize? }
//   See youforge-flow/src/settings-schema.js for the full contract,
//   including the optional `popup` field that drives its auto-rendered
//   Advanced fieldset. magnific-ext doesn't use the auto-render path
//   yet (popup.html is hand-built), so no entry here carries `popup`.
//   The magnific-ext shape is a strict subset of youforge-flow's (no
//   concurrency buckets, no credits poller, no Google-specific knobs).

const SETTINGS_SCHEMA = [
  // Connection
  { key: 'histforgeDomain', default: '', kind: 'string' },
  { key: 'magnificToken', default: '', kind: 'string' },

  // Derived webhook URLs. The popup builds these from
  // histforgeDomain + magnificToken and writes them via updateWebhooks
  // (bypassing kind: 'string' coercion so clearing a URL with '' works).
  // The SW reads these directly instead of re-deriving — same pattern as
  // youforge-flow's pollUrl / resultUrl / statusUrl / projectUrl.
  { key: 'nextTaskUrl', default: '', kind: 'string' },
  { key: 'submitResultUrl', default: '', kind: 'string' },
  { key: 'statusUrl', default: '', kind: 'string' },
  { key: 'queueSummaryUrl', default: '', kind: 'string' },

  // Poll cadence
  { key: 'pollIntervalSec', default: DEFAULT_POLL_INTERVAL_SEC, kind: 'number',
    normalize: (n) => Math.max(5, Math.floor(n)) },

  // Logging
  { key: 'verboseLogging', default: false, kind: 'boolean' },
];
