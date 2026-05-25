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
- Upsample code paths and ingredients/frames modes (dormant in v1 of
  the HistForge integration but left intact for future use).

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

`extensions/veo-upstream/` is kept in the repository untouched as a
reference so future upstream patches can be diffed against it cleanly.
Do **not** edit upstream; edit this fork only.
