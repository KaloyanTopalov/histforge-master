import cv2
import numpy as np
import pytest

from draw_on.render import render_draw_on


@pytest.fixture
def synthetic_doodle(tmp_path):
    """100x100 BGR with line work (black square) + a color fill (green block).

    Mimics the two element types in real doodles: outlines AND fills.
    """
    img = np.full((100, 100, 3), 255, dtype=np.uint8)
    img[40:60, 40:60] = 0              # black square (line work)
    img[10:30, 70:90] = [0, 255, 0]    # green fill block (BGR)
    path = tmp_path / "doodle.png"
    cv2.imwrite(str(path), img)
    return path


def _probe_video(path):
    cap = cv2.VideoCapture(str(path))
    info = {
        "w": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        "h": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
        "n_frames": int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
        "fps": cap.get(cv2.CAP_PROP_FPS),
    }
    cap.release()
    return info


def test_render_produces_mp4(synthetic_doodle, tmp_path):
    out = tmp_path / "out.mp4"
    render_draw_on(str(synthetic_doodle), str(out), duration_sec=2.0, fps=30)
    assert out.exists()
    assert out.stat().st_size > 0


def test_render_native_resolution(synthetic_doodle, tmp_path):
    out = tmp_path / "out.mp4"
    render_draw_on(str(synthetic_doodle), str(out), duration_sec=2.0, fps=30)
    info = _probe_video(out)
    # No find_nearest_res snapping — match input dims (modulo split_len trim)
    assert info["w"] == 100 and info["h"] == 100


def test_render_duration_matches(synthetic_doodle, tmp_path):
    out = tmp_path / "out.mp4"
    render_draw_on(str(synthetic_doodle), str(out), duration_sec=2.0, fps=30)
    info = _probe_video(out)
    # 2 sec * 30 fps = 60 frames; allow ±2 for mp4v rounding
    assert abs(info["n_frames"] - 60) <= 2


def test_render_first_frame_mostly_white(synthetic_doodle, tmp_path):
    out = tmp_path / "out.mp4"
    render_draw_on(str(synthetic_doodle), str(out), duration_sec=2.0, fps=30)
    cap = cv2.VideoCapture(str(out))
    ok, frame0 = cap.read()
    cap.release()
    assert ok
    white_pixel_fraction = (frame0 > 240).all(axis=-1).mean()
    assert white_pixel_fraction > 0.85


def test_render_last_frame_shows_colored_content(synthetic_doodle, tmp_path):
    out = tmp_path / "out.mp4"
    render_draw_on(str(synthetic_doodle), str(out), duration_sec=2.0, fps=30)
    info = _probe_video(out)
    cap = cv2.VideoCapture(str(out))
    cap.set(cv2.CAP_PROP_POS_FRAMES, info["n_frames"] - 1)
    ok, last = cap.read()
    cap.release()
    assert ok
    # Green block region should show green-dominant pixels in the final frame
    # (mp4v is lossy — allow tolerance)
    g_region = last[15:25, 75:85]  # interior of the green block
    assert g_region[:, :, 1].mean() > 150  # green channel high
    assert g_region[:, :, 2].mean() < 100  # red channel low


def test_render_no_hard_color_flip_at_end(synthetic_doodle, tmp_path):
    """Adjacent frames near the end should differ smoothly, not in one cut."""
    out = tmp_path / "out.mp4"
    render_draw_on(str(synthetic_doodle), str(out), duration_sec=2.0, fps=30)
    info = _probe_video(out)
    cap = cv2.VideoCapture(str(out))
    cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, info["n_frames"] - 10))
    ok_a, frame_a = cap.read()
    cap.set(cv2.CAP_PROP_POS_FRAMES, info["n_frames"] - 1)
    ok_b, frame_b = cap.read()
    cap.release()
    assert ok_a and ok_b
    # Diff between t=-10 and t=-1: should be small (post-reveal hold), not large
    diff = np.abs(frame_a.astype(int) - frame_b.astype(int)).mean()
    assert diff < 30  # tunable; threshold detects a sudden whole-image flip


