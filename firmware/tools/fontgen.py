#!/usr/bin/env python3
"""Pre-render 2-bit anti-aliased bitmap fonts for the HA Paper UI.

Usage:  ../.venv/bin/python tools/fontgen.py      (from firmware/; needs Pillow + fontTools)
Input:  assets/fonts/*.ttf, all SIL OFL 1.1 (licences next to them as assets/fonts/OFL-*.txt):
        Classic:  Atkinson Hyperlegible + IBM Plex Mono. Glyphs missing in a face (→ ✓ ← ↑ ↓) fall back to
                  IBM Plex Mono; ▾ is synthesised.
        Sleek (display styles, docs/DISPLAY_STYLES_PLAN.md): Archivo, Bricolage Grotesque, Fraunces, Geist. All four
                  are variable fonts; each (weight, size) is rendered from the variable font with its axes set
                  (Archivo display = wdth 75; Bricolage/Fraunces opsz = the pixel size, like CSS
                  font-optical-sizing: auto).
Output: src/app/gen/fonts.cpp (Classic) and src/app/gen/fonts_<typeface>.cpp + fonts_index.cpp (committed).

Format (see src/app/gfx/font.h): per font a sorted glyph table {cp, w, h, xoff, yoff(top rel. to baseline), adv,
offset} and one 2 bpp coverage blob (0 = none … 3 = full), 4 px per byte, MSB first, rows not padded.

Sleek sizes come from the original display-styles.tokens.json (removed with handoff/, commit c7393ae): every display size is the
token size × the typeface's size factor (fk), rounded. src/app/ui_sleek.cpp asks for exactly these sizes; the native
test test_sleek_fonts_exact checks that every font a Sleek painter uses exists at that exact size.
"""
import io
import os
import sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FONTS = os.path.join(ROOT, "assets", "fonts")
GEN = os.path.join(ROOT, "src", "app", "gen")
OUT = os.path.join(GEN, "fonts.cpp")

ASCII = "".join(chr(c) for c in range(0x20, 0x7F))
LATIN1 = "".join(chr(c) for c in range(0xA0, 0x100))
EXTRA = "‹›–—·°€•→←↑↓✓…’‘“”×▾−"
FULL = ASCII + LATIN1 + EXTRA
TEXTISH = ASCII + "²³–—·°€•→…’−"   # ² ³: units beside a value (m², m³; #162)
DIGITS = "0123456789 .,:%°–—-+€/−"

# (weight, file, sizes, charset)
SPECS = [
    ("Bold", "AtkinsonHyperlegible-Bold.ttf", [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 26, 28, 30], FULL),
    ("Bold", "AtkinsonHyperlegible-Bold.ttf", [34, 36, 40, 44, 46, 50, 52], TEXTISH),
    ("Bold", "AtkinsonHyperlegible-Bold.ttf", [76, 92, 150], DIGITS),
    ("Regular", "AtkinsonHyperlegible-Regular.ttf", [12, 13, 14, 15, 16, 17, 18, 19, 26], FULL),   # 26: standby/night stat names (#199)
    ("Mono", "IBMPlexMono-Medium.ttf", [13, 16], ASCII),
]
FALLBACK = "IBMPlexMono-Medium.ttf"

# ---------------- Sleek typefaces ----------------
# face enum name → (file, fixed axes, opsz follows the pixel size)
FACES = {
    "ArchivoCond": ("Archivo[wdth,wght].ttf", {"wdth": 75}, False),
    "Archivo": ("Archivo[wdth,wght].ttf", {"wdth": 100}, False),
    "Bricolage": ("BricolageGrotesque[opsz,wdth,wght].ttf", {"wdth": 100}, True),
    "Fraunces": ("Fraunces[SOFT,WONK,opsz,wght].ttf", {"SOFT": 0, "WONK": 1}, True),
    "Geist": ("Geist[wght].ttf", {}, False),
}
WGHT = {"Regular": 400, "Semi": 600, "Bold": 700}
# typeface → (display face, text face, fk); tokens.json styles.sleek.typefaces
TYPEFACES = {
    "archivo": ("ArchivoCond", "Archivo", 1.12),
    "bricolage": ("Bricolage", "Bricolage", 0.92),
    "fraunces": ("Fraunces", "Geist", 0.95),
    "geist": ("Geist", "Geist", 0.92),
}
# display sizes (× fk): digits-only where only numbers are shown (tokens.json displaySizes)
DISPLAY_DIGITS = [62, 56, 48, 104, 150, 58, 34]   # stat ≤3/4/5 chars, clock, clock tall, price, thermo + room temp
DISPLAY_TEXT = [40, 38, 30, 27, 24, 22, 20, 18]   # stat 6+ chars + battery, favourite light, scene, title, bar clock,
                                                  # list header, room header/chart summary/setting, light value
