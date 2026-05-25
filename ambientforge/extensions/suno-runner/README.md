# suno-runner

Chrome MV3 extension + Node bridge that lets the AmbientForge worker drive
suno.com through an authenticated browser session. Pattern mirrors the
YouForge Flow extension from HistForge: the **bridge owns the job queue**
and the **extension is the executor** that polls for actions.

```
┌──────────┐  POST /submit          ┌──────────┐  GET /next-action  ┌──────────────┐
│  worker  │────────────────────────▶│  bridge  │───────────────────▶│  extension   │
│ (Node)   │◀──────────────────────── │ (7341)   │◀──────────────────│ (chrome SW)  │
└──────────┘  { taskId }             └──────────┘  POST /action-result└──────────────┘
                                                                            │
                                                                            ▼
                                                                       suno.com tab
                                                                       (content.js)
```

## Files

| File | Role |
|------|------|
| `bridge.ts` | Node HTTP server on port 7341. Client face: `POST /submit`, `GET /poll/:id`, `POST /download/:id`, `GET /credits`. Extension face: `GET /next-action` (long-poll), `POST /action-result/:id`. Plus `GET /health` for the popup badge. |
| `manifest.json` | MV3, `host_permissions` for suno.com + localhost:7341. |
| `background.js` | Service worker. Polls `/next-action` and dispatches to `content.js` via `chrome.tabs.sendMessage`. |
| `content.js` | Injected on `suno.com`. Stubbed handlers — fill in real Suno API calls when wiring goes live. |
| `popup.html` + `popup.js` | "Connected" badge — polls `/health` every 2s. |

## Operator workflow

1. **Bridge** — `npm run suno:bridge` (separate terminal). Starts on port 7341.
2. **Login** — `npm run suno:login` launches Playwright with the unpacked
   extension loaded into a persistent profile at `data/suno-profile/`. Log in
   to suno.com manually, then close the window — credentials persist.
3. **Run** — `npm run dev` (or just the worker) with `SUNO_MODE` *unset* will
   make the worker hit the bridge instead of the mock. Re-launch Chromium
   with the profile so the extension polls the bridge: `npm run suno:login`
   keeps it open between runs.

## Mock mode

When `SUNO_MODE=mock`, the worker bypasses the bridge entirely and uses
fixture .wav files from `tests/fixtures/suno/`. The bridge does not need to
be running.

## Wiring TODO (out of Session 4 scope)

`content.js` currently has stubbed handlers. Before the operator can run a
real album end-to-end, replace them with calls to Suno's current API
surface (study the network tab on suno.com/create):

- `submit` → POST to the generate endpoint with the style prompt + lyrics
- `poll` → GET the feed endpoint with the task id
- `download` → fetch the `audio_url` from the poll response, return bytes
- `credits` → GET the billing endpoint

All requests must use `credentials: 'include'` so the session cookie rides
along (same pattern as YouForge Flow).
