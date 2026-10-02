"""What leaves the tool as an image: rotated, cropped, and with no metadata."""

import io

from PIL import Image

from annotate import images


def photo(tmp_path, size=(400, 200)):
    """A landscape JPEG with EXIF and a red top-left quarter."""
    image = Image.new("RGB", size, (255, 255, 255))
    image.paste((255, 0, 0), (0, 0, size[0] // 2, size[1] // 2))
    exif = Image.Exif()
    exif[0x010F] = "PhoneMaker"  # Make
    exif[0x0132] = "2026:02:24 23:52:00"  # DateTime
    path = tmp_path / "raw.jpg"
    image.save(path, "JPEG", exif=exif)
    assert Image.open(path).getexif()
    return path


def opened(data: bytes) -> Image.Image:
    return Image.open(io.BytesIO(data))


def is_red(pixel) -> bool:
    return pixel[0] > 200 and pixel[1] < 80 and pixel[2] < 80


def test_exif_is_dropped(tmp_path):
    out = images.render(photo(tmp_path))
    assert not opened(out).getexif()
    assert b"PhoneMaker" not in out and b"2026:02:24" not in out


def test_rotation_is_clockwise(tmp_path):
    result = opened(images.render(photo(tmp_path), rotation=90))
    assert result.size == (200, 400)
    # The red quarter was top-left; a quarter-turn clockwise puts it top-right.
    assert is_red(result.getpixel((150, 50))) and not is_red(result.getpixel((50, 50)))


def test_crop_keeps_only_the_rectangle(tmp_path):
    result = opened(images.render(photo(tmp_path), crop=(0.5, 0.0, 0.5, 1.0)))
    assert result.size == (200, 200)
    assert not any(is_red(result.getpixel((x, y))) for x in range(10, 200, 30) for y in range(10, 200, 30))


def test_large_photos_are_capped(tmp_path):
    assert max(opened(images.render(photo(tmp_path, (3000, 1500)))).size) == images.MAX_SIDE


def test_cache_follows_the_triage_revision(tmp_path, monkeypatch):
    monkeypatch.setenv("ANNOTATE_DATA_DIR", str(tmp_path))
    raw = tmp_path / "raw" / "d"
    raw.mkdir(parents=True)
    photo(raw).rename(raw / "tok.jpg")
    item = dict(token="tok", raw_path="d/tok.jpg", rev=0, rotation=0, crop_x=None, crop_y=None, crop_w=None, crop_h=None)
    first = images.served(item)
    assert opened(first).size == (400, 200)
    turned = images.served({**item, "rev": 1, "rotation": 90})
    assert opened(turned).size == (200, 400)
    assert [p.name for p in (tmp_path / "derived").iterdir()] == ["tok-1.jpg"]  # the stale copy is gone
