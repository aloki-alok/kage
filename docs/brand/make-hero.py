"""Writes core/hero.ts: the word kage in Geist Pixel with its cast shadow, as braille for kage top.

Run: uv run --with pillow --with fonttools --with brotli python docs/brand/make-hero.py
A terminal cell is about 2.2 times taller than wide, so the art is drawn at that shape and never stretches.
"""
import io
import json
import math
import pathlib

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).parent
CELL = 2.2
SIZES = {'BIG': 46, 'SMALL': 32}
BITS = [(0, 0, 1), (0, 1, 2), (0, 2, 4), (1, 0, 8), (1, 1, 16), (1, 2, 32), (0, 3, 64), (1, 3, 128)]
DITHER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]


def font(size):
    f = TTFont(HERE / 'fonts' / 'GeistPixel-Square.woff2')
    f.flavor = None
    buf = io.BytesIO()
    f.save(buf)
    buf.seek(0)
    return ImageFont.truetype(buf, size)


def word(text='kage', size=96, pad=6):
    f = font(size)
    b = ImageDraw.Draw(Image.new('L', (1, 1))).textbbox((0, 0), text, font=f)
    img = Image.new('L', (int(b[2] - b[0]) + 2 * pad, int(b[3] - b[1]) + 2 * pad), 0)
    ImageDraw.Draw(img).text((pad - b[0], pad - b[1]), text, font=f, fill=255)
    return img


def shadow(w, squash=0.55, skew_deg=52):
    flipped = w.transpose(Image.Transpose.FLIP_TOP_BOTTOM).resize((w.size[0], max(2, int(w.size[1] * squash))))
    slant = math.tan(math.radians(skew_deg)) * squash
    h = flipped.size[1]
    out = Image.new('L', (int(w.size[0] + h * slant) + 2, h), 0)
    src, dst = flipped.load(), out.load()
    assert src is not None and dst is not None
    for y in range(h):
        fade = 1 - y / h
        for x in range(w.size[0]):
            if src[x, y]:
                dst[x + int(y * slant), y] = int(src[x, y] * fade)
    return out


def scene():
    w = word()
    s = shadow(w)
    width = max(w.size[0], s.size[0])
    ink = Image.new('L', (width, w.size[1] + s.size[1]), 0)
    shade = Image.new('L', ink.size, 0)
    ink.paste(w, (0, 0))
    shade.paste(s, (0, w.size[1]))
    return ink, shade


def braille(cols):
    ink, shade = scene()
    rows = round(cols * ink.size[1] / ink.size[0] / CELL)
    ink = ink.resize((cols * 2, rows * 4), Image.Resampling.BOX)
    shade = shade.resize((cols * 2, rows * 4), Image.Resampling.BOX)
    chars, cls = [], []
    for r in range(rows):
        line, kind = '', ''
        for c in range(cols):
            vi = vs = 0
            for dx, dy, bit in BITS:
                px, py = c * 2 + dx, r * 4 + dy
                if ink.getpixel((px, py)) > 100:
                    vi |= bit
                elif shade.getpixel((px, py)) > (DITHER[py % 4][px % 4] + 1) * 15:
                    vs |= bit
            line += chr(0x2800 + (vi | vs)) if vi or vs else ' '
            kind += 'w' if vi else ('m' if vs and r < rows * 0.75 else 'd') if vs else ' '
        chars.append(line)
        cls.append(kind)
    lit = [(r, c) for r, row in enumerate(cls) for c, k in enumerate(row) if k in 'md']
    r, c = max(lit, key=lambda rc: (rc[1], -rc[0]))
    cls[r] = cls[r][:c] + 'g' + cls[r][c + 1:]
    return {'chars': chars, 'cls': cls}


body = ''.join(f'export const HERO_{name} = {json.dumps(braille(cols), ensure_ascii=False, indent=1)}\n' for name, cols in SIZES.items())
(HERE.parent.parent / 'core' / 'hero.ts').write_text(body)
for name, cols in SIZES.items():
    art = braille(cols)
    print(name, cols, 'x', len(art['chars']))
    print('\n'.join(art['chars']))
