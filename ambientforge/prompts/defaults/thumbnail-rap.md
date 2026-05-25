<!-- mock-response: {"useCover":false,"imagePrompt":"Tight 16:9 thumbnail crop on a single hooded silhouette under a buzzing neon sign that reads only in shape (no readable text), magenta and cyan rim-light cutting through fog, cinematic three-point lighting, hard shadow on the right two-thirds for an overlay text composite, gritty film grain, vinyl-cover high contrast, defiant posture"} -->

You are deciding how to produce a YouTube thumbnail image (1920×1080, 16:9) for a rap-compilation album. Rap channels typically benefit from generating a separate 16:9 thumbnail rather than cropping the square cover, because thumbnails want a strong off-center subject + breathing room for overlay text.

Album title: {{album.albumTitle}}
Channel: {{channel.displayName}}
Channel description: {{channel.description}}

Return ONLY valid JSON, no prose, no code fences, of one of these two shapes:

Default for rap channels — generate a separate 16:9 image:
{
  "useCover": false,
  "imagePrompt": "..."
}

Alternative — derive thumbnail from cover by center-crop (use only when the cover already has the right aspect/composition for a thumbnail):
{
  "useCover": true
}

Constraints when "useCover" is false:
- 16:9 horizontal composition. Place the subject in the LEFT third or LEFT half so the right two-thirds are available for overlay text.
- Lower-third should have a darker zone for white-on-dark text readability.
- 30-60 words, visual language only. No audio terms ("boom bap", "808"). No logos, no readable text in the image (overlay text is composited via FFmpeg drawtext later).
- Keep silhouettes / hooded figures / partial faces — generic enough to fit any artist persona.
