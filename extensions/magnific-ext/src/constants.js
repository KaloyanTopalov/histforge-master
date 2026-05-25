// Magnific HITL - shared constants
// Service-worker-wide values referenced by multiple modules. Loaded
// early in the importScripts chain so every downstream module
// (settings-schema.js in particular) can see them. The popup also
// loads this via a <script> tag in popup.html so DEFAULT_POLL_INTERVAL_SEC
// is in scope for the loadConfig fallback.

// Default poll cadence — overridden by the popup's pollIntervalSec
// setting at runtime. The MV3 alarms minimum is 1 minute for store
// builds and 30 seconds for unpacked dev installs; we use chrome.alarms
// but accept that values below 60s only work in dev. 10s matches the
// youforge-flow default so the operator's mental model stays the same.
const DEFAULT_POLL_INTERVAL_SEC = 10;

// Bounded-ring cap for the processedJobIds dedup buffer.
const PROCESSED_JOB_IDS_CAP = 100;

// Magnific UI URLs the executor opens. These are the signed-in app
// pages (the marketing `magnific.ai` host 301-redirects to the
// `magnific.com` landing, not the app). Banner CTA URLs in the
// HistForge dashboard must match these (see
// `src/app/videos/[id]/magnific-hitl-banner.tsx`).
const MAGNIFIC_IMAGE_GEN_URL = 'https://www.magnific.com/app/ai-image-generator';
const MAGNIFIC_IMAGE_TO_VIDEO_URL = 'https://www.magnific.com/app/ai-video-generator';
