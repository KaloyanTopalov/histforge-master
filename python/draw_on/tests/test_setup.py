"""Dependency sanity — confirms cv2 and numpy import in the active env."""

def test_cv2_imports():
    import cv2
    assert cv2.__version__.startswith("4.")

def test_numpy_imports():
    import numpy
    assert numpy.__version__.startswith(("1.", "2."))

def test_draw_on_imports():
    import draw_on
    assert draw_on.__version__ == "0.1.0"
