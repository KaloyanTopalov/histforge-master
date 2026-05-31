# Doodle Draw-On Render — Requirements (validated 2026-05-31)

## Status
Scoping note. NOT yet built. Supersedes the rejected pixel-dissolve reveal from
the image-styles Session 2 plan. This is its own build project — a Python OpenCV
pre-render stage, not an FFmpeg filter.

## What this replaces
The Session 2 pixel-dissolve / xfade reveal (pixelize, dissolve, fadewhite) was
tested and REJECTED — "they don't look like drawing." A reveal makes a finished
image *appear*; drawing lays strokes down *progressively*. Confirmed by research:
no FFmpeg filter closes that gap, and generic I2V models (Kling/Runway/Veo/Sora/
Wan) fail at draw-on (they morph the finished frame). The real answer is an
OpenCV contour-reveal pipeline.

## Spike result (what's validated)
- Forked-tool spike: daslearning-org/image-to-animation-offline (MIT), run
  hand-free-able, on a REAL doodle image (image_005.png from project
  01KSX7F0ZYYQN9G0ZHHHAT2ZXH — the "5 Worst/5 Best" doodle with character +
  state shapes + dollar callouts + green highlight blocks).
- Core contour-reveal effect: VALIDATED. Strokes appear progressively following
  the image's actual lines. Operator reaction: "yes this is pretty much what I
  wanted."
- Ran CPU-only, ~0.8s OpenCV pass, ~2.8s total incl. H.264 transcode, on a 4070
  machine. Fast. The daslearning baseline (~6/10, scanline-ish ordering) appears
  GOOD ENOUGH — the heavier storyboard-ai SAM object-by-object version (7-8/10,
  2-4 weeks) is likely NOT needed. Confirm once seen hand-free at full res.

## The three requirements (the actual spec)
1. **Contour draw-on** — strokes appear progressively along the image's own
   lines, drawing themselves. (Validated in spike.)
2. **NO hand sprite** — remove the cartoon hand that follows the stroke tip.
   Operator wants clean self-drawing lines, no hand. (Hand is an optional overlay
   in these pipelines — removal is easy, not core.)
3. **Progressive color, NOT end-snap** — the daslearning baseline draws black
   line work first, then HARD-FLIPS to the full colored image at the end.
   Operator rejected this: "the colors appeared at the end, that's what I don't
   like." Color must fill in progressively WITH the strokes (region by region),
   so each color block (e.g. the green highlight) fills as its area is drawn, not
   all at once at the finish. Known technique: reveal the *colored* image through
   a growing/dilated stroke mask (the "dilated mask" approach from research), so
   color emerges alongside the advancing lines. The source doodles are black
   felt-tip OUTLINE + flat COLOR FILL blocks (per the validated doodle prompt),
   so outlines and fills are separate — the progressive-color logic must handle
   both.

## Open design questions for the build session
- **Tip treatment** (hand removed): nothing at the stroke tip (cleanest, likely
  choice) vs. a subtle pen/marker dot vs. a soft leading edge. Operator leaned
  toward "without the hand" = probably nothing. Confirm.
- **Pacing**: draw-on duration should derive from the narration chunk duration
  (image draws on over roughly the time it's on screen), NOT a fixed 4.5s. The
  daslearning object_skip_rate knob controls speed.
- **Resolution snapping**: daslearning's find_nearest_res rounds non-standard
  dims to a hardcoded standard-res list (snapped ~800x450 → 720x480 in the spike,
  losing detail). Must be neutralized for production so full-res doodles aren't
  downscaled.
- **Fork-vs-reimplement**: daslearning is MIT (forkable). The color-flip logic to
  change lives inside its render pass — investigate sketchApi.py / initiate_sketch
  internals (the spike's clean entry point) for where the black-lines-then-color-
  flip happens, and where to inject progressive color instead.
- **Pipeline integration**: this is a NEW pre-render stage — each static doodle
  image → draw-on clip → fed into the existing FFmpeg assembly. Decide where it
  slots vs. the current per-image segment build in render.ts / step 14. The
  white-background composite + static-motion bits from the Session 2 plan may fold
  in here; the reveal mechanism is now this OpenCV stage, not an FFmpeg filter.
- **Only applies to doodle styles** — cinematic must be untouched (byte-identical),
  same per-style discipline as the merged image-styles work. Gate the draw-on
  stage on the style's reveal_effect (the registry already has reveal_effect;
  "pixel_dissolve" value should be reconsidered/renamed now that the mechanism is
  contour-draw-on, not dissolve).

## Spike artifacts (delete after noting)
- Scratch dir: E:\spike-drawon\ (clone + venv + run_spike.py + output clip).
  Nothing touched the histforge tree, nothing committed. Safe to delete.
- The clean GUI-bypass trick (for the real build): sketchApi.py exposes
  initiate_sketch(...); only Kivy coupling was `from kivy.clock import Clock` for
  a post-render callback — stub kivy.clock in sys.modules, never install Kivy.