DISPLAY_SEMI = [(20, TEXTISH), (16, DIGITS), (24, DIGITS)]   # unit beside a value, "%" in the ring, "€" (not × fk)
TEXT_SEMI = [13, 14, 15, 16, 17]                  # labels, names, app name, weekday/date (sentence case, 600)
# text face Bold/Regular: the Sleek 700 sizes (chips, pills, "Now" flag) plus the Classic sizes, because the screens
# that keep the Classic layout (travel, updates, Wi-Fi, HA, About, setup, link card, app switcher) render their
# Classic B()/R() fonts in the Sleek text face (findFont remaps; nearest size when a size is missing).
TEXT_BOLD = [(s, FULL) for s in [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 26, 28, 30]] + [(46, TEXTISH), (52, TEXTISH)]
TEXT_REG = [(s, FULL) for s in [12, 13, 14, 15, 16, 17, 18, 19]]
GROUPS = {   # output file → faces in it
    "archivo": ["ArchivoCond", "Archivo"],
    "bricolage": ["Bricolage"],
    "fraunces": ["Fraunces"],
    "geist": ["Geist"],
}


def has_glyph(font_path, ch, cache={}):
    from fontTools.ttLib import TTFont  # optional; only used for coverage checks
    if font_path not in cache:
        cache[font_path] = TTFont(font_path).getBestCmap()
    return ord(ch) in cache[font_path]


def has_feature(font_path, tag, cache={}):
    from fontTools.ttLib import TTFont
    if font_path not in cache:
        t = TTFont(font_path)
        cache[font_path] = {r.FeatureTag for r in t["GSUB"].table.FeatureList.FeatureRecord} if "GSUB" in t else set()
    return tag in cache[font_path]


def plain_zero(fname):
    """Atkinson Hyperlegible with a plain zero (issue #28): its slashed zero reads "23:3Ø" across a room. The face has
    no plain alternate; its zero is an outer oval + two counters split by the slash, so the two counters become one:
    the outer contour, reversed and scaled about its centre onto the counters' joint box. Hinting is dropped for that
    glyph only; the cmap is unchanged, so has_glyph() on the original file still holds. Returns the font bytes."""
    from fontTools.ttLib import TTFont
    from fontTools.ttLib.tables._g_l_y_f import GlyphCoordinates
    from fontTools.ttLib.tables import ttProgram
    path = os.path.join(FONTS, fname)
    t = TTFont(path, recalcTimestamp=False)
    glyf = t["glyf"]
    g = glyf["zero"]
    co, ends, flags = g.getCoordinates(glyf)
    assert len(ends) == 3, "unexpected zero outline in " + fname
    outer = list(co[:ends[0] + 1])
    inner = list(co[ends[0] + 1:])
    ox0, ox1 = min(p[0] for p in outer), max(p[0] for p in outer)
    oy0, oy1 = min(p[1] for p in outer), max(p[1] for p in outer)
    ix0, ix1 = min(p[0] for p in inner), max(p[0] for p in inner)
    iy0, iy1 = min(p[1] for p in inner), max(p[1] for p in inner)
    sx, sy = (ix1 - ix0) / (ox1 - ox0), (iy1 - iy0) / (oy1 - oy0)
    cx, cy = (ox0 + ox1) / 2, (oy0 + oy1) / 2
    icx, icy = (ix0 + ix1) / 2, (iy0 + iy1) / 2
    counter = [(round(icx + (x - cx) * sx), round(icy + (y - cy) * sy)) for x, y in reversed(outer)]
    oflags = list(flags[:ends[0] + 1])
    g.coordinates = GlyphCoordinates(outer + counter)
    g.endPtsOfContours = [ends[0], 2 * ends[0] + 1]
    g.numberOfContours = 2
    g.flags = bytearray(oflags + oflags[::-1])
    g.program = ttProgram.Program()
    g.program.fromBytecode(b"")
    g.recalcBounds(glyf)
    buf = io.BytesIO()
    t.save(buf)
    return buf.getvalue()


