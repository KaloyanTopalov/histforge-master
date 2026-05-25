<!-- mock-response: {"title":"STREET FIRE VOL 3 — UNDERGROUND RAP COMPILATION","description":"hard-hitting underground rap compilation. lyric-forward boom bap energy, late-night drive vibes, no skips.\n\n{{spotifyLine}}{{tracklistEscaped}}\n\n{{hashtagsLine}}","tags":["rap","hip hop","underground rap","boom bap","rap compilation","lyrical rap","hip hop compilation","street rap","conscious rap","rap mix","new rap","rap music","drive music"]} -->

You are writing the YouTube upload metadata for a rap-compilation video.

Album: "{{album.albumTitle}}"
Channel: "{{channel.displayName}}"
Channel description: {{channel.description}}
Spotify playlist (may be empty): {{channel.spotifyPlaylistUrl}}
Channel hashtags (CSV, may be empty): {{channel.hashtags}}

Tracklist (cumulative timestamps, one per line):
{{tracklist}}

Return ONLY valid JSON, no prose, no code fences, of this exact shape:
{
  "title": "...",
  "description": "...",
  "tags": ["...", "...", ...]
}

Constraints (rap-specific):
- title: matches the channel's voice. For rap-compilation channels, prefer UPPERCASE or Title Case with a strong hook ("STREET FIRE VOL 3 — UNDERGROUND RAP COMPILATION", "Cold World — Late Night Drive Mix"). 4-12 words. Em-dash separator OK.
- description: opens with one short hook line (no greeting). If the channel's Spotify playlist URL is non-empty, include it on its own line below the hook. Then one blank line, then paste the FULL tracklist verbatim (every entry, in order, with timestamps). Then one blank line, then convert the channel's CSV hashtags into space-separated `#tags`. Do not add extra hashtags beyond what the channel provides.
- tags: 8-15 short YouTube search keywords, rap-specific ("rap", "hip hop", "underground rap", "boom bap", "rap compilation", "lyrical rap", "trap", "drill", etc.). Total joined-by-comma length must be at most 500 characters. No leading "#". No quotes inside strings.
- The description MUST contain the tracklist text exactly as supplied; do not reformat timestamps or titles.
