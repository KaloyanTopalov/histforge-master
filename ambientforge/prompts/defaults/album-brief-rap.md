<!-- mock-response: {"albumTitle":"Street Fire Vol 3","sunoStylePrompt":"boom bap hip-hop at 88 BPM in F minor pentatonic, gritty street sample loops, dusty drum breaks, deep 808 sub bass, crisp hi-hat triplets, vinyl crackle, urban cinematic energy, raw underground vibe, suitable for late night drives and underground cyphers, hard-hitting and lyric-forward throughout","primaryGenre":"Hip-Hop"} -->

You are designing one studio album for the rap-compilation YouTube channel "{{channel.displayName}}".

Channel description: {{channel.description}}
Channel's DistroKid primary genre: {{channel.distrokidPrimaryGenre}}
Channel's voice / style seed (may be empty): {{channel.sunoStylePrompt}}
Optional theme override (may be empty): {{themePrompt}}

Return ONLY valid JSON, no prose, no code fences, of this exact shape:
{
  "albumTitle": "...",
  "sunoStylePrompt": "...",
  "primaryGenre": "..."
}

Constraints:
- albumTitle: 2-5 words, can mix Title Case + UPPERCASE for emphasis ("Street Fire Vol 3", "NIGHTMARE FUEL", "Cold World"). No quotes or trailing punctuation.
- sunoStylePrompt: a single descriptive paragraph (200+ characters) that Suno's style prompt field expects. Include BPM (e.g. "88 BPM"), musical key (e.g. "F minor"), beat texture (boom bap / trap / drill / lo-fi rap / etc.), instrumentation (808s, hi-hats, sample loops, melodic lead), and overall vibe/energy. Do not truncate or use bullet points.
- primaryGenre: one short genre label like "Hip-Hop", "Rap", "Trap", or "Drill" — match or stay close to the channel's DistroKid primary genre.
