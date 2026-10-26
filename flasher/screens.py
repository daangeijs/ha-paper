#!/usr/bin/env python3
# Copies a few host renders (firmware/test/out/, from firmware/tools/render.sh) into src/screens/ as 2-bit
# palette PNGs for the landing page. The renders are 4-gray already; this only shrinks them (384 KB -> 5-12 KB each).
# Run via `make flasher-screens` after a UI change; the output is committed so CI needs no render step.
# Usage: screens.py [render dir]
import sys
from pathlib import Path

from PIL import Image

SCREENS = {"home.png": "classic-home.png", "sleek_geist_home.png": "sleek-home.png",
           "night.png": "night.png", "first_install_step1.png": "setup-wifi.png",
           "first_install_step2.png": "setup-ha.png"}
here = Path(__file__).resolve().parent
src = Path(sys.argv[1]) if len(sys.argv) > 1 else here.parent / "firmware/test/out"
dst = here / "src/screens"
dst.mkdir(parents=True, exist_ok=True)
for name, out in SCREENS.items():
    if not (src / name).exists():
        sys.exit(f"Missing {src / name}: run firmware/tools/render.sh first.")
    im = Image.open(src / name).convert("L")
    grays = sorted(c for _, c in im.getcolors(256) or [])
    if not grays or len(grays) > 4:
        sys.exit(f"{name}: expected at most 4 gray levels.")
    pal = Image.new("P", (1, 1))
    pal.putpalette([g for c in grays for g in (c, c, c)])
    im.convert("RGB").quantize(palette=pal, dither=Image.Dither.NONE).save(dst / out, optimize=True, bits=2)
    print(f"{out}: {(dst / out).stat().st_size} bytes")
