// YouForge Flow - shared constants
// Service-worker-wide values referenced by multiple modules. Loaded early
// (second, after src/logger.js) so every downstream module can see them.
//
// AISANDBOX_BASE deliberately stays in flow-api.js only. Classic-script
// scripts loaded via importScripts share lexical scope, so declaring
// `const AISANDBOX_BASE` here as well would collide with flow-api.js:5.
// Consumers that need the base URL reference it from flow-api.js's
// declaration (available globally once flow-api.js is imported).

// labs.google's client-side public API key for aisandbox-pa.googleapis.com.
// Not a secret — shipped in labs.google's own bundle — but having it in one
// place means a single edit if Google ever rotates it.
const GOOGLE_LABS_API_KEY = 'AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY';

const FLOW_URL = 'https://labs.google/fx/de/tools/flow';
const POLL_INTERVAL_MINUTES = 0.1667; // 10 seconds (faster for continuous mode)
// Credits alarm period. 1 minute is the MV3 alarms minimum for unprivileged
// extensions — raise this knob if you want credits updates less often, but
// never drop below 1 or Chrome silently clamps it.
const CREDITS_POLL_MINUTES = 1;
const MAX_CONCURRENT_MAX = 10;