def test_render_pads_non_divisible_dims_with_white(tmp_path):
    """Source dims not divisible by split_len are PADDED with white, not trimmed.
    No source content is lost at the bottom/right edges."""
    # 99x99 input, split_len=4 → ceil(99/4)*4 = 100 (already even) on each axis
    img = np.full((99, 99, 3), 255, dtype=np.uint8)
    img[90:95, 40:60] = 0  # content near the BOTTOM that would be lost if trimmed
    path = tmp_path / "input.png"
    cv2.imwrite(str(path), img)
    out = tmp_path / "out.mp4"
    render_draw_on(str(path), str(out), duration_sec=1.0, fps=30, split_len=4)
    cap = cv2.VideoCapture(str(out))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.set(cv2.CAP_PROP_POS_FRAMES, n - 1)
    ok, last = cap.read()
    cap.release()
    assert ok
    # Padded UP to 100x100 (not trimmed down to 96x96)
    assert (w, h) == (100, 100), f"expected padding to 100x100, got {w}x{h}"
    # The original bottom-edge content (rows 90-94) should be present
    bottom_content = last[90:95, 40:60]
    assert (bottom_content < 200).any(), "bottom-edge content was lost (trim instead of pad)"


def test_render_last_frame_is_complete(synthetic_doodle, tmp_path):
    """Final video frame must reveal everything the algorithm visited.
    Pins that no cells are added to the mask after the last frame is written."""
    out = tmp_path / "out.mp4"
    render_draw_on(str(synthetic_doodle), str(out), duration_sec=2.0, fps=30)
    src = cv2.imread(str(synthetic_doodle))
    cap = cv2.VideoCapture(str(out))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.set(cv2.CAP_PROP_POS_FRAMES, n - 1)
    ok, last = cap.read()
    cap.release()
    assert ok
    h, w = last.shape[:2]
    # Match dims (input 100x100, output 100x100 at split_len=4)
    src_t = src[:h, :w]
    # Source content pixels: anywhere the source is NOT pure white
    src_content = (src_t < 240).any(axis=-1)
    # In the last frame, those same locations should NOT all be white
    last_white = (last > 240).all(axis=-1)
    missing = (src_content & last_white).sum()
    total_content = max(1, src_content.sum())
    fraction_missing = missing / total_content
    assert fraction_missing < 0.01, (
        f"{missing} of {total_content} source-content pixels are still white "
        f"in the last frame ({100*fraction_missing:.2f}%)"
    )


def test_render_flood_fill_does_not_pop_line_work(tmp_path):
    """Black line work INSIDE a flood-fillable color region must be drawn
    progressively (stroke-by-stroke) — NOT pulled in along with the color fill
    when the region triggers. Eyeball-equivalent: the line should appear
    gradually over the video, not snap in at the moment flood-fill fires.
    """
    img = np.full((200, 200, 3), 255, dtype=np.uint8)
    img[50:150, 50:150] = [50, 200, 200]   # 100x100 yellow block
    img[95:105, 60:140] = [0, 0, 0]        # thick black line through middle
    src_path = tmp_path / "block_with_line.png"
    cv2.imwrite(str(src_path), img)
    out = tmp_path / "out.mp4"
    render_draw_on(str(src_path), str(out), duration_sec=4.0, fps=30, split_len=4)
    cap = cv2.VideoCapture(str(out))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    # Sample the line-area brightness across the video. Brightness ~255 = white
    # (line not yet drawn there); brightness ~0 = black (line fully drawn).
    line_brightness = []
    for frac in [0.05, 0.2, 0.4, 0.6, 0.8, 0.99]:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(n * frac))
        ok, frame = cap.read()
        if not ok: continue
        line_brightness.append(float(frame[97:103, 70:130].mean()))
    cap.release()
    # Last frame: line must be fully drawn (very dark)
    assert line_brightness[-1] < 80, (
        f"line not drawn by end of video (brightness {line_brightness[-1]:.0f})"
    )
    # If flood-fill popped the line, brightness would be ~0 from the first
    # sample (flood-fill fires early). If flood-fill EXCLUDED the line, the
    # early samples are bright (line area still white/yellow) and brightness
    # drops as the loop draws the line cells.
    delta = max(line_brightness) - min(line_brightness)
    assert delta > 60, (
        f"line-area brightness barely changes over video ({delta:.1f}) — "
        f"flood-fill is likely popping the line work in. "
        f"Samples: {[f'{b:.0f}' for b in line_brightness]}"
    )


