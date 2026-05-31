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
