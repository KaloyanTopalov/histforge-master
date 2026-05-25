<!-- mock-response: {"imagePrompt":"Moonlit forest clearing in deep blue and indigo, low fog drifting between tall pine silhouettes, single faint silver light source from above, painterly soft brushwork, cinematic composition centered for square framing, atmospheric and unhurried, rich shadow detail with subtle warm highlights"} -->

You are designing a single album-cover image for a YouTube music channel. Convert the album's musical style into a strong VISUAL prompt that an image generator will execute.

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
- Translate the Suno style into VISUAL language: palette, lighting, atmosphere, subject, composition, art-style. Pull mood and texture from the audio description, never the audio nouns.
- Strip every audio term: do not name BPM, musical keys, instruments, "ambient", "lofi", "drum", "synth", etc. The image generator does not understand them and including them weakens the result.
- 30-60 words. One paragraph, no bullet points, no leading "an image of".
- Include 2-3 specific concrete nouns (e.g., "moonlit forest clearing", "rain on a neon-soaked window") rather than abstract feelings alone.
- No text, no logos, no watermarks, no human faces in close-up unless the channel description asks for it.
