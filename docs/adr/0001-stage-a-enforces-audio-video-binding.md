# Stage A enforces audio-video binding per hook chunk

The renderer (Stage A in `src/lib/render.ts`) is responsible for making each hook video clip cover its chunk's narration audio span. When a clip is shorter than its chunk's `[start, end]` in `narration.mp3`, the renderer pads the clip's video stream by holding its last frame via `tpad=stop_mode=clone:stop_duration=...`. The chunk → clip binding is filesystem-based (`videos/hook/<chunkId>.mp4`); per-chunk duration enforcement is performed at render time, not communicated to the video provider.

## Considered Options

- **Push duration into the video-provider interface.** Add a `targetDuration` field to `VideoProviderItem` so providers like Google Flow / ComfyUI generate clips at the desired length. *Rejected*: VEO emits a fixed 8 s clip and has no duration knob; ComfyUI workflows bake duration into the user's JSON. Neither provider can honour a target without operator-side workflow changes outside our control. Forcing a contract everyone has to ignore is misleading.
- **Pad audio with silence between chunks (Case A from the research doc).** Splice `narration.mp3` and insert `anullsrc` gaps to match longer video. *Deferred, not rejected*: it's the symmetric fix for the V > A case (clip longer than audio span). The current ADR scopes only the V < A direction. A follow-up may add it.
- **Tune `hook_video_clip_seconds` further.** *Rejected*: it's a chunker sizing target, not enforcement. Sentence-boundary snapping always introduces per-clip jitter regardless of target.

## Consequences

- Stage A now runs N+1 ffmpeg invocations per render (one per hook chunk plus the concat) instead of one. The encode cost is the same order of magnitude as before because the original concat already re-encoded.
- A `hook_<chunkId>_timed.mp4` intermediate is materialised per chunk, mirroring Stage B's `segment_NNN.mp4` pattern. Each clip is independently inspectable in `render/`.
- The V > A case (clip longer than audio span) is intentionally left unfixed — residual drift in that direction persists until Case A is implemented. The hook section's total length becomes `Σ max(V_i, A_i)`, which is bounded but not exactly the audio span.
- The video-provider interface (`src/lib/video/types.ts`) stays narrow and provider-agnostic; provider implementations are not coupled to per-chunk duration.

Related: `docs/research/2026-05-12-audio-media-sync.md`.
