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
