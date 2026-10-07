"""Render the AI SHOP logo (public/favicon.svg) to PNG icons for the Chrome
extension manifest (Chrome needs PNG, not SVG). Pure Python, no packages:
    python scripts/make_icons.py
"""
import struct
import zlib
from pathlib import Path

INK, WHITE, RED = (17, 17, 17), (255, 255, 255), (208, 2, 27)

# Same shapes as favicon.svg, in its 64×64 coordinate space
A_OUTER = [(10, 50), (20, 14), (29, 14), (39, 50), (31.5, 50), (29.6, 42), (19.4, 42), (17.5, 50)]
A_HOLE = [(21, 35.5), (28, 35.5), (24.5, 21.5)]
I_RECT = (42, 14, 49.5, 50)
DOT_RECT = (52.5, 43, 59.5, 50)


def inside(poly, x, y):
    hit = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def color_at(x, y):
    if DOT_RECT[0] <= x < DOT_RECT[2] and DOT_RECT[1] <= y < DOT_RECT[3]:
        return RED
    if I_RECT[0] <= x < I_RECT[2] and I_RECT[1] <= y < I_RECT[3]:
        return WHITE
    if inside(A_OUTER, x, y) and not inside(A_HOLE, x, y):
        return WHITE
    return INK


def render(size, samples=4):
    rows = []
    scale = 64 / size
    for py in range(size):
        row = bytearray([0])                      # PNG filter: none
        for px in range(size):
            acc = [0, 0, 0]
            for sy in range(samples):             # supersample for smooth edges
                for sx in range(samples):
                    c = color_at((px + (sx + 0.5) / samples) * scale, (py + (sy + 0.5) / samples) * scale)
                    for k in range(3):
                        acc[k] += c[k]
            n = samples * samples
            row.extend(round(v / n) for v in acc)
        rows.append(bytes(row))
    return b"".join(rows)


def write_png(path, size):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)   # 8-bit RGB
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(render(size), 9)) + chunk(b"IEND", b"")
    Path(path).write_bytes(png)


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent / "public" / "icons"
    out.mkdir(exist_ok=True)
    for s in (16, 32, 48, 128):
        write_png(out / f"icon{s}.png", s)
        print("wrote", out / f"icon{s}.png")
