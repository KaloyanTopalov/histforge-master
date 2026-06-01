import os
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest


@pytest.fixture
def doodle_image(tmp_path):
    img = np.full((100, 100, 3), 255, dtype=np.uint8)
    img[40:60, 40:60] = 0
    path = tmp_path / "input.png"
    cv2.imwrite(str(path), img)
    return path


def _run_cli(*args):
    repo_root = Path(__file__).parent.parent.parent.parent
    env = {**os.environ, "PYTHONPATH": str(repo_root / "python")}
    cmd = [sys.executable, "-m", "draw_on", *map(str, args)]
    return subprocess.run(cmd, capture_output=True, text=True, env=env)


def test_cli_happy_path(doodle_image, tmp_path):
    out = tmp_path / "out.mp4"
    result = _run_cli(doodle_image, "2.0", out)
    assert result.returncode == 0, f"stderr: {result.stderr}"
    assert out.exists()
    assert out.stat().st_size > 0


def test_cli_missing_input_file(tmp_path):
    out = tmp_path / "out.mp4"
    missing = tmp_path / "nonexistent.png"
    result = _run_cli(missing, "2.0", out)
    assert result.returncode != 0
    assert "not found" in result.stderr.lower()


def test_cli_no_args_shows_usage():
    result = _run_cli()
    assert result.returncode == 2  # argparse error code
    assert "usage" in (result.stderr + result.stdout).lower()


def test_cli_creates_parent_dir(doodle_image, tmp_path):
    out = tmp_path / "nested" / "deeper" / "out.mp4"
    result = _run_cli(doodle_image, "1.0", out)
    assert result.returncode == 0
    assert out.exists()
