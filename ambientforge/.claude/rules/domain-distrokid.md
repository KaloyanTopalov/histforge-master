# domain-distrokid

Use when modifying: `extensions/distrokid-runner/`, `lib/distrokid/`, step `06-distrokid-submit`.

## Rules

- One shared DistroKid account on **Musician+ plan** (unlimited artists). Each channel has a `distrokidArtistName` referencing an artist profile that **must already exist** in the operator's DistroKid account.
- **DistroKid submission is irreversible** — submitted releases queue for delivery to Spotify/Apple/etc. Cannot undo without manual takedown.
- Default `distrokid_dry_run=true`. In dry-run: fill all fields, upload cover + 30 tracks, stop at final Submit, save screenshot to `projects/<ch>/<alb>/distrokid-dryrun.png` and payload to `distrokid-payload.json`.
- Live mode requires double-confirm in dashboard ("Type SUBMIT to confirm").
- Artist selection: in step 06, the runner uses `album.artistName` (which was copied from `channel.distrokidArtistName` at album creation) to pick from DistroKid's artist dropdown. If not found in dropdown → fail with `DISTROKID_ARTIST_NOT_FOUND` and surface a banner with instructions.
- Required fields per release: album title, artist (from dropdown), primary genre (from `channel.distrokidPrimaryGenre`), language (default English), explicit (default false), release date (default = today + 14 days), label (`channel.distrokidLabelName` or blank), 3000x3000 cover, 30 tracks with title.
- Track upload order = `trackNumber`. Upload in two batches of 15, verify counts after each batch.
- Bridge port 7342. Actions: `verify_artist`, `start_release`, `upload_cover`, `upload_track`, `set_metadata`, `verify_track_count`, `submit_or_screenshot`, `focus_window`. Plus the screenshot endpoint `POST /upload-screenshot/:actionId` (raw PNG bytes; bridge writes to `action.payload.screenshotPath`).
- Captcha: pause album with `awaiting_captcha`, surface dashboard banner with "Bring window to front" button.
- **Content ID hold:** step 06 always sets `distrokid_submitted_at` and `safe_to_upload_after = distrokid_submitted_at + content_id_hold_days * 86400000` regardless of dry-run vs live mode (so the dashboard UI behaves identically).
- **DistroKid form is a SPA at `/new/`.** Album-level fields (`#albumTitleInput`) and per-track inputs (`title_<uuid>`, `explicit_<uuid>`, `track-N-performer-1-name|role`, `track-N-producer-1-name|role`) only render once `#howManySongsOnThisAlbum` is set to ≥2. `set_metadata` drives the songs dropdown FIRST but is idempotent — re-firing change on the same value would re-render the form and collapse already-expanded credits sections.
- **Songwriter + credits are required for publishing.** `set_metadata` fills `songwriter_real_name_first<N>` / `_last<N>` per track from settings (`distrokid_songwriter_first_name` / `_last_name`). Performer + producer credits fill `track-N-performer-1-{name,role}` and `track-N-producer-1-{name,role}` from `distrokid_credit_{performer,producer}_{name,role}` settings.
- **Operator must click "Add credits for each song on this release"** in DK before step 06 runs. The toggle is a styled `<div class="requirements-item-title">` that checks `event.isTrusted` and rejects synthetic clicks dispatched from content scripts. Same operator-gesture pattern as cover/track drag-drop. A `chrome.debugger`-based auto-click is feasible but adds a permission-warning banner — deferred to a future session.
- **Manifest needs `<all_urls>` host permission** for `chrome.tabs.captureVisibleTab` to capture the form screenshot. Screenshot flow: content script sends `capture_screenshot` to background.js → background calls `captureVisibleTab` → POSTs raw PNG bytes to `/upload-screenshot/<actionId>` → bridge writes to disk → content resolves `submit_or_screenshot`.

## Anti-patterns

- Live submission without dry-run verification of at least 2 prior runs per channel.
- Hardcoded release date.
- Bypassing captcha programmatically.
- Reusing the wrong artist profile (always validate via `verify_artist` action before step 06 starts).
- Bypassing the upload-hold UI.
