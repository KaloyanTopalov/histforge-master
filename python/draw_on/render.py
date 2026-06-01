"""Render integration: stitches algorithm primitives into the actual mp4 write."""

import cv2
import numpy as np

from . import algorithm

DEFAULT_SPLIT_LEN = 4
DEFAULT_FPS = 60
DEFAULT_DILATION_PX = 12


def _ceil_even_multiple(n: int, m: int) -> int:
    """Smallest integer >= n that is a multiple of m AND even (mp4v needs even dims)."""
    p = ((n + m - 1) // m) * m
    if p % 2 != 0:
        p += m
    return p


def render_draw_on(
    image_path: str,
    output_path: str,
    duration_sec: float,
    fps: int = DEFAULT_FPS,
    split_len: int = DEFAULT_SPLIT_LEN,
    dilation_px: int = DEFAULT_DILATION_PX,
) -> None:
    """Read a static image, write a draw-on mp4 of duration_sec.

    Output dims are PADDED (with white) up to a multiple of split_len and to
    even values (mp4v requirement). Source content is never trimmed.
    """
    img_bgr = cv2.imread(image_path)
    if img_bgr is None:
        raise FileNotFoundError(f"Cannot read image: {image_path}")
    H, W = img_bgr.shape[:2]
    H_pad = _ceil_even_multiple(H, split_len)
    W_pad = _ceil_even_multiple(W, split_len)
    if (H_pad, W_pad) != (H, W):
        padded = np.full((H_pad, W_pad, 3), 255, dtype=np.uint8)
        padded[:H, :W] = img_bgr
        img_bgr = padded
        H, W = H_pad, W_pad

    _, thresh = algorithm.preprocess_image(img_bgr)
    traversal = algorithm.build_traversal(thresh, split_len)
    n_cells = len(traversal)
    target_frames = max(1, int(duration_sec * fps))

    # Detect flat color regions and compute per-region OUTLINE cells —
    # the grid cells that contain ink pixels near the region's boundary.
    # A region's color fill triggers only AFTER >=fire_threshold of its outline
    # cells have been drawn by build_traversal. This guarantees the black
    # line work goes down FIRST, color fills SECOND — never color before lines.
    color_regions = algorithm.detect_color_regions(img_bgr)
    cell_to_outlines: dict = {}
    total_outline_cells: list = []
    count_drawn_per_region: list = []
    fire_threshold = 0.9
    if color_regions:
        _, thresh_full = algorithm.preprocess_image(img_bgr)
        ink_mask = (thresh_full == 0)
        boundary_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))  # ~5px radius
        n_cy = H // split_len
        n_cx = W // split_len
        outline_cells_per_region = []
        for region in color_regions:
            region_dilated = cv2.dilate(region, boundary_kernel)
            outline_pixels = (region_dilated > 0) & ink_mask
            outline_cells_set = set()
            for gy in range(n_cy):
                for gx in range(n_cx):
                    block = outline_pixels[
                        gy * split_len:(gy + 1) * split_len,
                        gx * split_len:(gx + 1) * split_len,
                    ]
                    if block.any():
                        outline_cells_set.add((gy, gx))
            outline_cells_per_region.append(outline_cells_set)
        for rid, cells in enumerate(outline_cells_per_region):
            for cell in cells:
                cell_to_outlines.setdefault(cell, []).append(rid)
        total_outline_cells = [len(c) for c in outline_cells_per_region]
        count_drawn_per_region = [0] * len(color_regions)
    fired = [False] * len(color_regions)

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
        mask = np.zeros((H, W), dtype=np.uint8)        # grid-traversal cells — DILATED
        fill_mask = np.zeros((H, W), dtype=np.uint8)   # flood-fill regions — EXACT (no dilation)
        kernel = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (dilation_px, dilation_px)
        )
        frames_written = 0
        for i, (gy, gx) in enumerate(traversal):
            mask[
                gy * split_len:(gy + 1) * split_len,
                gx * split_len:(gx + 1) * split_len,
            ] = 255
            # Outline-driven flood-fill: a region's color fills into fill_mask
            # only AFTER >=fire_threshold of its outline cells are drawn.
            # fill_mask gets the region's color pixels (not line pixels) and
            # is composed EXACT (no dilation), so it never pulls adjacent line
            # work into the reveal.
            for rid in cell_to_outlines.get((gy, gx), ()):
                count_drawn_per_region[rid] += 1
                if (
                    not fired[rid]
                    and total_outline_cells[rid] > 0
                    and count_drawn_per_region[rid]
                    >= fire_threshold * total_outline_cells[rid]
                ):
                    fill_mask[color_regions[rid] > 0] = 255
                    fired[rid] = True
            if i % skip_rate == 0:
                frame = algorithm.progressive_frame(
                    img_bgr, mask, kernel, flat_fill_mask=fill_mask
                )
                writer.write(frame)
                frames_written += 1
        # ALWAYS write a final-revealed frame after the loop. Catches cells
        # visited after the last skip-rate write — without this, the video's
        # last frame can miss ~skip_rate cells of revealed content.
        # NB: still progressive_frame, never img_bgr raw — no end-flip.
        final_frame = algorithm.progressive_frame(
            img_bgr, mask, kernel, flat_fill_mask=fill_mask
        )
        writer.write(final_frame)
        frames_written += 1
        # Pad to target duration
        while frames_written < target_frames:
            writer.write(final_frame)
            frames_written += 1
    finally:
        writer.release()
