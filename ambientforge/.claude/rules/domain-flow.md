# domain-flow

Use when modifying: `extensions/flow-runner/`, `lib/flow/`, steps `05a-cover-image`, `05b-thumbnail`.

## Rules

- One shared Google Flow account. Pattern mirrors YouForge Flow from HistForge.
- **Step 05a** generates ONE image at Flow's native resolution per album. Then FFmpeg post-processes:
  - `cover.png` — 3000x3000, sRGB, <10MB (DistroKid spec)
  - `ytImage.png` — 1920x1080 (mux background, derived from cover via crop or letterbox per setting)
- **Step 05b** generates the YouTube thumbnail. Per channel: thumbnail prompt template can differ from cover prompt template. Output: `thumb.png` 1920x1080.
- Flow prompt is generated from `channel.coverPromptTemplate` (or default) interpolated with `albumTitle` + `sunoStylePrompt`. Don't pass raw Suno prompt — strip audio terminology, emphasize visual.
- If `channel.thumbnailOverlayText` is set, FFmpeg drawtext composites it on the thumbnail. Font: `prompts/defaults/thumbnail-font.ttf` (operator supplies). Color/size/position: standard YouTube-thumbnail readability (large bold sans-serif, white with black stroke, lower-third).
- Bridge port 7343. Actions: `submit_prompt`, `poll`, `download`.
- Aspect retry: if Flow returns extreme aspect ratio, retry image-prompt LLM call once with "square composition" emphasis, then proceed with crop.

## Anti-patterns

- Generating cover + thumbnail as two separate Flow calls when one image works for both. Step 05a generates one image; 05b derives thumbnail. Only call Flow twice if `channel.thumbnailPromptTemplate` differs from `coverPromptTemplate`.
- Skipping post-crop. DistroKid rejects non-square covers.
- Passing raw Suno style prompt to Flow.
