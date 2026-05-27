# YouForge Flow

HistForge-owned fork of the upstream `VEO Flow API` browser extension
(see `extensions/veo-upstream/` for the unmodified reference copy).

This fork is a **dumb runner**: it receives tasks from HistForge via
webhook, calls the Google Flow backend through `flow-api.js`, and posts
results back. HistForge owns the queue, per-account state, and routing.

## What was stripped from upstream

- **Remote-control channel** (`UPDATE_SERVER` + `checkRemoteControl()` +
  its alarm). Removes a third-party channel that could steer the
  extension.
- **Baserow manual mode** — state vars, persistence, handlers, the
  `BASEROW_API` constant, and the popup tab / buttons that drove it.
- **n8n hardcoded webhook defaults** and the matching manifest host
  permission.
- **`downloader.html` / `downloader.js`** (Baserow artifact) plus the
  `downloads` manifest permission and the `web_accessible_resources`
  entry that exposed the downloader page.
- **Catastrophically broad host permissions** (`http://*/*` and
  `https://*/*`). Remaining host permissions are `labs.google/*`,
  `aisandbox-pa.googleapis.com/*`, and `storage.googleapis.com/*`.
  The HistForge host is granted at runtime via
  `optional_host_permissions` so the extension can reach the webhook
  URLs the user configured.

## What was kept

- `flow-api.js` — the six Google Flow endpoints.
- `recaptcha-hook.js` — reCAPTCHA Enterprise hook.
- `content.js` + `content-bridge.js` — session-token fetch plumbing.
- The FIFO polling runner.
- Content-policy error detection.
- Upsample code paths and the frames-to-video executor (dormant in v1
  of the HistForge integration but left intact for future use).

## Character lock

The image executor attaches an operator-supplied Google Flow saved
Character on every image task. The wire shape is
`request.referenceEntities: [{ entityId: <UUID> }]` — the same shape
Flow's own UI sends when generating an image with a Character attached.
No upload step: the entity ID is used verbatim. `imageInputs` is left
alone for the existing task-supplied uploaded-reference path
(`uploadImage()` + `name`).

Storage key: `characterLockReference` (UUID string in
`chrome.storage.local`, edited via the popup). Empty = no lock.
Malformed values throw `BadCharacterLockError` before any Flow API
call.

### Character auto-detect

`src/character-detector.js` registers a
`chrome.webRequest.onBeforeRequest` observer scoped to
`https://aisandbox-pa.googleapis.com/v1/projects/*/flowMedia:batchGenerateImages`.
Whenever Flow's own UI fires an image generation with a Character
attached, the detector parses the POST body's
`requests[].referenceEntities[].entityId` and persists the entries to
`chrome.storage.local` under `detectedCharacters` (move-to-front,
capped to 10). The popup renders this list under the lock field as a
one-click "Use as lock" panel. Observe-only — never blocks, never
mutates headers/body. Requires the `webRequest` Chrome permission.

See `docs/setup-guides/setup-google-flow.md` → "Step: Lock a character"
for the operator-facing workflow (both auto-detect and manual
DevTools-Network capture paths).

## Loading the extension

Dev-mode only — this is not published to the Chrome Web Store.

1. Open `chrome://extensions` in a Chrome profile dedicated to a
   single Google account.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this directory
   (`extensions/youforge-flow/`).
4. Open the extension popup, paste the three webhook URLs and the
   account token from HistForge's Settings → Google Flow → Add
   account modal, then click **Grant HistForge access** to authorize
   the runtime host permission. Click **Start**.

The full end-to-end walkthrough lives at `docs/setup-guides/setup-google-flow.md`.

## Relationship to upstream

`extensions/VEO API Extension/` is kept in the repository untouched as a
reference mirror of a newer upstream so future graft diffs can be
produced cleanly. Do **not** edit the mirror; edit this fork only.
(An older `extensions/veo-upstream/` mirror used to play this role and
is no longer present.)
