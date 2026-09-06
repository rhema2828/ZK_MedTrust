"""PHASE 4 - generate the synthetic demo images.

Produces the six PNG files under zk/data/images/ that
zk/data/sample_dataset.json's image_sha256 fields commit to, and prints
each file's real SHA-256 so it can be cross-checked against the dataset.

These are SYNTHETIC placeholder images - a gradient background with a
brighter or darker rectangle, styled after ml_inference.py's own
_make_synthetic_xray() self-test image. They are not real medical images.
Re-running this script reproduces byte-identical files (same fixed
parameters every time), so the committed image_sha256 values never drift.

    python zk/evaluation/make_synthetic_images.py
"""

import hashlib
from pathlib import Path

import numpy as np
from PIL import Image

ZK_DIR = Path(__file__).resolve().parent.parent
OUT_DIR = ZK_DIR / "data" / "images"
SIZE = 224

# (record_id, gradient base, rectangle (row0, row1, col0, col1), rectangle fill)
# Fixed on purpose - this is what makes regeneration reproducible.
RECORDS = [
    ("SYN-001", 20, (40, 80, 40, 80), 235),
    ("SYN-002", 40, (60, 100, 60, 100), 25),
    ("SYN-003", 60, (30, 70, 100, 140), 235),
    ("SYN-004", 80, (90, 130, 30, 70), 235),
    ("SYN-005", 100, (50, 90, 150, 190), 20),
    ("SYN-006", 120, (110, 150, 110, 150), 15),
]


def make_image(base: int, rect: tuple[int, int, int, int], fill: int) -> Image.Image:
    gradient = np.linspace(base, base + 180, SIZE, dtype=np.uint8)
    array = np.tile(gradient, (SIZE, 1))
    r0, r1, c0, c1 = rect
    array[r0:r1, c0:c1] = fill
    return Image.fromarray(array, mode="L").convert("RGB")


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for record_id, base, rect, fill in RECORDS:
        path = OUT_DIR / f"{record_id}.png"
        make_image(base, rect, fill).save(path)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        print(f"{record_id}: {path.relative_to(ZK_DIR.parent)}  sha256={digest}")


if __name__ == "__main__":
    main()
