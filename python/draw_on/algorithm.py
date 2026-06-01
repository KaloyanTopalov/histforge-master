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


def progressive_frame(
    colored_bgr: np.ndarray,
    drawn_mask: np.ndarray,
    dilation_kernel: np.ndarray,
    flat_fill_mask: np.ndarray | None = None,
) -> np.ndarray:
    """Composite the current draw-on frame.

    `drawn_mask` (grid-traversal cells) is DILATED so color leaks slightly
    past the strokes — this is what makes color emerge WITH the lines.

    `flat_fill_mask` (optional, from flood-fill of detected color regions)
    is composed EXACTLY — no dilation. This prevents the fill from pulling
    adjacent line-work pixels into the reveal via dilation, so black line
    work continues to draw stroke-by-stroke via the grid traversal even
    after a region has been flood-filled.
    """
    dilated = cv2.dilate(drawn_mask, dilation_kernel)
    if flat_fill_mask is not None:
        visible = (dilated > 0) | (flat_fill_mask > 0)
    else:
        visible = dilated > 0
    visible_3 = np.stack([visible, visible, visible], axis=-1)
    white = np.full_like(colored_bgr, 255)
    return np.where(visible_3, colored_bgr, white).astype(np.uint8)


def detect_color_regions(
    img_bgr: np.ndarray,
    white_threshold: int = 230,
    black_threshold: int = 60,
    min_area: int = 200,
    max_ink_fraction: float = 0.30,
) -> List[np.ndarray]:
    """Detect connected regions of FLAT color — not white background, not
    line work, not hatched/textured regions.

    A "flat color region" is a connected component of pixels with grayscale
    value between black_threshold and white_threshold (i.e. not pure white
    and not pure black). Regions where the adaptive-threshold detects
    significant ink (> max_ink_fraction of the region's pixels) are excluded
    — these are sketchy/hatched regions (e.g. shaded US-state silhouettes)
    that already get drawn progressively by build_traversal, so flood-filling
    them would short-circuit the natural drawing motion.

    Returns a list of binary masks (uint8, 0 or 255) the same H x W as input.
    """
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    not_white = gray < white_threshold
    not_black = gray > black_threshold
    color_mask = (not_white & not_black).astype(np.uint8) * 255

    thresh = cv2.adaptiveThreshold(
        gray, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        15, 10,
    )
    ink_mask = (thresh == 0)

    n_components, labels, stats, _ = cv2.connectedComponentsWithStats(
        color_mask, connectivity=8
    )
    regions: List[np.ndarray] = []
    for label in range(1, n_components):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        region_bool = (labels == label)
        ink_in_region = int((region_bool & ink_mask).sum())
        if ink_in_region / area > max_ink_fraction:
            continue  # hatched/textured — skip flood-fill
        regions.append((region_bool.astype(np.uint8) * 255))
    return regions