def emulator_zero():
    """The emulator's copy of the plain zero: a one-glyph subset of each patched Atkinson weight as a data-URI
    @font-face ('X4 Plain Zero', unicode-range U+0030), placed first in the Classic font stack (src/core/skin.ts).
    fontTools only, no rasteriser: the bytes are the same on every OS."""
    import base64
    from fontTools import subset
    from fontTools.ttLib import TTFont
    faces = []
    for weight, fname in ((400, "AtkinsonHyperlegible-Regular.ttf"), (700, "AtkinsonHyperlegible-Bold.ttf")):
        t = TTFont(io.BytesIO(plain_zero(fname)), recalcTimestamp=False)
        opt = subset.Options()
        opt.hinting = False
        opt.layout_features = []
        opt.name_IDs = [0, 1, 2]
        opt.drop_tables += ["DSIG", "GPOS", "GSUB", "GDEF"]
        sub = subset.Subsetter(opt)
        sub.populate(unicodes=[0x30])
        sub.subset(t)
        buf = io.BytesIO()
        t.save(buf)
        b64 = base64.b64encode(buf.getvalue()).decode()
        faces.append(f"@font-face{{font-family:'X4 Plain Zero';font-weight:{weight};unicode-range:U+0030;"
                     f"src:url(data:font/ttf;base64,{b64}) format('truetype')}}")
    out = os.path.join(os.path.dirname(ROOT), "emulator", "src", "plain-zero.css")
    with open(out, "w") as fh:
        fh.write("/* GENERATED by firmware/tools/fontgen.py: do not edit. Atkinson Hyperlegible (SIL OFL 1.1) zero without the\n"
                 "   slash, as on the device (issue #28). */\n" + "\n".join(faces) + "\n")
    print(f"wrote {out}")


