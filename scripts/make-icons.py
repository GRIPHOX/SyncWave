"""Renders the SyncWave app icon (build/icon.ico, build/icon.png, resources/tray*.png).

A rounded tile with a violet-to-teal gradient and five waveform bars.
Run: python scripts/make-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
S = 1024


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def tile(size=S):
    top, bottom = (124, 92, 255), (24, 214, 196)
    grad = Image.new("RGB", (size, size))
    px = grad.load()
    for y in range(size):
        for x in range(size):
            t = (x * 0.35 + y * 0.65) / size
            px[x, y] = lerp(top, bottom, min(1, t))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * 0.23), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def bars(img, color=(255, 255, 255, 255), scale=1.0):
    d = ImageDraw.Draw(img)
    size = img.size[0]
    heights = [0.30, 0.58, 0.82, 0.50, 0.26]
    bw = size * 0.085 * scale
    gap = size * 0.06 * scale
    total = len(heights) * bw + (len(heights) - 1) * gap
    x = (size - total) / 2
    for h in heights:
        bh = size * h * 0.78 * scale
        y0 = (size - bh) / 2
        d.rounded_rectangle((x, y0, x + bw, y0 + bh), radius=bw / 2, fill=color)
        x += bw + gap


def main():
    (ROOT / "build").mkdir(exist_ok=True)
    (ROOT / "resources").mkdir(exist_ok=True)
    icon = tile()
    bars(icon)
    icon.save(ROOT / "build" / "icon.png")
    icon.save(ROOT / "build" / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    icon.resize((256, 256), Image.LANCZOS).save(ROOT / "resources" / "icon.png")

    # Tray: the tile at small sizes, plus a "live" variant with a red dot.
    for name, live in (("tray", False), ("tray-live", True)):
        t = icon.resize((64, 64), Image.LANCZOS)
        if live:
            d = ImageDraw.Draw(t)
            d.ellipse((38, 38, 63, 63), fill=(255, 71, 87, 255), outline=(20, 20, 30, 255), width=3)
        t.save(ROOT / "resources" / f"{name}.png")
    print("icons written")


if __name__ == "__main__":
    main()