def test_render_flood_fills_large_color_block_interior(tmp_path):
    """A flat color block too wide for dilation to cover from its edges must
    still be fully filled in the final frame (via flood-fill activation)."""
    # 200x200 white image with a 100x100 yellow block in the middle. The
    # block is much larger than the default 12px dilation kernel, so without
    # flood-fill its interior would be left white in the last frame.
    img = np.full((200, 200, 3), 255, dtype=np.uint8)
    img[50:150, 50:150] = [50, 200, 200]  # yellow-ish BGR
    src_path = tmp_path / "big_block.png"
    cv2.imwrite(str(src_path), img)
    out = tmp_path / "out.mp4"
    render_draw_on(str(src_path), str(out), duration_sec=2.0, fps=30, split_len=4)
    cap = cv2.VideoCapture(str(out))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.set(cv2.CAP_PROP_POS_FRAMES, n - 1)
    ok, last = cap.read()
    cap.release()
    assert ok
    # Interior of the yellow block (far from any edge) should be yellow, NOT white
    interior = last[90:110, 90:110]
    # Yellow has high G and B, low R (BGR: [50, 200, 200])
    assert interior[:, :, 1].mean() > 150, "block interior green channel too low — interior not filled"
    assert interior[:, :, 2].mean() > 150, "block interior red channel too low — interior not filled"
    assert interior[:, :, 0].mean() < 120, "block interior blue channel too high — looks white not yellow"


def test_render_color_fills_after_outline_drawn(tmp_path):
    """The color fill must arrive AFTER the outline is mostly drawn, not before.

    Pins the outline-first ordering: at some early-to-mid frame the region
    interior should still be mostly white (outline being drawn, color hasn't
    triggered yet). Color only fills once enough outline cells have been
    visited by build_traversal.
    """
    # Isolated 100x100 yellow block. Edge ink (from adaptive threshold) at
    # the yellow/white boundary IS the outline. Color must wait for those
    # edge cells to be substantially drawn.
    img = np.full((200, 200, 3), 255, dtype=np.uint8)
    img[50:150, 50:150] = [50, 200, 200]
    p = tmp_path / "block.png"
    cv2.imwrite(str(p), img)
    out = tmp_path / "out.mp4"
    render_draw_on(str(p), str(out), duration_sec=3.0, fps=30, split_len=4)
    cap = cv2.VideoCapture(str(out))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # Find SOME early frame where interior is still mostly white
    # (proves the color hasn't filled yet — outline-first ordering)
    found_white_phase = False
    for idx in range(1, n // 3):
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if not ok:
            continue
        # Far interior of block (>=15px from all edges, beyond dilation reach)
        interior = frame[80:120, 80:120]
        white_frac = ((interior > 240).all(axis=-1)).mean()
        if white_frac > 0.5:
            found_white_phase = True
            break

    cap.set(cv2.CAP_PROP_POS_FRAMES, n - 1)
    ok2, late = cap.read()
    cap.release()
    assert ok2
    # Last frame: interior must be yellow (the fill DID happen by the end)
    late_interior = late[80:120, 80:120]
    assert late_interior[:, :, 1].mean() > 150, "interior not filled by end"
    assert found_white_phase, (
        "no early-frame phase where interior was still mostly white — "
        "color appears to be filling BEFORE the outline is mostly drawn"
    )
