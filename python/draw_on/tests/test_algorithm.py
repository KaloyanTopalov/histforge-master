import numpy as np
import pytest

from draw_on.algorithm import preprocess_image


def test_preprocess_image_returns_gray_and_threshold():
    img = np.full((100, 100, 3), 255, dtype=np.uint8)
    gray, thresh = preprocess_image(img)
    assert gray.shape == (100, 100)
    assert thresh.shape == (100, 100)
    assert gray.dtype == np.uint8
    assert thresh.dtype == np.uint8


def test_preprocess_all_white_produces_no_black_threshold():
    img = np.full((100, 100, 3), 255, dtype=np.uint8)
    _, thresh = preprocess_image(img)
    assert (thresh == 255).all()


def test_preprocess_with_black_region_finds_dark_pixels():
    img = np.full((100, 100, 3), 255, dtype=np.uint8)
    img[30:50, 30:50] = 0
    _, thresh = preprocess_image(img)
    assert (thresh == 0).any()


def test_preprocess_empty_image_raises():
    with pytest.raises(ValueError, match="empty image"):
        preprocess_image(np.zeros((0, 0, 3), dtype=np.uint8))


from draw_on.algorithm import build_traversal


def test_traversal_empty_image_returns_empty():
    thresh = np.full((100, 100), 255, dtype=np.uint8)
    assert build_traversal(thresh, split_len=10) == []


def test_traversal_single_black_cell():
    thresh = np.full((100, 100), 255, dtype=np.uint8)
    thresh[20:30, 20:30] = 0
    cells = build_traversal(thresh, split_len=10)
    assert (2, 2) in cells
    assert len(cells) >= 1


def test_traversal_nn_order_differs_from_row_major():
    """Pin NN walk behavior — not just row-major iteration.

    Geometry: A=(0,0), B=(0,5), C=(2,0), D=(10,10).
    Row-major build order: A, B, C, D.
    NN from A picks C next (distance 2) before B (distance 5).
    So pos_C < pos_B holds only if NN is actually walking by distance.
    """
    thresh = np.full((200, 200), 255, dtype=np.uint8)
    thresh[0:10, 0:10] = 0       # A = (0, 0)
    thresh[0:10, 50:60] = 0      # B = (0, 5) — row-major encounters B before C
    thresh[20:30, 0:10] = 0      # C = (2, 0) — distance 2 from A (closer than B)
    thresh[100:110, 100:110] = 0 # D = (10, 10) — far from all
    cells = build_traversal(thresh, split_len=10)
    pos_A = cells.index((0, 0))
    pos_B = cells.index((0, 5))
    pos_C = cells.index((2, 0))
    pos_D = cells.index((10, 10))
    assert pos_A == 0, "NN should start at the first row-major cell"
    assert pos_C < pos_B, (
        "NN should pick (2,0) before (0,5) — closer to (0,0). "
        "If this fails, the walk is row-major, not NN."
    )
    assert pos_D == 3, "Farthest cell should be last in the NN walk"


from draw_on.algorithm import compute_skip_rate


def test_skip_rate_one_when_cells_fit_frames():
    # 100 cells, 4 sec, 25 fps → target_frames=100 → skip=1
    assert compute_skip_rate(100, 4.0, 25) == 1


def test_skip_rate_skips_when_more_cells_than_frames():
    # 1000 cells, 4 sec, 25 fps → target_frames=100 → skip=10
    assert compute_skip_rate(1000, 4.0, 25) == 10


def test_skip_rate_minimum_one():
    assert compute_skip_rate(1, 100.0, 30) == 1
    assert compute_skip_rate(0, 1.0, 30) == 1


def test_skip_rate_ceiling_not_floor():
    # 105 cells, 100 target frames → ceiling = 2 (so all cells get drawn)
    assert compute_skip_rate(105, 100 / 30, 30) == 2


import cv2

from draw_on.algorithm import progressive_frame


@pytest.fixture
def small_kernel():
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))


def test_progressive_frame_all_drawn_is_colored(small_kernel):
    colored = np.full((50, 50, 3), [128, 64, 32], dtype=np.uint8)
    mask = np.full((50, 50), 255, dtype=np.uint8)
    frame = progressive_frame(colored, mask, small_kernel)
    assert (frame == colored).all()


