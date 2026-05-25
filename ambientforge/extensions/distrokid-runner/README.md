# distrokid-runner

Chrome MV3 extension + Node bridge for AmbientForge step 06 (DistroKid release submission).

## Quick start

1. **Bridge**: `npm run distrokid:bridge` — starts the Node HTTP server on port 7342 (auto-started as the `dk-br` lane in `npm run dev`).
2. **Login**: `npm run distrokid:login` — launches a headed Chromium with the extension auto-loaded against `data/distrokid-profile/`. Sign in to DistroKid manually, then close the window.
3. **Verify artist**: in the AmbientForge dashboard, open the channel detail page and click "Verify artist exists". The extension drives DistroKid to confirm the artist profile is in your dropdown.

## Operator setup before each pipeline run

For step 06 to drive the form successfully, the operator's daily Chrome must have:

1. The DistroKid extension loaded (`chrome://extensions/` → load unpacked from `extensions/distrokid-runner/`). On first reload after Session 4.7 the extension prompts to approve the `<all_urls>` host permission — required for `chrome.tabs.captureVisibleTab` to capture the form screenshot. Approve it.
2. The **Upload / New Release page** open at `https://distrokid.com/new/` (logged in, no captcha overlay).
3. **Number of songs set to N** (matches `tracks_per_album_override` for tests, 30 for prod). Without this, `set_metadata` will drive it on first call but the re-render briefly collapses other expanded sections.
4. **"Add credits for each song on this release" expanded.** DK filters synthetic clicks (`event.isTrusted=false`), so the extension can't auto-expand it. Click the requirements toggle so credit input rows for every track are visible. Without this, `set_metadata` fills 7 album fields + songwriter but skips per-track performer/producer credits and step 06 still passes (returns `screenshot_saved` once cover/track manual uploads complete).

## Architecture

- `manifest.json` — MV3 manifest. Host permissions: `distrokid.com`, `localhost:7342`, `<all_urls>` (the latter is required for `chrome.tabs.captureVisibleTab` in `submit_or_screenshot`).
- `background.js` — service worker. Long-polls `http://localhost:7342/next-action`, dispatches actions to the active distrokid.com tab via `chrome.tabs.sendMessage`, posts results back to `/action-result/:id`. Also brokers `chrome.tabs.captureVisibleTab` for the screenshot endpoint and POSTs raw PNG bytes to `/upload-screenshot/<actionId>`.
- `content.js` — runs on `https://distrokid.com/*`. All 5 stub/partial handlers are now real (Session 4.7): `verify_artist` reads `#artistName` options, `start_release` waits for `#howManySongsOnThisAlbum`, `set_metadata` drives 7 album-level fields + songwriter + performer/producer credits, `verify_track_count` counts `input[id^="title_"]`, `submit_or_screenshot` brokers screenshot capture through background. Field-fill helpers (`setInputValue`, `setDropdownValue`, `isVisible`, `findInputForLabel`) ported from the upstream "AI Music Ext" extension.
- `popup.html` + `popup.js` — connected indicator polling `localhost:7342/health`.
- `bridge.ts` — Node HTTP server. Worker face: 8 POST routes (one per action). Extension face: `GET /next-action` (long-poll) + `POST /action-result/:id` + `POST /upload-screenshot/:actionId` (raw PNG bytes; bridge writes them to the path stored in the action's payload).

## Action contract (worker → bridge)

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/verify_artist` | `{artistName}` | `{found, candidates, primarySelected}` |
| `POST` | `/start_release` | `{}` | `{releaseToken, ready}` |
| `POST` | `/set_metadata` | `DistrokidMetadata` (see `src/lib/distrokid/client.ts`) | `{ok:true, filled, fieldsFilled, fieldsAttempted, missingFields, errors}` |
| `POST` | `/upload_cover` | `{releaseToken, filePath}` | `{ok:true, requiresManualUpload:true}` |
| `POST` | `/upload_track` | `{releaseToken, filePath, trackNumber, title}` | `{ok:true, trackNumber, requiresManualUpload:true}` |
| `POST` | `/verify_track_count` | `{releaseToken, expected}` | `{count, matches}` |
| `POST` | `/submit_or_screenshot` | `{releaseToken, screenshotPath, dryRun:true, hint?:{channelName?}}` | `{status:'screenshot_saved'\|'captcha_required', screenshotPath, captured, bytes?}` |
| `POST` | `/focus_window` | `{}` | `{ok:boolean, error?}` |
| `POST` | `/upload-screenshot/:actionId` | raw PNG bytes (`application/octet-stream`) | `{ok:true, bytes, path}` |
| `GET`  | `/health` | — | `{status:'ok', queueDepth, inFlight, waiters}` |

`set_metadata` payload (from `DistrokidMetadata`):

```ts
{
  albumTitle, artistName, genre, language, explicit, releaseDate, label,
  numSongs,                        // drives #howManySongsOnThisAlbum (idempotent)
  songwriterFirstName?, songwriterMiddleName?, songwriterLastName?,
  creditPerformerName?, creditPerformerRole?,
  creditProducerName?, creditProducerRole?,
}
```

## Browser-security limitations

Two operations cannot be fully automated in MV3 content scripts and require operator gestures:

1. **File upload** (`<input type="file">`). `upload_cover` and `upload_track` always return `{ok:true, requiresManualUpload:true}` and the operator drag-drops `cover.png` + the `.wav` files into DK. A future session could implement DataTransfer + synthetic-drop simulation; not yet attempted.
2. **"Add credits" expansion.** DistroKid's credits requirement toggle (`<div class="requirements-item-title">`) is wired up via JS that checks `event.isTrusted`. Synthetic clicks dispatched from the content script have `isTrusted=false` and are ignored. Workaround: operator clicks the toggle manually before step 06 runs. Future session can use `chrome.debugger` API + `Input.dispatchMouseEvent` to produce trusted clicks; that adds a permission warning banner so it's gated behind explicit operator opt-in.

## Mock mode

When the worker has `DISTROKID_MODE=mock`, the bridge is never contacted — the mock client returns deterministic responses. See `src/lib/distrokid/client.ts`.

## Captcha

If the content script detects a recaptcha/hcaptcha overlay during `submit_or_screenshot`, it returns `{status:'captcha_required'}`. Step 06 sets `album.status='awaiting_captcha'` and the dashboard surfaces a banner with "Bring DistroKid window to front" + "Resume" buttons.

## Credits

Field-fill heuristics ported from "AI Music Ext" by the upstream author (D:\ai-music-ext-main on the local machine). The React-compatible `setInputValue` and the multi-fallback selector arrays are the load-bearing pieces.