def render_glyph(font, ch, size):
    """Return (w, h, xoff, yoff, adv, coverage list) with yoff = top relative to baseline (negative = above)."""
    pad = size
    W = H = size * 3
    img = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(img)
    base_x, base_y = pad, pad * 2
    if ch == "▾":  # synthesised small down triangle
        s = size * 0.42
        cx, cy = base_x + s * 0.6, base_y - size * 0.32
        d.polygon([(cx - s / 2, cy - s / 3), (cx + s / 2, cy - s / 3), (cx, cy + s / 3)], fill=255)
        adv = round(s * 1.2)
    else:
        d.text((base_x, base_y), ch, font=font, fill=255, anchor="ls")
        adv = round(font.getlength(ch))
    bbox = img.getbbox()
    if not bbox:
        return 0, 0, 0, 0, adv, []
    x0, y0, x1, y1 = bbox
    crop = img.crop(bbox)
    w, h = crop.size
    cov = [min(3, (v + 42) // 85) for v in crop.tobytes()]
    # trim rows/cols that quantised to zero
    return w, h, x0 - base_x, y0 - base_y, adv, cov


def pack(cov):
    out = bytearray()
    for i in range(0, len(cov), 4):
        b = 0
        for k in range(4):
            v = cov[i + k] if i + k < len(cov) else 0
            b |= v << (6 - 2 * k)
        out.append(b)
    return out


def build(path, font, fb, size, charset, synth=True):
    """Glyph table + blob for one (font, size). fb = fallback font for glyphs the face lacks."""
    fb_path = os.path.join(FONTS, FALLBACK)
    glyphs, blob = [], bytearray()
    for ch in sorted(set(charset), key=ord):
        f = font
        if ch == "▾" and not synth:
            continue
        if ch != "▾" and not has_glyph(path, ch):
            if has_glyph(fb_path, ch):
                f = fb
            else:
                continue
        w, h, xo, yo, adv, cov = render_glyph(f, ch, size)
        glyphs.append((ord(ch), w, h, xo, yo, adv, len(blob)))
        blob += pack(cov)
    digit_adv = max([g[5] for g in glyphs if chr(g[0]).isdigit()] or [0])
    return glyphs, blob, digit_adv


def emit(lines, table, sym, face, weight, size, asc, desc, glyphs, blob, digit_adv):
    lines.append(f"const uint8_t k{sym}Bits[] = {{" + ",".join(str(b) for b in blob) + "};")
    lines.append(f"const Glyph k{sym}Glyphs[] = {{" + ",".join("{%d,%d,%d,%d,%d,%d,%d}" % g for g in glyphs) + "};")
    table.append(f"{{Face::{face}, FontWeight::{weight}, {size}, {asc}, {desc}, {digit_adv}, {len(glyphs)}, k{sym}Glyphs, k{sym}Bits}}")
    return len(blob) + len(glyphs) * 12


def classic():
    lines = ["// GENERATED by tools/fontgen.py — do not edit. Fonts: Atkinson Hyperlegible, IBM Plex Mono (SIL OFL 1.1).",
             '#include "app/gfx/font.h"', "namespace x4 {", "namespace {"]
    table = []
    total = 0
    for weight, fname, sizes, charset in SPECS:
        path = os.path.join(FONTS, fname)
        src = io.BytesIO(plain_zero(fname)) if fname.startswith("Atkinson") else None
        for size in sizes:
            if src:
                src.seek(0)
            font = ImageFont.truetype(src or path, size)
            fb = ImageFont.truetype(os.path.join(FONTS, FALLBACK), size)
            asc, desc = font.getmetrics()
            glyphs, blob, digit_adv = build(path, font, fb, size, charset)
            total += emit(lines, table, f"{weight}{size}", "Classic", weight, size, asc, desc, glyphs, blob, digit_adv)
    lines.append("}  // namespace")
    lines.append("extern const FontData kFonts[] = {\n  " + ",\n  ".join(table) + "\n};")
    lines.append(f"extern const int kFontCount = {len(table)};")
    lines.append("}  // namespace x4")
    with open(OUT, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"wrote {OUT}: {len(table)} fonts, ~{total // 1024} KB")
    return total


def sleek_specs():
    """(face, weight) → {size: charset} for every Sleek typeface (charsets merged when two roles share a size)."""
    want = {}

    def add(face, weight, size, cs):
        d = want.setdefault((face, weight), {})
        d[size] = "".join(sorted(set(d.get(size, "")) | set(cs), key=ord))

    for tf, (disp, text, fk) in TYPEFACES.items():
        for b in DISPLAY_DIGITS:
            add(disp, "Bold", int(b * fk + 0.5), DIGITS)
        for b in DISPLAY_TEXT:
            add(disp, "Bold", int(b * fk + 0.5), TEXTISH)
        for s, cs in DISPLAY_SEMI:
            add(disp, "Semi", s, cs)
        for s in TEXT_SEMI:
            add(text, "Semi", s, FULL)
        for s, cs in TEXT_BOLD:
            add(text, "Bold", s, cs)
        for s, cs in TEXT_REG:
            add(text, "Regular", s, cs)
    return want


def tnum_em(face, weight, cache={}):
    """Advance of the tabular zero ('tnum' feature), in em, at the weight/width the face is rendered with."""
    key = (face, weight)
    if key not in cache:
        from fontTools.ttLib import TTFont
        from fontTools.varLib import instancer
        fname, axes, _ = FACES[face]
        f = TTFont(os.path.join(FONTS, fname))
        ax = {k: v for k, v in dict(axes, wght=WGHT[weight]).items() if k in {a.axisTag for a in f["fvar"].axes}}
        f = instancer.instantiateVariableFont(f, ax)   # opsz (if any) stays variable: advances barely depend on it
        zero = f.getBestCmap()[ord("0")]
        name = zero
        gsub = f["GSUB"].table
        for fr in gsub.FeatureList.FeatureRecord:
            if fr.FeatureTag != "tnum":
                continue
            for li in fr.Feature.LookupListIndex:
                for st in gsub.LookupList.Lookup[li].SubTable:
                    st = getattr(st, "ExtSubTable", st)
                    if hasattr(st, "mapping") and zero in st.mapping:
                        name = st.mapping[zero]
        cache[key] = f["hmtx"][name][0] / f["head"].unitsPerEm
    return cache[key]


def face_font(face, weight, size):
    fname, axes, opsz = FACES[face]
    path = os.path.join(FONTS, fname)
    font = ImageFont.truetype(path, size)
    ax = dict(axes)
    ax["wght"] = WGHT[weight]
    if opsz:
        ax["opsz"] = size
    vals = []
    for a in font.get_variation_axes():
        tag = a["name"] if isinstance(a["name"], str) else a["name"].decode()
        # Pillow reports axis names; map the registered ones back to tags
        key = {"Weight": "wght", "Width": "wdth", "Optical size": "opsz", "Optical Size": "opsz", "Softness": "SOFT",
               "Wonky": "WONK"}.get(tag, tag)
        v = ax.get(key, a["default"])
        vals.append(max(a["minimum"], min(a["maximum"], v)))
    font.set_variation_by_axes(vals)
    return path, font


def sleek():
    want = sleek_specs()
    files = []
    grand = 0
    for group, faces in GROUPS.items():
        out = os.path.join(GEN, f"fonts_{group}.cpp")
        lic = {"archivo": "Archivo", "bricolage": "Bricolage Grotesque", "fraunces": "Fraunces", "geist": "Geist"}[group]
        lines = [f"// GENERATED by tools/fontgen.py — do not edit. Font: {lic} (SIL OFL 1.1, assets/fonts/OFL-*.txt).",
                 '#include "app/gfx/font.h"', "namespace x4 {", "namespace {"]
        table, total = [], 0
        for face in faces:
            for weight in ("Bold", "Semi", "Regular"):
                for size, cs in sorted(want.get((face, weight), {}).items()):
                    path, font = face_font(face, weight, size)
                    fb = ImageFont.truetype(os.path.join(FONTS, FALLBACK), size)
                    asc, desc = font.getmetrics()
                    glyphs, blob, digit_adv = build(path, font, fb, size, cs, synth=False)
                    if not has_feature(path, "tnum"):
                        digit_adv = 0   # no tabular figures in the face (Fraunces): the browser falls back to proportional
                    else:
                        digit_adv = round(tnum_em(face, weight) * size)   # the face's own tabular figure width
                    total += emit(lines, table, f"{face}{weight}{size}", face, weight, size, asc, desc, glyphs, blob, digit_adv)
        cap = group[0].upper() + group[1:]
        lines.append("}  // namespace")
        lines.append(f"extern const FontData kFonts{cap}[] = {{\n  " + ",\n  ".join(table) + "\n};")
        lines.append(f"extern const int kFonts{cap}Count = {len(table)};")
        lines.append("}  // namespace x4")
        with open(out, "w") as fh:
            fh.write("\n".join(lines) + "\n")
        print(f"wrote {out}: {len(table)} fonts, ~{total // 1024} KB")
        files.append(cap)
        grand += total
    idx = ["// GENERATED by tools/fontgen.py — do not edit. Every generated font table, for findFont().",
           '#include "app/gfx/font.h"', "namespace x4 {",
           "extern const FontData kFonts[];", "extern const int kFontCount;"]
    for cap in files:
        idx += [f"extern const FontData kFonts{cap}[];", f"extern const int kFonts{cap}Count;"]
    idx.append("extern const FontTable kFontTables[] = {{kFonts, &kFontCount}, " +
               ", ".join(f"{{kFonts{c}, &kFonts{c}Count}}" for c in files) + "};")
    idx.append(f"extern const int kFontTableCount = {1 + len(files)};")
    idx.append("}  // namespace x4")
    with open(os.path.join(GEN, "fonts_index.cpp"), "w") as fh:
        fh.write("\n".join(idx) + "\n")
    return grand


def main():
    os.makedirs(GEN, exist_ok=True)
    only = sys.argv[1] if len(sys.argv) > 1 else "all"
    total = 0
    if only in ("all", "classic"):
        total += classic()
        emulator_zero()
    if only in ("all", "sleek"):
        total += sleek()
    print(f"total ~{total // 1024} KB")


if __name__ == "__main__":
    main()
