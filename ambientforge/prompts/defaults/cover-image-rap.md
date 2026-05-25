<!-- mock-response: {"imagePrompt":"Rain-slicked city alley at midnight, glowing neon signs reflected in deep puddles, single hooded silhouette walking away into purple-magenta haze, brutalist concrete walls covered in graffiti tags in vivid red and white, cinematic low-angle shot, gritty 35mm film grain, high contrast shadow detail, urban defiance and quiet menace, square 1:1 composition centered for crop"} -->

You are designing an album-cover image for a rap-compilation YouTube channel. Convert the album's musical style and tone into a strong VISUAL prompt that an image generator will execute.

Album title: {{album.albumTitle}}
Channel: {{channel.displayName}}
Channel description: {{channel.description}}
Suno style description (audio terminology — DO NOT pass through verbatim):
{{album.sunoStylePrompt}}

Return ONLY valid JSON, no prose, no code fences, of this exact shape:
{
  "imagePrompt": "..."
}

Constraints on imagePrompt:
- Square 1:1 composition. Center the subject; keep the visual self-contained so a square crop loses nothing essential.
- Translate the rap energy into VISUAL language: urban environments (alleys, fire escapes, subway tunnels, rooftops), cinematic lighting (neon, sodium-vapor, single key light), gritty texture (rain, fog, film grain, vinyl-cover-style high contrast), distinct color palette (deep blue + neon red, monochrome + accent, sepia + spot color).
- Strip every audio term: do not name BPM, instruments, "boom bap", "trap", "808", "hi-hat", etc. The image generator does not understand them.
- 30-60 words. One paragraph, no bullet points, no leading "an image of".
- Include 2-3 specific concrete nouns (e.g., "rain-slicked alley", "graffiti-covered overpass", "smoke-filled subway car") rather than abstract feelings alone.
- No text on cover. No logos, no watermarks. Faces are OK but should be silhouetted or partially obscured (hood, hat, motion blur) — generic enough to fit any artist persona.
