// YouForge Flow — settings schema
// Single source of truth for every chrome.storage.local-backed tunable.
// Loaded as a classic script in two contexts:
//   - service worker — via src/background.js importScripts after
//     src/constants.js (so MAX_CONCURRENT_MAX is in scope for the
//     concurrency normalize closure), before src/settings.js.
//   - popup           — via popup.html <script> tags after
//     src/constants.js, before popup.js.
// Both contexts must load src/constants.js first; the schema's
// normalize closures reference symbols declared there.
//
// Adding a tunable means appending one entry here; settings.js
// reads/coerces it and popup.js renders it (when popup.id is set).
//
// Entry shape: { key, default, kind, enumValues?, normalize?, popup? }
//   key         storage key in chrome.storage.local; also the public
//               getSetting(key) name.
//   default     in-memory cache seed before loadSettings runs and the
//               value getters return when storage holds nothing valid.
//               Defaults are sentinels and are NOT subjected to kind
//               coercion (so a kind: 'string' entry can declare
//               default: '' for "unset", even though
//               coerceSettingValue rejects '' from storage).
//   kind        'string' | 'number' | 'boolean' | 'enum' — applied to
//               STORAGE values only via coerceSettingValue. For
//               'string', empty values from storage are rejected.
//   enumValues  required when kind === 'enum'.
//   normalize   optional (value) => value transform applied after kind
//               coercion succeeds. Used to enforce post-coerce
//               invariants (e.g. concurrency clamp). Runs in both the
//               loadSettings and setSetting paths so the same
//               invariant holds regardless of write origin.
//   popup       { id, label, group?, min?, step? } — present iff the
//               popup's Advanced fieldset surfaces this knob. id is
//               the generated <input> id. group is the section title
//               the field is rendered under (popup.js groups by it).
//               min defaults to 1, step defaults to 1. popup.js's
//               ADVANCED_NUMERIC_FIELDS derivation additionally
//               requires kind === 'number' today.

