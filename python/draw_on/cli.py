"""CLI entry point. Fails loudly with a clear message if deps are missing."""

import argparse
import sys
from pathlib import Path


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m draw_on",
        description="Generate a contour-style draw-on animation video from a static image.",
    )
    parser.add_argument("image_path", help="Path to input image (PNG, JPG, etc)")
    parser.add_argument("duration_sec", type=float, help="Output video duration in seconds")
    parser.add_argument("output_path", help="Path to output mp4")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--split-len", type=int, default=10)
    parser.add_argument("--dilation-px", type=int, default=12)
    args = parser.parse_args(argv)

    # Early-fail import check — give a clear message if the env isn't set up
    try:
        import cv2  # noqa: F401
        import numpy  # noqa: F401
    except ImportError as e:
        missing = getattr(e, "name", "an algorithm dependency")
        print(
            f"ERROR: Python draw-on not configured (missing {missing}). "
            f"Run setup.ps1 / setup.sh or 'pip install -r requirements.txt'.",
            file=sys.stderr,
        )
        return 2

    if not Path(args.image_path).exists():
        print(f"ERROR: input image not found: {args.image_path}", file=sys.stderr)
        return 1

    Path(args.output_path).parent.mkdir(parents=True, exist_ok=True)

    from .render import render_draw_on
    try:
        render_draw_on(
            args.image_path,
            args.output_path,
            args.duration_sec,
            fps=args.fps,
            split_len=args.split_len,
            dilation_px=args.dilation_px,
        )
    except Exception as e:
        print(f"ERROR: render failed: {e}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
