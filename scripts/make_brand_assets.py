"""Generate the VendoTube Studio brand assets from the source logos.

Sources (kept untouched, in Logo/):
  - "vendotube-logo-aurora.png"      full artwork with the aurora background
  - "vendotube-logo-aurora no bg.png" the V mark on transparency

Outputs:
  - build/icon.ico                    Windows exe/installer icon: rounded aurora
                                      tile, 16..256 px entries
  - build/icon.png                    512 px rounded tile (electron-builder
                                      fallback + About/screenshots)
  - src/renderer/src/assets/logo-mark.png
                                      256 px transparent V for the in-app UI
                                      (TopBar, Home hero)
  - build/installer-sidebar.bmp       164x314 NSIS wizard sidebar (welcome +
                                      finish pages)
  - build/uninstaller-sidebar.bmp     164x314 NSIS uninstaller sidebar
  - build/installer-header.bmp        150x57 NSIS wizard header strip
  - build/license.txt                 MIT license text for the installer
                                      license page (copy of ../LICENSE)

Run from vendotube-studio/:  python scripts/make_brand_assets.py
Requires Pillow.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC_NO_BG = ROOT / "Logo" / "vendotube-logo-aurora no bg.png"
SRC_FULL = ROOT / "Logo" / "vendotube-logo-aurora.png"
LICENSE_SRC = ROOT / "LICENSE"
OUT_ICO = ROOT / "build" / "icon.ico"
OUT_PNG = ROOT / "build" / "icon.png"
OUT_MARK = ROOT / "src" / "renderer" / "src" / "assets" / "logo-mark.png"
OUT_SIDEBAR = ROOT / "build" / "installer-sidebar.bmp"
OUT_UNSIDEBAR = ROOT / "build" / "uninstaller-sidebar.bmp"
OUT_HEADER = ROOT / "build" / "installer-header.bmp"
OUT_LICENSE = ROOT / "build" / "license.txt"

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
# Fluent/Win11 app-icon corner radius, relative to the tile size.
TILE_RADIUS = 0.15
# How much of the transparent canvas the V mark occupies (UI mark sits a
# little larger than the taskbar tile mark so it fills its box in the UI).
MARK_FILL = 0.88

# Installer art palette — matches src/renderer/src/styles/tokens.css (dark).
BG_TOP = (10, 13, 20)     # --bg        #0a0d14
BG_BOTTOM = (17, 26, 46)  # lifted navy
ACCENT = (139, 124, 255)  # --accent    #8b7cff
SIGNAL = (60, 224, 208)   # --signal    #3ce0d0
INK = (234, 240, 247)     # --ink       #eaf0f7
MUTED = (139, 149, 167)   # --ink-muted #8b95a7
FAINT = (99, 110, 133)    # dimmer ink-muted

TAGLINE = "One brief, one crew,\none film."


def load_rgba(path: Path) -> Image.Image:
    img = Image.open(path)
    return img.convert("RGBA")


def rounded_tile(img: Image.Image, size: int) -> Image.Image:
    """Resize `img` to size x size and round the corners (transparent outside)."""
    tile = img.resize((size, size), Image.LANCZOS).convert("RGBA")
    mask = Image.new("L", (size, size), 0)
    radius = max(1, round(size * TILE_RADIUS))
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    tile.putalpha(mask)
    return tile


def trimmed_mark(img: Image.Image, size: int, fill: float) -> Image.Image:
    """Center the V mark (alpha bbox) on a transparent size x size canvas."""
    alpha = img.getchannel("A")
    bbox = alpha.point(lambda a: 255 if a > 8 else 0).getbbox()
    if bbox:
        img = img.crop(bbox)
    # Keep the aspect square by fitting into a fill x fill box, centered.
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    box = round(size * fill)
    fitted = img.copy()
    fitted.thumbnail((box, box), Image.LANCZOS)
    x = (size - fitted.width) // 2
    y = (size - fitted.height) // 2
    canvas.paste(fitted, (x, y), fitted)
    return canvas


# ---------------------------------------------------------------------------
# Installer wizard art (NSIS MUI2 requires plain 24-bit BMPs, exact sizes).
# ---------------------------------------------------------------------------

_FONT_PATHS = {
    "bold": ["C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/seguisb.ttf"],
    "regular": ["C:/Windows/Fonts/segoeui.ttf"],
    "light": ["C:/Windows/Fonts/segoeuil.ttf", "C:/Windows/Fonts/segoeuisl.ttf"],
}


def font(weight: str, size: int) -> ImageFont.ImageFont:
    for path in _FONT_PATHS[weight]:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def radial_glow(size: int, color: tuple[int, int, int], peak_alpha: int) -> Image.Image:
    """Soft radial blob of `color`, peak `peak_alpha` at the center."""
    grad = Image.radial_gradient("L").resize((size, size), Image.LANCZOS)
    alpha = grad.point(lambda v: round((255 - v) * peak_alpha / 255))
    glow = Image.new("RGBA", (size, size), color + (0,))
    glow.putalpha(alpha)
    return glow


def aurora_bg(w: int, h: int, dim: float = 1.0) -> Image.Image:
    """Dark navy vertical gradient with the two aurora glows (accent top-left,
    signal bottom-right) — the installer strips read as the app's Home."""
    img = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        row = tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM))
        draw.line([(0, y), (w, y)], fill=row)
    img = img.convert("RGBA")
    for color, size, pos, alpha in (
        (ACCENT, 250, (-70, -120), 105),
        (SIGNAL, 220, (50, 190), 88),
    ):
        glow = radial_glow(size, color, alpha)
        # paste-with-mask is source-over onto the opaque base.
        img.paste(glow, pos, glow)
    img = img.convert("RGB")
    if dim < 1.0:
        black = Image.new("RGB", (w, h), (0, 0, 0))
        img = Image.blend(img, black, 1.0 - dim)
    return img


