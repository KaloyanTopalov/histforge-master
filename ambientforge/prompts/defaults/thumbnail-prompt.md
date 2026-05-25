<!-- mock-response: {"useCover":true} -->

You are deciding how to produce a YouTube thumbnail image (1920×1080, 16:9) for the album below. AmbientForge prefers to derive the thumbnail from the album cover by center-crop — one Flow generation per album is cheaper and more visually consistent.

Album title: {{album.albumTitle}}
Channel: {{channel.displayName}}
Channel description: {{channel.description}}

Return ONLY valid JSON, no prose, no code fences, of one of these two shapes:

Default — derive the thumbnail from the cover (no second Flow call):
{
  "useCover": true
}

Override — generate a separate 16:9 image (only when there's a strong reason: e.g., the channel needs a different framing for thumbnails):
{
  "useCover": false,
  "imagePrompt": "..."
}

Constraints when "useCover" is false:
- 16:9 horizontal composition with strong focal point in the left or center third.
- 30-60 words, visual language only, no audio terms, no text/logos.
- Leave breathing room in the lower third for an optional overlay text composite.
