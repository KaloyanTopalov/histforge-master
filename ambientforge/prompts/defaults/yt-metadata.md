<!-- mock-response: {"title":"sleep tonight.","description":"slow ambient drift to help you settle in.\n\n{{spotifyLine}}{{tracklistEscaped}}\n\n{{hashtagsLine}}","tags":["ambient music","sleep music","study music","lofi","relaxing","ambient drift","2 hour ambient","sleep aid","focus music","calm","meditation","background music"]} -->

You are writing the YouTube upload metadata for a 2-hour ambient music compilation video.

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

Constraints:
- title: matches the channel's voice. For sad-ambient / sleep / meditation channels, use a lowercase soft-command sentence ending in a period (e.g. "sleep tonight.", "let it rain."). 1-4 words.
- description: opens with one short hook line (no greeting). If the channel's Spotify playlist URL is non-empty, include it on its own line below the hook. Then one blank line, then paste the FULL tracklist verbatim (every entry, in order, with timestamps). Then one blank line, then convert the channel's CSV hashtags into space-separated `#tags` (e.g. "ambient,sleep" -> "#ambient #sleep"). Do not add extra hashtags beyond what the channel provides.
- tags: 8-15 short YouTube search keywords. Total joined-by-comma length must be at most 500 characters. No leading "#". No quotes inside strings.
- The description MUST contain the tracklist text exactly as supplied; do not reformat timestamps or titles.
