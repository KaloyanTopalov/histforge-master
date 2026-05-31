"""Render integration: stitches algorithm primitives into the actual mp4 write."""

import cv2
import numpy as np

from . import algorithm

DEFAULT_SPLIT_LEN = 10
DEFAULT_FPS = 30
DEFAULT_DILATION_PX = 12


def render_draw_on(
    image_path: str,
    output_path: str,
    duration_sec: float,
    fps: int = DEFAULT_FPS,
    split_len: int = DEFAULT_SPLIT_LEN,
    dilation_px: int = DEFAULT_DILATION_PX,
) -> None:
    """Read a static image, write a draw-on mp4 of duration_sec.

    Output is at the input's native resolution (trimmed to a multiple of
    split_len on each axis). No find_nearest_res snapping.
    """
    img_bgr = cv2.imread(image_path)
    if img_bgr is None:
        raise FileNotFoundError(f"Cannot read image: {image_path}")
    H, W = img_bgr.shape[:2]
    Hpad = (H // split_len) * split_len
    Wpad = (W // split_len) * split_len
    if (Hpad, Wpad) != (H, W):
        img_bgr = img_bgr[:Hpad, :Wpad]
        H, W = Hpad, Wpad

    _, thresh = algorithm.preprocess_image(img_bgr)
    traversal = algorithm.build_traversal(thresh, split_len)
    n_cells = len(traversal)
    target_frames = max(1, int(duration_sec * fps))

    writer = cv2.VideoWriter(
        output_path,
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (W, H),
    )
    try:
        if n_cells == 0:
            # All-white input: emit target_frames of solid white
            white = np.full_like(img_bgr, 255)
            for _ in range(target_frames):
                writer.write(white)
            return

        skip_rate = algorithm.compute_skip_rate(n_cells, duration_sec, fps)
        mask = np.zeros((H, W), dtype=np.uint8)
        kernel = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (dilation_px, dilation_px)
        )
        frames_written = 0
        for i, (gy, gx) in enumerate(traversal):
            mask[
                gy * split_len:(gy + 1) * split_len,
                gx * split_len:(gx + 1) * split_len,
            ] = 255
            if i % skip_rate == 0:
                frame = algorithm.progressive_frame(img_bgr, mask, kernel)
                writer.write(frame)
                frames_written += 1
        # Pad to exact target_frames with the fully-revealed frame.
        # NB: progressive_frame(img_bgr, FULL_mask, kernel) — never img_bgr raw.
        final_frame = algorithm.progressive_frame(img_bgr, mask, kernel)
        while frames_written < target_frames:
            writer.write(final_frame)
            frames_written += 1
    finally:
        writer.release()
