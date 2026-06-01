# python/draw_on — contour draw-on render

Standalone Python CLI that turns a static image into a draw-on animation
video. Used by HistForge doodle workflows as a pre-render stage: each
static doodle image is converted to a `.mp4` clip, which the FFmpeg
render step (worker step 14) then consumes in place of the static PNG.

## Status

Session 1 — Python CLI only. Pipeline integration (worker step that
dispatches this CLI, render.ts routing to consume the clips,
`pixel_dissolve` → `draw_on` rename in `src/lib/image/styles.ts`) is
Session 2 — see "Session 2 handoff" at the bottom.

## Algorithm origin

Adapted from [daslearning-org/image-to-animation-offline](https://github.com/daslearning-org/image-to-animation-offline)
(MIT license). This implementation:

- Removes the hand sprite (operator requirement: clean self-drawing lines)
- Replaces "black lines, then hard-flip to color" with **progressive
  color via a dilated stroke mask** plus **outline-first flood-fill** for
  no-ink interior regions (operator requirement: color emerges WITH the
  surrounding strokes, never before them)
- Uses **native source resolution** with white padding to a multiple of
  `split_len` (no `find_nearest_res` snapping, no source rows lost)
- Drops the Kivy GUI binding and the PyAV transcode (writes mp4v directly;
  the parent FFmpeg pipeline in Session 2 will re-encode to h264)

## Defaults (final)

| Param | Default | Effect |
|---|---|---|
| `--split-len` | `4` | Grid cell size in pixels. Smaller = smoother, slower (`O(n²)` NN traversal). |
| `--fps` | `60` | Output frame rate. Higher = smoother motion (fewer cells revealed per frame). |
| `--dilation-px` | `12` | Stroke leak radius. Each cell's reveal "footprint" is roughly `split_len + dilation_px`. |

## Reveal behavior (what makes it read as drawing)

1. **Adaptive threshold** (Gaussian, block_size=15, C=10) detects line work
   in the source. Cells with any detected ink get added to the traversal.

2. **Nearest-neighbor traversal** walks the ink cells starting from the
   top-left-most one. Each step draws one cell into a stroke `mask`; every
   `skip_rate`-th step writes a frame.

3. **Progressive color via dilation**: each frame composites the source
   colors through `dilate(mask, kernel)` — so color leaks slightly past
   the strokes as they're drawn. This is the "color emerges with the
   lines" effect for areas where dilation can reach.

4. **Flood-fill for flat color regions** (large interiors that dilation
   can't cover):
   - `detect_color_regions` finds connected components of pixels with
     grayscale in `(60, 230)`. Hatched/textured regions (e.g. shaded
     state silhouettes) are filtered out via `max_ink_fraction=0.30` so
     they keep drawing progressively. Tiny regions are filtered via
     `min_area=200`.
   - **Outline-first ordering**: for each region, the "outline cells"
     are the grid cells containing ink pixels within ~5px of the region.
     A region's color fill triggers only after ≥90% of its outline cells
     have been drawn by the traversal. **Color always lags the
     surrounding strokes** — never green-before-black.
   - The fill writes to a separate `fill_mask` that `progressive_frame`
     composites **exactly** (no dilation), so the fill does NOT pull
     adjacent line-work pixels into the reveal via the kernel halo. Line
     work inside a region (e.g. text on a green callout) stays under
     the traversal's progressive control.

5. **Edge handling**: source dims are padded UP to a multiple of
   `split_len` AND even (for mp4v) with white. No source rows are trimmed.
   For an 800×447 source at `split_len=4`, output is 800×448.

6. **Complete final frame**: after the loop, one final frame is always
   written so the last video frame reflects every cell visited (catches
   the trailing cells the loop iterates past without writing under
   higher skip rates).

## Setup

### Python version

Python 3.12 (pinned). Tested with 3.12.10 on Windows.

### Recommended: venv via setup script

```powershell
# Windows PowerShell
.\setup.ps1
. .venv\Scripts\Activate.ps1
```

```bash
# Unix
./setup.sh
source .venv/bin/activate
```

The script creates `.venv/` and installs `numpy==2.4.6`, `opencv-python==4.13.0.92`, `pytest>=8.3.0`.

### Alternative: system Python 3.12 + pip

```bash
pip install -r requirements.txt
```

### Verify setup

```bash
cd python/draw_on
python -m pytest tests/test_setup.py -v
```

Expected: 3 passed (cv2 imports, numpy imports, draw_on imports). If
`cv2` or `numpy` fails to import, the env isn't set up correctly — fix
before running the CLI. The CLI itself will fail loudly with `ERROR:
Python draw-on not configured (missing <pkg>). Run setup.ps1 / setup.sh
or 'pip install -r requirements.txt'.` if either is missing.

## Usage

```bash
python -m draw_on <image_path> <duration_sec> <output_mp4_path> \
  [--fps 60] [--split-len 4] [--dilation-px 12]
```

Example:

```bash
python -m draw_on doodle.png 6.0 out.mp4
```

Runs at the locked defaults (split_len=4, fps=60, dilation_px=12).

## Test

```bash
cd python/draw_on
python -m pytest tests/ -v
```

37 tests covering algorithm primitives (preprocess, traversal, skip-rate,
progressive frame, color region detection), render integration
(resolution, duration, first/last frame, color block fill, line-pop
guard, outline-first ordering), CLI (happy path, missing input, no args,
parent-dir creation), and dep-import sanity.

## Validation

Session 1 reference clip (operator-validated):

- `docs/superpowers/specs/draw-on-spike-output/session1-baseline-image_005.mp4`

Generated from `projects/01KSX7F0ZYYQN9G0ZHHHAT2ZXH/images/image_005.png`
("5 Worst / 5 Best" doodle — character, state silhouettes, green dollar
callouts, dense line work) at the final defaults. Session 2 integration
output should be visually equivalent per-image when fed through the
worker.

## Session 2 handoff

The TS worker step that dispatches this CLI lives in Session 2. Contract:

- **CLI invocation**: per image chunk, the worker spawns
  `python -m draw_on <projects/<id>/images/image_NNN.png> <chunk.end - chunk.start> <projects/<id>/clips_drawn/image_NNN.mp4>`.
  No flags needed — the locked defaults match what was operator-validated.
- **Python path resolution**: new settings string `draw_on_python_path`
  with default lookup order: (1) `<repo>/python/draw_on/.venv/Scripts/python.exe`
  (Windows) or `.venv/bin/python` (Unix); (2) fallback to `python` on
  PATH. Render precheck should fail loudly if neither resolves OR if
  `python -m draw_on --help` doesn't return 0.
- **AbortSignal**: thread through `spawn` so cancellation kills the
  Python subprocess cleanly (same pattern as `lib/align-whisper.ts`).
- **Logging**: stderr lines feed into `appendLog`; stdout reserved for
  any future progress reporting.
- **render.ts gating**: image chunks where the workflow's
  `image_style.reveal_effect === "draw_on"` route to the clip in
  `clips_drawn/`; cinematic / null `image_style` keep the existing
  `-loop -i <png>` + zoompan path byte-identical.
- **Registry rename**: `src/lib/image/styles.ts` value
  `reveal_effect: "pixel_dissolve"` → `"draw_on"`. Update
  `__tests__/unit/lib/image/styles.test.ts` accordingly.

## Performance notes

- NN traversal is `O(N²)` in cell count. At `split_len=4` on an 800×447
  doodle (~6450 ink cells), end-to-end render of a 6-second clip takes
  ~3.5–5s on CPU. For a 300-image video that's ~15–25 minutes of
  draw-on work. If this becomes a bottleneck in Session 2, swap NN for
  a KD-tree-backed neighbor search (`scipy.spatial.cKDTree`) — should
  bring it to `O(N log N)`.
- Output codec is mp4v (zero-extra-deps, ships with cv2 on Windows).
  Session 2's step 14 re-encodes to h264 when building the per-image
  segment, so the upstream codec doesn't matter downstream.
