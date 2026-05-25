# domain-yt-stats

Use when modifying: `src/lib/yt-stats/`, `src/worker/stats-fetcher.ts`, channels analytics dashboard, OAuth flow.

## Rules

- **Read-only YouTube Data API v3.** OAuth scope: `https://www.googleapis.com/auth/youtube.readonly`. Never request upload scopes — v1 is metadata-generation-only.
- One Google account, one OAuth token. Refresh token persisted in `data/yt-stats-token.json`. `npm run yt-stats:auth` triggers the OAuth flow.
- Stats fetcher runs once daily at `stats_fetch_hour_utc` (default 03 UTC). Single batched API call per channel: `GET /channels?id=UC...&part=statistics,snippet`.
- Quota cost: 1 unit per channel per day. Free quota: 10,000 units/day. 20 channels = 20 units/day.
- For per-video stats (CTR, watch time): would require YouTube Analytics API (different endpoint, requires owner verification). **Out of scope for v1.**
- Snapshot-only model: every fetch inserts a new `channel_stats` row. Deltas computed at query time in the dashboard, not stored.
- Resolve `@handle` → `UC...` ID once at channel-create time using `GET /channels?forHandle=@xxx&part=id`. Cache in `channels.youtubeChannelId`.
- Token expiry: API returns 401 → fetcher logs to `pipeline.log`, sets a settings flag `yt_stats_auth_expired=true`, dashboard surfaces a banner.

## Anti-patterns

- Polling stats more than once per day.
- Requesting upload scopes (security baseline = least privilege).
- Storing computed deltas in DB. Recompute from snapshots at query time.
- Silent OAuth failures. Always surface to dashboard.