def divider(w: int, h: int) -> Image.Image:
    """Thin horizontal bar blending signal -> accent, for under the wordmark."""
    bar = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(bar)
    for x in range(w):
        t = x / max(1, w - 1)
        draw.line([(x, 0), (x, h)], fill=tuple(round(a + (b - a) * t) for a, b in zip(SIGNAL, ACCENT)))
    return bar


def draw_centered(img: Image.Image, text: str, xy: tuple[int, int], f: ImageFont.ImageFont, fill) -> None:
    ImageDraw.Draw(img).text(xy, text, font=f, fill=fill, anchor="mm")


def make_sidebar(uninstaller: bool = False) -> Image.Image:
    w, h = 164, 314
    dim = 0.62 if uninstaller else 1.0
    img = aurora_bg(w, h, dim=dim)

    mark_size = 92 if uninstaller else 128
    mark = trimmed_mark(mark_src, mark_size, 0.9)
    if uninstaller:
        mark.putalpha(mark.getchannel("A").point(lambda a: round(a * 0.75)))
    img.paste(mark, ((w - mark_size) // 2, 26), mark)

    draw_centered(img, "VendoTube", (w // 2, 186), font("bold", 16), INK)
    draw_centered(img, "S T U D I O", (w // 2, 208), font("regular", 9), MUTED if uninstaller else ACCENT)

    bar = divider(44, 2)
    img.paste(bar, ((w - 44) // 2, 226))

    if uninstaller:
        draw_centered(img, "Removing VendoTube Studio", (w // 2, 246), font("regular", 8), MUTED)
        draw_centered(img, "Projects are kept.", (w // 2, 260), font("regular", 8), FAINT)
    else:
        for i, line in enumerate(TAGLINE.split("\n")):
            draw_centered(img, line, (w // 2, 246 + i * 15), font("regular", 9), MUTED)

    draw_centered(img, "vendoria.ai", (w // 2, 294), font("regular", 8), FAINT)
    return img


def make_header() -> Image.Image:
    w, h = 150, 57
    img = aurora_bg(w, h, dim=0.9)
    tile = rounded_tile(full_src, 40)
    img.paste(tile, (8, 9), tile)
    draw = ImageDraw.Draw(img)
    draw.text((58, 20), "VendoTube", font=font("bold", 12), fill=INK, anchor="lm")
    draw.text((58, 36), "S T U D I O", font=font("regular", 7), fill=MUTED, anchor="lm")
    return img


def main() -> None:
    global full_src, mark_src
    full = load_rgba(SRC_FULL)
    mark_src = load_rgba(SRC_NO_BG)
    full_src = full

    # Windows exe / installer icon: rounded aurora tile, multi-resolution.
    base = rounded_tile(full, 256)
    OUT_ICO.parent.mkdir(parents=True, exist_ok=True)
    base.save(OUT_ICO, format="ICO", sizes=[(s, s) for s in ICO_SIZES])

    rounded_tile(full, 512).save(OUT_PNG, format="PNG")

    # In-app UI mark: transparent V only.
    OUT_MARK.parent.mkdir(parents=True, exist_ok=True)
    trimmed_mark(mark_src, 256, MARK_FILL).save(OUT_MARK, format="PNG")

    # NSIS wizard art: exact-size 24-bit BMPs, no alpha channel.
    make_sidebar(uninstaller=False).save(OUT_SIDEBAR, format="BMP")
    make_sidebar(uninstaller=True).save(OUT_UNSIDEBAR, format="BMP")
    make_header().save(OUT_HEADER, format="BMP")

    # License page text — regenerated from the repo LICENSE so it can't drift.
    shutil.copyfile(LICENSE_SRC, OUT_LICENSE)

    for out in (OUT_ICO, OUT_PNG, OUT_MARK, OUT_SIDEBAR, OUT_UNSIDEBAR, OUT_HEADER, OUT_LICENSE):
        print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
