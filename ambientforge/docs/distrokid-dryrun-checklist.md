# DistroKid dry-run checklist

After each Session 6 dry run, the operator opens `projects/<channel_id>/<album_id>/distrokid-dryrun.png` and the matching `distrokid-payload.json`, then walks through this list before the eventual live submission.

If any item fails, the operator deletes the album's project directory and re-enqueues — step 06's idempotency only no-ops when the artifact exists, so removing it forces a clean re-run.

## Visual fields (open `distrokid-dryrun.png`)

1. **Album title** — matches `album.albumTitle`. Spelling, capitalization, punctuation.
2. **Artist** — the dropdown shows `channel.distrokidArtistName`. Confirm the artist profile is selected, not just typed.
3. **Primary genre** — matches `channel.distrokidPrimaryGenre`.
4. **Language** — set to **English**.
5. **Explicit** — **unchecked**.
6. **Release date** — exactly **today + 14 days** (visible in the date picker; 14-day window matches `content_id_hold_days`).
7. **Label** — matches `channel.distrokidLabelName` (or empty if the channel has none).
8. **Cover preview** — a 3000×3000 image is uploaded and rendered (or for the dry-run/manual-upload variant, the upload zone shows the file name from `payload.cover`).
9. **Track list** — exactly **30 tracks** in numeric order (`01 - …` through `30 - …`). No duplicates. Each title matches `payload.tracks[i].title`.
10. **Submit button visible but NOT clicked** — this is a dry run. The screenshot must capture the final review screen with Submit disarmed.

## JSON fields (open `distrokid-payload.json`)

- `metadata.albumTitle / artistName / genre / language / explicit / releaseDate / label` match the visual fields above.
- `cover` is an absolute path that exists on disk and is 3000×3000 PNG.
- `tracks` has 30 entries with sequential `trackNumber` 1-30, non-empty `title`, valid `audioPath`, and `duration > 0`.
- `releaseToken` is present.
- `requiresManualUpload` indicates whether the operator still needs to drag-drop files into DistroKid. If `true`, do that next.
- `capturedAt` is recent (within the album's run window).

## Database state

Running the operator's verification queries against `data/ambientforge.db`:

```sql
SELECT
  distrokid_status,
  distrokid_dry_run_artifact,
  distrokid_submitted_at,
  safe_to_upload_after,
  safe_to_upload_after - distrokid_submitted_at AS hold_ms
FROM albums
WHERE id = '<album_id>';
```

- `distrokid_status` = `'dryrun'`
- `distrokid_dry_run_artifact` = absolute path to the screenshot (file exists)
- `distrokid_submitted_at` is recent
- `hold_ms` = exactly `content_id_hold_days * 86400000` (default `1209600000` for 14 days)

## When you spot a mismatch

- Wrong artist → fix `channel.distrokidArtistName`, click **Verify artist** on the channel detail page until the green ✓ appears, delete the project dir, re-enqueue.
- Wrong genre / label → patch the channel and re-enqueue.
- Wrong release date → bug in step 06's `releaseDate` calculation. File an issue with the album id.
- Track count ≠ 30 → step 04 (Suno download) didn't produce 30 valid `.wav` files. Re-run step 04 or fail the album.
- Captcha banner stuck → click **Bring DistroKid window to front** in the dashboard, solve, then **Resume**.

## Live submission lockout

Step 06 throws `DISTROKID_LIVE_MODE_DISABLED` for the entire v0 lifetime, even when `distrokid_dry_run=false`. Live submission unlocks in Session 13. Do not attempt to bypass — the gate is a deliberate safety against the irreversible nature of DistroKid release submission.