def test_progressive_frame_nothing_drawn_is_white(small_kernel):
    colored = np.full((50, 50, 3), [128, 64, 32], dtype=np.uint8)
    mask = np.zeros((50, 50), dtype=np.uint8)
    frame = progressive_frame(colored, mask, small_kernel)
    assert (frame == 255).all()


def test_progressive_frame_partial_mixes_colored_and_white(small_kernel):
    colored = np.full((50, 50, 3), [128, 64, 32], dtype=np.uint8)
    mask = np.zeros((50, 50), dtype=np.uint8)
    mask[20:30, 20:30] = 255
    frame = progressive_frame(colored, mask, small_kernel)
    # Drawn center is colored
    assert (frame[25, 25] == [128, 64, 32]).all()
    # Untouched corner is white
    assert (frame[0, 0] == 255).all()


def test_progressive_frame_dilation_expands_colored_region(small_kernel):
    """A larger kernel reveals more pixels around the drawn area."""
    colored = np.full((50, 50, 3), [128, 64, 32], dtype=np.uint8)
    mask = np.zeros((50, 50), dtype=np.uint8)
    mask[24:26, 24:26] = 255  # 2x2 region
    small_frame = progressive_frame(colored, mask, small_kernel)
    big_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    big_frame = progressive_frame(colored, mask, big_kernel)
    small_count = (small_frame == colored).all(axis=-1).sum()
    big_count = (big_frame == colored).all(axis=-1).sum()
    assert big_count > small_count


def test_progressive_frame_flat_fill_mask_no_dilation(small_kernel):
    """flat_fill_mask reveals pixels EXACTLY where set — no dilation past the
    boundary. This is what keeps flood-fills from pulling adjacent line-work
    pixels into the reveal."""
    colored = np.full((50, 50, 3), [128, 64, 32], dtype=np.uint8)
    drawn = np.zeros((50, 50), dtype=np.uint8)
    fill = np.zeros((50, 50), dtype=np.uint8)
    fill[20:30, 20:30] = 255  # exact 10x10 fill
    frame = progressive_frame(colored, drawn, small_kernel, flat_fill_mask=fill)
    # Inside the fill: colored
    assert (frame[25, 25] == colored[25, 25]).all()
    # Immediately outside the fill boundary: still WHITE (no dilation)
    assert (frame[19, 25] == 255).all(), "flat_fill_mask should not dilate"
    assert (frame[30, 25] == 255).all()
    assert (frame[25, 19] == 255).all()
    assert (frame[25, 30] == 255).all()


from draw_on.algorithm import detect_color_regions


def test_detect_color_regions_finds_flat_color_blocks():
    """Two large solid color blocks on white = 2 regions.

    Block size matters: tiny blocks have huge perimeter-to-area ratio, so edge
    ink (from adaptiveThreshold detecting the block/background transition)
    dominates and they get rejected by max_ink_fraction. The flood-fill is
    designed for blocks where dilation can't cover the interior in the first
    place — those are by definition LARGER than the dilation kernel.
    """
    img = np.full((200, 200, 3), 255, dtype=np.uint8)
    img[10:90, 10:90] = [0, 200, 0]        # 80x80 green BGR — gray ~117
    img[110:190, 110:190] = [50, 50, 200]  # 80x80 red-ish BGR — gray ~95
    regions = detect_color_regions(img)
    assert len(regions) == 2
    for r in regions:
        assert r.shape == (200, 200)
        assert r.dtype == np.uint8
        assert (r > 0).sum() > 0


def test_detect_color_regions_skips_hatched_textured_areas():
    """A region with lots of line work is treated as 'sketchy', not a flat block."""
    img = np.full((100, 100, 3), 255, dtype=np.uint8)
    # Gray region with many black hatch lines — should be excluded
    img[10:60, 10:60] = [180, 180, 180]
    for y in range(10, 60, 4):
        img[y:y+1, 10:60] = [0, 0, 0]  # hatch lines
    regions = detect_color_regions(img)
    # Hatched region should not be returned (high ink_fraction)
    assert len(regions) == 0


def test_detect_color_regions_skips_tiny_regions():
    """Regions below min_area are dropped (noise filter)."""
    img = np.full((100, 100, 3), 255, dtype=np.uint8)
    img[10:12, 10:12] = [0, 200, 0]  # tiny 2x2 block, well under default min_area=200
    regions = detect_color_regions(img)
    assert len(regions) == 0
