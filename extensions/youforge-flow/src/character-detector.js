// YouForge Flow — saved-Character entity-ID auto-detector
// Observes (does not block) Flow's outbound
//   POST .../v1/projects/<projectId>/flowMedia:batchGenerateImages
// requests, parses each body's requests[].referenceEntities[].entityId,
// and persists a most-recently-seen list to chrome.storage.local under
// `detectedCharacters`. The popup reads that list and offers each
// entry as a one-click "Use as lock" option, removing the manual
// DevTools/Network capture step from the lock-setup flow.
//
// Recon: confirmed 2026-05-25 (see docs/setup-guides/setup-google-flow.md
// "Step: Lock a character") that Flow's UI sends
//   requests[i].referenceEntities: [{ entityId: <UUID> }]
// when a saved Character is attached to an image generation. The detector
// matches that exact shape.
//
// Why webRequest and not the SW's own request path:
//   The SW only issues requests for HistForge-dispatched tasks (where
//   the entityId is whatever the operator already locked). To discover
//   *new* Characters the operator is using directly in Flow's UI, we
//   need to observe the UI's outbound traffic — that's webRequest.
//   Listener is observe-only; we never block, modify, or cancel.
//
// Runtime deps: chrome.webRequest, chrome.storage.local, safeLog.

const CHAR_DETECT_STORAGE_KEY = 'detectedCharacters';
const CHAR_DETECT_MAX = 10;
const CHAR_DETECT_LABEL_MAX = 80;
const FLOW_GEN_URL_PATTERN =
  'https://aisandbox-pa.googleapis.com/v1/projects/*/flowMedia:batchGenerateImages';
const FLOW_GEN_URL_RE =
  /^https:\/\/aisandbox-pa\.googleapis\.com\/v1\/projects\/[^/]+\/flowMedia:batchGenerateImages$/;

// Single registration per SW wake. importScripts re-runs on every wake,
// so the listener is rebuilt — but chrome.webRequest dedups identical
// listener functions on add, so re-registering is a no-op rather than
// stacking. (We only have one entry point so this is defensive.)
function registerCharacterDetector() {
  if (!chrome.webRequest || !chrome.webRequest.onBeforeRequest) {
    safeLog('[character-detector] chrome.webRequest unavailable, skipping');
    return;
  }
  chrome.webRequest.onBeforeRequest.addListener(
    handleFlowImageGenRequest,
    { urls: [FLOW_GEN_URL_PATTERN] },
    ['requestBody'],
  );
  safeLog('[character-detector] listening on', FLOW_GEN_URL_PATTERN);
}

function handleFlowImageGenRequest(details) {
  if (!details || details.method !== 'POST') return;
  if (!FLOW_GEN_URL_RE.test(details.url || '')) return;
  const body = parseRequestBody(details.requestBody);
  if (!body) return;
  const requests = Array.isArray(body.requests) ? body.requests : [];
  // Aggregate all entities across all sub-requests, then commit in a
  // single read-modify-write. Loose `void recordDetected(...)` calls
  // per-entity racy under chrome.storage.local's get/set non-atomicity
  // — two near-simultaneous writes would clobber each other and lose
  // entries on multi-entity batches.
  const detected = [];
  for (const req of requests) {
    const entities = Array.isArray(req && req.referenceEntities)
      ? req.referenceEntities
      : [];
    if (entities.length === 0) continue;
    const label = extractLabel(req);
    for (const ent of entities) {
      if (!ent || typeof ent.entityId !== 'string' || !ent.entityId) continue;
      detected.push({ entityId: ent.entityId, label });
    }
  }
  if (detected.length === 0) return;
  // Fire-and-forget; the queue serialises against any in-flight prior
  // call so cross-request races are also eliminated.
  void recordDetected(detected);
}

// Flow's content-type is text/plain;charset=UTF-8, so webRequest exposes
// the JSON body verbatim under requestBody.raw[].bytes (ArrayBuffer).
// Form/multipart bodies would come via requestBody.formData instead; we
// only handle the raw path — formData would mean Flow's UI changed shape
// and we should rediscover before extracting.
function parseRequestBody(requestBody) {
  if (!requestBody) return null;
  const raw = Array.isArray(requestBody.raw) ? requestBody.raw : null;
  if (!raw || raw.length === 0) return null;
  // Concatenate all chunks (usually one).
  let totalLen = 0;
  for (const part of raw) {
    if (part && part.bytes && typeof part.bytes.byteLength === 'number') {
      totalLen += part.bytes.byteLength;
    }
  }
  if (totalLen === 0) return null;
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of raw) {
    if (!part || !part.bytes) continue;
    merged.set(new Uint8Array(part.bytes), offset);
    offset += part.bytes.byteLength;
  }
  let text;
  try {
    text = new TextDecoder('utf-8').decode(merged);
  } catch (_e) { return null; }
  try {
    return JSON.parse(text);
  } catch (_e) {
    return null;
  }
}

function extractLabel(req) {
  // Prefer the user-visible prompt as the row label so the operator
  // recognises which generation produced the entityId. Falls back to a
  // generic tag when the prompt is missing or empty.
  const parts =
    req && req.structuredPrompt && Array.isArray(req.structuredPrompt.parts)
      ? req.structuredPrompt.parts
      : null;
  const text = parts && parts[0] && typeof parts[0].text === 'string'
    ? parts[0].text
    : '';
  if (!text) return '(no prompt)';
  const trimmed = text.trim();
  if (!trimmed) return '(no prompt)';
  return trimmed.length > CHAR_DETECT_LABEL_MAX
    ? trimmed.slice(0, CHAR_DETECT_LABEL_MAX) + '…'
    : trimmed;
}

// Promise chain serialises all writes — if two webRequest events fire
// back-to-back, the second waits for the first's set() to land before
// reading. Continues the chain on both fulfillment and rejection so a
// transient storage error doesn't permanently stall the queue.
let _recordChain = Promise.resolve();
function recordDetected(items) {
  const next = _recordChain.then(
    () => _recordDetectedSerial(items),
    () => _recordDetectedSerial(items),
  );
  _recordChain = next;
  return next;
}

async function _recordDetectedSerial(items) {
  if (!Array.isArray(items) || items.length === 0) return;
  let existing;
  try {
    const got = await chrome.storage.local.get(CHAR_DETECT_STORAGE_KEY);
    existing = got[CHAR_DETECT_STORAGE_KEY];
  } catch (e) {
    safeLog('[character-detector] storage read failed:', e && e.message);
    return;
  }
  let list = Array.isArray(existing) ? existing.slice() : [];
  const now = Date.now();
  for (const item of items) {
    if (!item || typeof item.entityId !== 'string' || !item.entityId) continue;
    // Move-to-front: drop any prior entry for the same entityId so a
    // re-seen Character refreshes its label + lastSeen without growing
    // the list.
    list = list.filter(
      (e) => e && typeof e.entityId === 'string' && e.entityId !== item.entityId,
    );
    list.unshift({
      entityId: item.entityId,
      label: item.label || '(no prompt)',
      lastSeen: now,
    });
  }
  const trimmed = list.slice(0, CHAR_DETECT_MAX);
  try {
    await chrome.storage.local.set({ [CHAR_DETECT_STORAGE_KEY]: trimmed });
  } catch (e) {
    safeLog('[character-detector] storage write failed:', e && e.message);
  }
}
