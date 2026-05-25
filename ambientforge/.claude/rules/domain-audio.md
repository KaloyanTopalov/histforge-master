# domain-audio

Use when modifying: `lib/audio/`, `lib/render/`, steps `07-audio-concat`, `08-loop-to-2h`, `09-mux-video`, thumbnail compositing in `05b`.

## Rules

- **Stream-copy concat only.** FFmpeg concat demuxer with `-c copy`. No re-encoding, no crossfade, no xfade. Audio fed to DistroKid must be bit-identical to YouTube video audio.
- All Suno output assumed to be uniform sample rate / channels / codec (validated in step 04). If a future Suno change breaks this, fail loudly — do not silently re-encode.
- `concat.wav` = natural-length sum of 30 tracks (~90-120 min typical).
- `loop.wav` = `concat.wav` repeated until duration >= `target_video_seconds`, then stream-copy trimmed to exactly `target_video_seconds`. Trim at end of loop, not mid-song. Exact duration takes priority over song boundaries.
- Mux: 1920x1080 H.264, AAC 192k, yuv420p, +faststart, 30fps. Single static image (`-loop 1 -t <duration>`).
- Tracklist: cumulative durations from the **30-track concat** (not loop). Format `M:SS - Title` (or `H:MM:SS` if any timestamp >= 1:00:00). Match @songsforcry exactly.
- Thumbnail compositing (step 05b): use FFmpeg drawtext for overlay text. Same font/style across channel runs (font + style are channel-config, not per-album).

## NVENC

- Detect at startup: `ffmpeg -encoders | grep nvenc`. If present + `nvenc_enabled` setting allows, use `h264_nvenc -preset p4 -tune hq -rc vbr -cq 23`. Fallback: `libx264 -preset medium -crf 20`.
- RTX 4070 always has NVENC. Still detect at runtime.

## Anti-patterns

- Re-encoding concat audio.
- xfade / acrossfade between songs.
- 60fps for static-image videos. 30fps.
- Reading durations from filenames or LLM output. Always ffprobe.
- Loudness normalization. Suno's native peaks are accepted.
