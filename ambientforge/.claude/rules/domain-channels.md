# domain-channels

Use when modifying: `src/lib/repos/channels.ts`, `src/app/channels/`, channel API routes, scheduler, channel templates.

## Rules

- A channel is a **config row**. Adding a channel = INSERT, not code change.
- Per-channel templates live in `prompts/channel-templates/<channel_id>/<step_name>.md`. Worker first looks here; falls back to `prompts/defaults/<step_name>.md`.
- Channel rows are immutable while an album for that channel is in `in_progress`. Dashboard disables edit during run.
- Soft-delete only: `active=false` removes from scheduler but preserves history (albums, stats).
- `scheduleCron` is standard 5-field cron (minute hour dom month dow). Use `node-cron` for parsing/validation.
- `youtubeChannelId` is the `UC...` 24-char ID (NOT the `@handle`). Stats fetcher resolves handle → ID at channel-create time, stores both, but uses ID for API calls.
- DistroKid artist names are the operator's responsibility — must already exist in their DistroKid account before the channel can submit. Validation: surface a "verify artist exists" button that runs a dry distrokid-runner action to confirm the artist appears in the dropdown.
- `thumbnailOverlayText` is optional. When null, thumbnail = cover image cropped to 1920x1080 with no overlay. When set, FFmpeg drawtext composites it.

## Anti-patterns

- Hardcoding channel-specific logic in step code. Read from channel row + templates.
- Allowing edits to channels while their album is running.
- Using `@handle` as primary key. Handles can change; UC IDs cannot.
- Hard-deleting channels with historical stats.
