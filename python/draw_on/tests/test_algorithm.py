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
