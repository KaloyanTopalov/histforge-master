# Flow Extension Setup Runbook

Operator runbook for connecting the AmbientForge Flow Runner Chrome extension
to the local bridge so step 05a (cover image) and step 05b (thumbnail) can
generate images via Google Flow.

This is one-time setup per Chrome profile; once configured the extension
auto-restarts polling on Chrome launch.

## Prerequisites

- `npm run dev` is running (the flow-bridge starts on port 7343 as part of
  the concurrently lane).
- A Chrome profile is **already logged in to** `https://labs.google/fx/tools/flow`.
  Either your daily Chrome with your normal Google account, or the dedicated
  profile created by `npm run flow:login` at `data/flow-profile/`.
  - The extension's content scripts only attach to `https://labs.google/*`
    pages (per `manifest.json` `host_permissions`), so the active session
    must be in the same Chrome instance you're loading the extension into.

## Steps

### 1. Open the Chrome where you're signed into Flow

If you used `npm run flow:login` previously, use that Chrome window
(`data/flow-profile/`). Otherwise, your daily Chrome is fine — the
extension itself doesn't care which profile, only that **the same window**
has an authenticated `labs.google` tab open.

### 2. Load the unpacked extension

1. Navigate to `chrome://extensions/`
2. Toggle **Developer mode** (top right) → ON
3. Click **Load unpacked**
4. Point to `E:\Projects\ambientforge\extensions\flow-runner\`
5. Confirm the card shows: `AmbientForge Flow Runner 0.1.0` with no errors

If Chrome shows a manifest warning, hit **Errors** on the card to inspect.
Common issue: another `flow-runner` (e.g. the upstream `youforge-flow`)
already loaded — disable or remove it first.

### 3. Open the popup and configure

Pin the extension to the toolbar (puzzle-piece icon → pin). Click the
extension icon. Fill the four fields **exactly** as below — these are the
local bridge endpoints, not HistForge URLs (the placeholder text in the
popup still mentions HistForge because the extension was forked from
YouForge; that placeholder is misleading for AmbientForge — ignore it).

| Field | Value |
|---|---|
| **Poll URL** | `http://localhost:7343/poll` |
| **Result URL** | `http://localhost:7343/result` |
| **Status URL** | `http://localhost:7343/status` |
| **Account Token** | `ambientforge-dev` (any non-empty string — bridge does not enforce) |
| **Concurrency** | `1` (override default of 5; AmbientForge submits one image at a time per album) |

The popup auto-saves on each input event (400ms debounce).

### 4. Grant host permission

After all fields are filled, the popup shows a button:

> **Grant access to http://localhost:7343**

Click it. Chrome shows a permission prompt:

> *AmbientForge Flow Runner wants to read and modify all your data on http://localhost:7343*

Click **Allow**. The button changes to "Access granted" and the **Start**
button becomes enabled.

If the prompt doesn't appear, the popup may have stale state — close and
reopen the popup, then click Grant again.

### 5. Start polling

Click **Start**. The status line at the bottom of the popup transitions
from `Idle` → `Last poll: 0s ago` and updates every ~2 seconds.

### 6. Verify the extension is polling

**Popup-side (definitive):** the status line shows `Last poll: Xs ago` and
the value resets to a low number every ~5 seconds. If it stays at a high
number or shows an error, the extension is not reaching the bridge. Common
causes:
- Bridge not running — check `curl http://localhost:7343/health` returns JSON.
- Host permission revoked — click Grant again.
- Account token field empty — the popup disables Start when any URL/token
  field is blank, but if state got out of sync, refilling all four fields
  re-enables it.

**Bridge-side (injects one Flow task; ~1 image of quota):**

