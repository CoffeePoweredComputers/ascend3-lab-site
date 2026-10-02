"""Turn a raw photo into what a coder is allowed to see.

Raw files are never served. Every image goes out rotated, cropped to the
triage keep-rectangle, capped in size and re-encoded from pixels alone, which
is what drops EXIF (device, timestamps, sometimes GPS).
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Optional

from PIL import Image

from annotate import config

MAX_SIDE = 1600
# A decompression-bomb guard well above the largest real photo (2000 px a side).
Image.MAX_IMAGE_PIXELS = 40_000_000

# Degrees clockwise, as the triage form offers them.
_TRANSPOSE = {
    90: Image.Transpose.ROTATE_270,
    180: Image.Transpose.ROTATE_180,
    270: Image.Transpose.ROTATE_90,
}

Crop = tuple[float, float, float, float]  # x, y, w, h as fractions of the rotated image


def render(raw: Path, rotation: int = 0, crop: Optional[Crop] = None) -> bytes:
    with Image.open(raw) as source:
        image = source.convert("RGB")
    if rotation in _TRANSPOSE:
        image = image.transpose(_TRANSPOSE[rotation])
    if crop:
        x, y, w, h = crop
        width, height = image.size
        box = (round(x * width), round(y * height), round((x + w) * width), round((y + h) * height))
        image = image.crop(box)
    image.thumbnail((MAX_SIDE, MAX_SIDE))
    # A new image from the pixel data: nothing from the original file's
    # metadata can ride along.
    clean = Image.new("RGB", image.size)
    clean.paste(image)
    out = io.BytesIO()
    clean.save(out, "JPEG", quality=85)
    return out.getvalue()


def served(item, uncropped: bool = False) -> bytes:
    """The derived JPEG for an item row, cached under /data/derived by the
    item's triage revision so a new rotation or crop takes effect at once."""
    crop = None
    if not uncropped and item["crop_w"]:
        crop = (item["crop_x"], item["crop_y"], item["crop_w"], item["crop_h"])
    directory = config.derived_dir()
    directory.mkdir(parents=True, exist_ok=True)
    suffix = "-full" if uncropped else ""
    target = directory / f"{item['token']}-{item['rev']}{suffix}.jpg"
    if target.exists():
        return target.read_bytes()
    data = render(config.raw_dir() / item["raw_path"], item["rotation"], crop)
    for stale in directory.glob(f"{item['token']}-*{suffix}.jpg"):
        if uncropped or "-full" not in stale.name:
            stale.unlink(missing_ok=True)
    tmp = target.with_suffix(".tmp")
    tmp.write_bytes(data)
    tmp.replace(target)
    return data
