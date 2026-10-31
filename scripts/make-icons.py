"""Regenerate the app icons from build/logo-1024.png. Run: python -I scripts/make-icons.py [preview-folder]

The logo is drawn on black. That background is made transparent, then a thin
dark outline is put around what remains, so the icon reads on a light taskbar
as well as a dark one. build/logo-1024.png itself is never changed; the
transparent version is written next to it and every icon is made from that.

Given a folder, it also writes previews at 256, 32 and 16 px on white and on
black, to look at before committing.
"""
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

root = Path(__file__).resolve().parent.parent
build = root / "build"

# Brightness is the brightest channel, not luminance: the T's shadowed red is
# near-black by luminance (about 30) but clearly not background (red ~120),
# while the background never passes 18. Below FLOOR is fully transparent;
# from FLOOR to SOLID alpha ramps up, which keeps anti-aliased edges soft.
FLOOR = 20
SOLID = 64
OUTLINE_SHARE = 0.02  # outline width, as a share of the image size
OUTLINE_OPACITY = 0.85


def brightness_of(rgb: Image.Image) -> Image.Image:
    r, g, b = rgb.split()
    return ImageChops.lighter(ImageChops.lighter(r, g), b)


def background_mask(brightness: Image.Image) -> Image.Image:
    """255 where a pixel is dark and connected to the border (the background), 0 elsewhere."""
    dark = brightness.point(lambda v: 255 if v < SOLID else 0)
    # A 1 px dark frame joins every border pixel, so one flood from a corner reaches them all.
    framed = Image.new("L", (brightness.width + 2, brightness.height + 2), 255)
    framed.paste(dark, (1, 1))
    ImageDraw.floodfill(framed, (0, 0), 128)
    return framed.crop((1, 1, brightness.width + 1, brightness.height + 1)).point(lambda v: 255 if v == 128 else 0)


def transparent(logo: Image.Image) -> Image.Image:
    rgb = logo.convert("RGB")
    brightness = brightness_of(rgb)
    connected = background_mask(brightness)
    ramp = brightness.point(lambda v: 0 if v <= FLOOR else 255 if v >= SOLID else round((v - FLOOR) * 255 / (SOLID - FLOOR)))
    # Inside the background region the ramp sets alpha; everywhere else stays opaque.
    alpha = Image.composite(ramp, Image.new("L", rgb.size, 255), connected)
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out


def outlined(image: Image.Image) -> Image.Image:
    """A smooth dark ring around every shape: the alpha blurred outward, then firmed up."""
    width = max(1, round(image.width * OUTLINE_SHARE))
    alpha = image.getchannel("A")
    # A Gaussian of sigma w/2 still holds about 2 % of a solid edge's value w px out;
    # scaling it up turns that into a solid ring of about w px with a soft outer edge.
    spread = alpha.filter(ImageFilter.GaussianBlur(width / 2)).point(lambda v: min(255, v * 12))
    ring = spread.point(lambda v: round(v * OUTLINE_OPACITY))
    shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shadow.putalpha(ring)
    return Image.alpha_composite(shadow, image)


def previews(icon: Image.Image, folder: Path) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for size in (256, 32, 16):
        small = icon.resize((size, size), Image.LANCZOS)
        for name, colour in (("white", (255, 255, 255, 255)), ("black", (0, 0, 0, 255))):
            shot = Image.alpha_composite(Image.new("RGBA", (size, size), colour), small)
            # Small sizes blown up with no smoothing, so each pixel can be judged.
            if size < 256:
                shot = shot.resize((256, 256), Image.NEAREST)
            shot.save(folder / f"icon-{size}-on-{name}.png")


def main() -> None:
    logo = Image.open(build / "logo-1024.png").convert("RGBA")
    icon = outlined(transparent(logo))
    icon.save(build / "logo-1024-transparent.png", optimize=True)
    icon.resize((512, 512), Image.LANCZOS).save(build / "icon.png", optimize=True)
    icon.save(build / "icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
    (root / "src" / "renderer" / "assets").mkdir(parents=True, exist_ok=True)
    icon.resize((128, 128), Image.LANCZOS).save(root / "src" / "renderer" / "assets" / "logo.png", optimize=True)
    if len(sys.argv) > 1:
        previews(icon, Path(sys.argv[1]))
    print("icons written")


if __name__ == "__main__":
    main()
