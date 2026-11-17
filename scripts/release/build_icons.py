#!/usr/bin/env python3
"""Application icons (launchers) from the official MOVE OpenLab icon — run by a maintainer when the logo changes.

  python scripts/release/build_icons.py <logo pack>/02_icon/move-openlab-icon-1024-transparent.png

The approved square icon of the logo pack was cut from the full logo and carries a few stray fragments of the
tagline next to the leaf. This script keeps the official symbol's own pixels unchanged — the connected regions of at
least 2,000 opaque pixels: the infinity road and the leaf — erases the small separate fragments, crops to the
symbol, centres it on a transparent square and writes, into src/move_openlab/assets/icons/:
move-openlab-<size>.png (16 … 1024), move-openlab.ico (Windows, 16–256) and move-openlab.icns (macOS). No colour,
shape or proportion is changed (only resampling to each size). Requires Pillow (not a runtime dependency).
"""
from __future__ import annotations

import collections
import hashlib
import sys
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parents[2] / "src" / "move_openlab" / "assets" / "icons"
SIZES = (16, 24, 32, 48, 64, 128, 256, 512)
MIN_REGION, MARGIN = 2000, 1.03


def symbol(src: Path) -> Image.Image:
    im = Image.open(src).convert("RGBA")
    w, h = im.size
    alpha, pix = im.split()[3].load(), im.load()
    label, keep = [[0] * w for _ in range(h)], []
    k = 0
    for y in range(h):
        for x in range(w):
            if alpha[x, y] and not label[y][x]:
                k += 1
                label[y][x], q, pts = k, collections.deque([(x, y)]), []
                while q:
                    cx, cy = q.popleft()
                    pts.append((cx, cy))
                    for nx in (cx - 1, cx, cx + 1):
                        for ny in (cy - 1, cy, cy + 1):
                            if 0 <= nx < w and 0 <= ny < h and alpha[nx, ny] and not label[ny][nx]:
                                label[ny][nx] = k
                                q.append((nx, ny))
                if len(pts) >= MIN_REGION:
                    keep.append(pts)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    op = out.load()
    for pts in keep:
        for x, y in pts:
            op[x, y] = pix[x, y]
    sym = out.crop(out.getbbox())
    side = int(max(sym.size) * MARGIN)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(sym, ((side - sym.width) // 2, (side - sym.height) // 2))
    return sq.resize((1024, 1024), Image.LANCZOS)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    src = Path(sys.argv[1])
    master = symbol(src)
    OUT.mkdir(parents=True, exist_ok=True)
    master.save(OUT / "move-openlab-1024.png", optimize=True)
    for s in SIZES:
        master.resize((s, s), Image.LANCZOS).save(OUT / f"move-openlab-{s}.png", optimize=True)
    master.save(OUT / "move-openlab.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
    master.save(OUT / "move-openlab.icns")
    print(f"source {src.name} sha256 {hashlib.sha256(src.read_bytes()).hexdigest()}")
    for f in sorted(OUT.glob("move-openlab*")):
        print(f"{hashlib.sha256(f.read_bytes()).hexdigest()}  {f.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
