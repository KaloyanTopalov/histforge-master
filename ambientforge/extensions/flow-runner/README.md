# AmbientForge Flow Runner

AmbientForge fork of `youforge-flow` (which is itself a HistForge fork of
the upstream `VEO Flow API` extension). Same "dumb runner" pattern: the
extension polls a webhook for tasks, drives the Google Flow backend
through `flow-api.js`, and posts results back. AmbientForge owns the
queue and routing in a Node bridge process.

## How it differs from `youforge-flow`

- Manifest renamed to `AmbientForge Flow Runner`. Browser code, content
  scripts, executors, and recaptcha hook are otherwise unchanged.
- `src/executors/image.js` accepts a per-task `aspectRatio` field
  (`'1:1' | '16:9' | '9:16'` or `square|landscape|portrait`). When
  present it overrides the popup's aspect-ratio setting. AmbientForge
  needs square 1:1 covers (3000×3000 DistroKid spec) and 16:9 thumbnails
  on demand, so the popup-only knob from upstream isn't expressive
  enough.

## Bridge contract (AmbientForge side)

The Node bridge at `extensions/flow-runner/bridge.ts` (port 7343)
exposes the three webhook endpoints this extension polls:

- `POST /poll`   — returns the next pending task or `{}` (no task).
  Task shape: `{ id, mode: 'imagegen', imagePrompt, aspectRatio }`.
- `POST /result` — extension reports success (with `mediaFiles`) or
  failure (with `error`).
- `POST /status` — extension reports `session_expired` etc.

The bridge also exposes worker-facing routes (`POST /submit`, `GET
/poll/:taskId`, `GET /download/:taskId`) that mirror the suno-runner
contract; see `src/lib/flow/client.ts`.

## Loading the extension (dev)

1. Run `npm run flow:login` once. This launches headed Chromium with
   the extension auto-loaded against a persistent profile at
   `data/flow-profile/`. Sign in to Google at `labs.google/fx` then
   close the window.
2. Run `npm run flow:bridge` (started automatically in `npm run dev`).
3. Re-launch headed Chromium (or load the extension via
   `chrome://extensions` → Developer mode → Load unpacked, point at
   this directory).
4. Open the popup. Paste:
   - Poll URL: `http://localhost:7343/poll`
   - Result URL: `http://localhost:7343/result`
   - Status URL: `http://localhost:7343/status`
   - Account token: any non-empty string (the bridge does not enforce
     a particular token in dev — pick e.g. `ambientforge-dev`).
5. Click **Grant access to http://localhost:7343** so the extension
   can reach the bridge via the runtime-granted optional host
   permission.
6. Click **Start**.

## Mock mode

When the worker runs with `FLOW_MODE=mock`, the worker bypasses the
bridge entirely and serves fixture PNGs from `tests/fixtures/flow/`.
The extension is not invoked; the bridge does not need to be running
for unit tests or runtime smoke tests in mock mode.

## Relationship to upstream

This directory is the only place AmbientForge edits the extension
code. The upstream YouForge fork lives in HistForge — diff against
`extensions/youforge-flow/` in that repo to see exactly what
AmbientForge changed (manifest name + the small aspect-ratio patch in
`src/executors/image.js`).
