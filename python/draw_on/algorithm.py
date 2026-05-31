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