const SETTINGS_SCHEMA = [
  // Webhooks + identity
  { key: 'pollUrl', default: '', kind: 'string' },
  { key: 'resultUrl', default: '', kind: 'string' },
  { key: 'statusUrl', default: '', kind: 'string' },
  { key: 'projectUrl', default: '', kind: 'string' },
  { key: 'operationStartedUrl', default: '', kind: 'string' },
  { key: 'accountToken', default: '', kind: 'string' },

  // Mode + concurrency
  { key: 'generationMode', default: 'image', kind: 'string' },
  // Per-bucket concurrency ceilings. Two buckets ('image', 'video') run
  // independently so a slow video task can't starve fast image polls
  // (see ADR 0005). The normalize hook keeps each value in
  // [1, MAX_CONCURRENT_MAX]; MAX_CONCURRENT_MAX comes from
  // src/constants.js. Image defaults higher (5) than video (3) because
  // image tasks turn over ~10× faster, so equal counters would tilt
  // rate-limit pressure toward video.
  { key: 'imageConcurrency', default: 5, kind: 'number',
    normalize: (n) => Math.max(1, Math.min(MAX_CONCURRENT_MAX, Math.floor(n))) },
  { key: 'videoConcurrency', default: 3, kind: 'number',
    normalize: (n) => Math.max(1, Math.min(MAX_CONCURRENT_MAX, Math.floor(n))) },

  // Per-task executor settings
  { key: 'outputCount', default: 1, kind: 'number' },
  { key: 'aspectRatio', default: 'landscape', kind: 'string' },
  { key: 'imageModel', default: 'NARWHAL', kind: 'string' },
  { key: 'videoModel', default: 'fast', kind: 'string' },
  { key: 'imgUpscale', default: 'none', kind: 'string' },
  { key: 'vidUpscale', default: 'none', kind: 'string' },

  // Character lock — a Google Flow media ID (UUID) the operator pastes
  // into the popup. When set, every image task prepends it to imageInputs
  // as IMAGE_INPUT_TYPE_REFERENCE with no upload step. Empty means no
  // lock. Coercion path rejects '' (kind:'string' contract), so clearing
  // the lock goes through the dedicated setCharacterLockReference action
  // in messages.js — same escape hatch updateWebhooks uses for ''.
  { key: 'characterLockReference', default: '', kind: 'string' },

  // Logging + notifications
  { key: 'verboseLogging', default: false, kind: 'boolean' },
  { key: 'notificationsEnabled', default: true, kind: 'boolean' },

  // Polling cadence (task queue + video-status loop)
  { key: 'taskPollIntervalSec', default: 10, kind: 'number',
    popup: { id: 'task-poll-interval-sec', label: 'Task poll interval (sec)', group: 'Polling' } },
  { key: 'videoPollBaseSec', default: 3, kind: 'number',
    popup: { id: 'video-poll-base-sec', label: 'Video poll base (sec)', group: 'Polling' } },
  { key: 'videoPollMaxSec', default: 10, kind: 'number',
    popup: { id: 'video-poll-max-sec', label: 'Video poll max (sec)', group: 'Polling' } },
  { key: 'videoPollMaxAttempts', default: 120, kind: 'number',
    popup: { id: 'video-poll-max-attempts', label: 'Video poll max attempts', group: 'Polling' } },
  { key: 'videoPollStepFactor', default: 0.05, kind: 'number' },
  { key: 'videoPollJitterMs', default: 500, kind: 'number' },
  { key: 'progressEventEveryN', default: 6, kind: 'number',
    popup: { id: 'progress-event-every-n', label: 'Progress event every N polls', group: 'Polling' } },

  // Retry counts
  { key: 'webhookMaxRetries', default: 3, kind: 'number',
    popup: { id: 'webhook-max-retries', label: 'Webhook max retries', group: 'Retries', min: 0 } },
  { key: 'upscaleMaxAttempts', default: 3, kind: 'number',
    popup: { id: 'upscale-max-attempts', label: 'Upscale max attempts', group: 'Retries' } },
  { key: 'uploadMaxRetries', default: 2, kind: 'number',
    popup: { id: 'upload-max-retries', label: 'Upload max retries', group: 'Retries', min: 0 } },
  { key: 'sessionReFetchRetries', default: 2, kind: 'number',
    popup: { id: 'session-refetch-retries', label: 'Session re-fetch retries', group: 'Retries', min: 0 } },

  // Network timeouts (seconds)
  { key: 'imageRequestTimeoutSec', default: 30, kind: 'number',
    popup: { id: 'image-request-timeout-sec', label: 'Image request timeout (sec)', group: 'Timeouts' } },
  { key: 'videoRequestTimeoutSec', default: 60, kind: 'number',
    popup: { id: 'video-request-timeout-sec', label: 'Video request timeout (sec)', group: 'Timeouts' } },
  { key: 'uploadTimeoutSec', default: 60, kind: 'number',
    popup: { id: 'upload-timeout-sec', label: 'Upload timeout (sec)', group: 'Timeouts' } },
  { key: 'mediaFetchTimeoutSec', default: 45, kind: 'number',
    popup: { id: 'media-fetch-timeout-sec', label: 'Media fetch timeout (sec)', group: 'Timeouts' } },

  // Throttling + circuit breaker
  { key: 'launchStaggerMs', default: 500, kind: 'number',
    popup: { id: 'launch-stagger-ms', label: 'Launch stagger (ms)', group: 'Throttling', min: 0, step: 50 } },
  { key: 'circuitBreakerThreshold', default: 5, kind: 'number',
    popup: { id: 'circuit-breaker-threshold', label: 'Circuit-breaker threshold', group: 'Throttling' } },
  { key: 'rateLimitCooldownMinutes', default: 10, kind: 'number',
    popup: { id: 'rate-limit-cooldown-min', label: 'Rate-limit cool-off (min)', group: 'Throttling' } },
  { key: 'creditsMinThreshold', default: 0, kind: 'number',
    popup: { id: 'credits-min-threshold', label: 'Credits min threshold', group: 'Throttling', min: 0 } },
];
