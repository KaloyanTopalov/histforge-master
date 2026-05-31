"""Pure-function algorithm primitives for the draw-on render.

Originally adapted from daslearning-org/image-to-animation-offline (MIT).
Modifications: progressive-color compositor replaces binary writing;
hand-sprite code removed; native resolution preserved.
"""

import cv2
import numpy as np
from typing import Tuple, List


def preprocess_image(img_bgr: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Convert a BGR image to (grayscale, binary threshold).

    The threshold is the source of stroke-order traversal: black pixels are
    "ink to draw", white pixels are background.
    """
    if img_bgr is None or img_bgr.size == 0:
        raise ValueError("preprocess_image: empty image")
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    thresh = cv2.adaptiveThreshold(
        gray, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        15, 10,  # block_size, C — matched to daslearning's defaults
    )
    return gray, thresh


def build_traversal(
    thresh: np.ndarray,
    split_len: int,
    black_pixel_threshold: int = 10,
) -> List[Tuple[int, int]]:
    """Cut threshold into split_len x split_len grid cells. Return cells that
    contain >=1 black pixel, ordered by nearest-neighbor walk from the first
    such cell (top-left-most). This is the per-frame writing order during
    the draw-on.
    """
    H, W = thresh.shape
    n_v = H // split_len
    n_h = W // split_len
    cells_with_ink: List[Tuple[int, int]] = []
    for gy in range(n_v):
        for gx in range(n_h):
            block = thresh[
                gy * split_len:(gy + 1) * split_len,
                gx * split_len:(gx + 1) * split_len,
            ]
            if (block < black_pixel_threshold).any():
                cells_with_ink.append((gy, gx))
    if not cells_with_ink:
        return []
    # Nearest-neighbor walk starting from the first found cell
    ordered = [cells_with_ink[0]]
    remaining = list(cells_with_ink[1:])
    while remaining:
        last = ordered[-1]
        idx_best = 0
        d_best = float("inf")
        for i, c in enumerate(remaining):
            d = (c[0] - last[0]) ** 2 + (c[1] - last[1]) ** 2
            if d < d_best:
                d_best = d
                idx_best = i
        ordered.append(remaining.pop(idx_best))
    return ordered


def compute_skip_rate(n_cells: int, duration_sec: float, fps: int) -> int:
    """Pick skip_rate so n_cells / skip_rate <= duration_sec * fps.

    skip_rate = ceil(n_cells / target_frames), bounded below by 1.
    A lower skip rate writes more frames per cell (slower drawing).
    """
    target_frames = max(1, int(duration_sec * fps))
    if n_cells <= 0:
        return 1
    return max(1, (n_cells + target_frames - 1) // target_frames)
