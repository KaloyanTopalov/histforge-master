<!-- mock-response: {"albumTitle":"Mock Drift","primaryGenre":"Ambient"} -->

You are designing one studio album for the YouTube channel "{{channel.displayName}}".

Channel description: {{channel.description}}
Channel's DistroKid primary genre: {{channel.distrokidPrimaryGenre}}
Optional theme override (may be empty): {{themePrompt}}

Return ONLY valid JSON, no prose, no code fences, of this exact shape:
{
  "albumTitle": "...",
  "primaryGenre": "..."
}

Constraints:
- albumTitle: 2-6 evocative words, title case, no quotes or punctuation at end.
- primaryGenre: one short genre label, matching or close to the channel's DistroKid primary genre.