```powershell
# 1. Submit a test task to the bridge.
$resp = Invoke-RestMethod -Method Post -Uri http://localhost:7343/submit `
  -ContentType 'application/json' `
  -Body (@{ prompt = "blank canvas, minimalist studio test"; aspectRatio = "1:1" } | ConvertTo-Json)
$taskId = $resp.taskId
Write-Host "submitted: $taskId"

# 2. Watch the bridge state. Within ~5s the poller should pick it up:
#    pending: 1 -> 0, dispatched: 0 -> 1.
1..6 | % {
  Invoke-RestMethod http://localhost:7343/health | ConvertTo-Json -Compress
  Start-Sleep 2
}

# 3. After Flow generates (typically 30–90s), status flips to ready.
1..30 | % {
  $h = Invoke-RestMethod http://localhost:7343/health
  if ($h.ready -gt 0 -or $h.failed -gt 0) { $h | ConvertTo-Json -Compress; break }
  Start-Sleep 5
}

# 4. (Optional) Pull the bytes — proves the round trip end-to-end.
Invoke-WebRequest -Method Get -Uri "http://localhost:7343/download/$taskId" `
  -OutFile data/flow-verify.png
ffprobe data/flow-verify.png 2>&1 | Select-String "PNG|Stream"
```

Expected timeline:
- t=0s: `pending=1, dispatched=0`
- t≤5s: `pending=0, dispatched=1` (extension picked it up)
- t≈30–90s: `pending=0, dispatched=0, ready=1` (Flow finished)
- `data/flow-verify.png` is a real PNG (1024×1024 or 1:1 aspect)

If `pending=1` stays `1` past 10 seconds, the extension is **not** polling
the bridge. Re-check steps 4–5 (host grant + Start clicked).

If pending → dispatched but never → ready/failed within 3 minutes, the
extension reached the bridge but Flow itself isn't responding. Check the
labs.google tab for a captcha challenge, expired session, or rate-limit
banner. Click **Stop** in the popup, solve manually, then **Start** again.

## What the URLs do

The three URLs map 1:1 to the bridge's extension-face routes (all
`POST`):

- **`/poll`** — extension long-polls every ~5s; bridge returns the next
  queued task (`{ id, mode: "imagegen", imagePrompt, aspectRatio }`) or
  `{}` when idle.
- **`/result`** — extension POSTs `{ taskId, mediaFiles: [{ base64, mimeType }] }`
  on success or `{ taskId, error }` on failure.
- **`/status`** — extension POSTs `{ event: "session_expired" | ... }` log
  events; bridge prints them to its stderr.

The token field is unused in dev (bridge sits on loopback only). Pick any
non-empty string so the popup considers the form complete and enables Start.

## Troubleshooting

**Popup shows "Idle" after clicking Start.** Some setting is missing — the
status would show an error otherwise. Refill all four fields, re-grant
host permission, restart Start.

**Popup shows "Error: HistForge host permission revoked".** Chrome dropped
the optional permission (rare; happens after a profile reset). Click Grant
again.

**Popup shows "Error: session expired — re-login needed".** Your
labs.google session timed out. Switch to that tab, sign in again, then
click Start in the popup.

**`pending` count stuck at 1+ in `/health`.** The extension isn't picking
up tasks. Open the popup and check the status line. If status shows polling
but tasks aren't dispatched, the bridge is reachable but the response
shape may be wrong — verify with:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:7343/poll `
  -ContentType 'application/json' `
  -Body '{"type":"TaskRequest","accountToken":"x","mode":"imagegen"}'
```

Should return either `{}` (no task) or the next task body. If it returns a
task body but the extension didn't, there's an extension-side issue —
check the service-worker console at `chrome://extensions/` →
**service worker** link on the card.

**Multiple Flow extensions installed.** Disable any non-AmbientForge
flow-runner. The upstream `youforge-flow` extension polls HistForge URLs;
if both are running and pointed at different bridges, results are
unpredictable.

## When you're done for the day

You can leave the extension running across Chrome restarts — it
auto-resumes polling. To pause:

- Click **Stop** in the popup, OR
- Quit Chrome (the extension stops with the profile).

When you next open Chrome, the extension is loaded but **not** polling
until you click Start again.
