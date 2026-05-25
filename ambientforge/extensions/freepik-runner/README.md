# AmbientForge Freepik Runner

Chrome MV3 extension + Node bridge that drives `www.freepik.com/ai/image-generator` to produce the per-album `source.jpg` for the ambient-video workflow. Mirrors the flow-runner pattern (port 7343); freepik-runner runs on **port 7344**.

## Status: Pass 1 skeleton

This is the **skeleton only**. The bridge HTTP shape, extension polling loop, and result post-back are functional. The actual page automation (model picker → prompt → Generate → grab result image) is a Pass 2 deliverable — content.js currently returns `FREEPIK_SELECTORS_NOT_RECORDED` for every task so any accidental enable fails loudly instead of silently doing nothing.

## Architecture

```
AmbientForge worker
   │
   │  POST /submit { prompt, model, aspectRatio }
   ▼
freepik-bridge (Node HTTP, port 7344, this folder's bridge.ts)
   │  POST /poll  ◄──── extension service-worker (background.js, every 5s)
   │  POST /result ◄─── extension (after content.js drives the page)
   ▼
Chrome tab on https://www.freepik.com/ai/image-generator
   - background.js polls bridge, dispatches to active Freepik tab
   - content.js drives the model picker + prompt + Generate (Pass 2)
   - sends image bytes back as base64 via /result
```

## Setup (operator, one-time)

1. **Start the bridge** in a terminal:
   ```
   npm run freepik:bridge
   ```
   Should log `[freepik-bridge] listening on http://localhost:7344`.

2. **Load the extension** in Chrome:
   - Open `chrome://extensions`
   - Enable Developer mode
   - Click "Load unpacked"
   - Select `extensions/freepik-runner/`

3. **Sign in to Freepik** with your Premium account:
   - Navigate to `https://www.freepik.com/ai/image-generator`
   - Log in
   - Leave the tab open

4. **Enable polling** via the extension popup:
   - Click the extension icon
   - Hit "Enable polling"

The bridge will now accept worker `/submit` calls; the extension polls every 5s and dispatches to the open Freepik tab.

## Pass 2 — recording the DOM selectors

The content script in `content.js` currently throws `FREEPIK_SELECTORS_NOT_RECORDED`. To fill in real automation:

1. Run Playwright codegen against the live Freepik UI:
   ```
   npx playwright codegen https://www.freepik.com/ai/image-generator
   ```
2. Sign in, switch the model picker to Seedream 5, type a sample prompt, click Generate, wait for the result, click Download. Playwright records every action with stable selectors.
3. Translate the generated Playwright snippet into vanilla DOM in `content.js`'s `executeTask` function. Prefer `querySelector('[aria-label="..."]')` / accessibility-tree queries over CSS classes — those are stable across Freepik UI refreshes.

## Configuration

| env var | default | notes |
|---|---|---|
| `FREEPIK_BRIDGE_PORT` | `7344` | bind port |
| `FREEPIK_BRIDGE_ALLOWED_ORIGIN` | `http://localhost:3003` | CORS allow-origin for the worker dashboard |

## Anti-patterns (per CLAUDE.md)

- Don't run two Freepik sessions in parallel from the shared account.
- Don't auto-click on suspicious-looking pages (Freepik's anti-bot may flag automation).
- If you hit a captcha, pause the album with `awaiting_captcha` (same pattern as DistroKid) — operator brings the window to front and solves manually.
