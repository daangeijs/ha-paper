#!/usr/bin/env python3
"""Rasterise the SVG path icons (firmware/assets/icons.json + a few from the emulator markup) to 2 bpp alpha bitmaps.

Usage: ../.venv/bin/python tools/icongen.py   (from firmware/; needs Pillow)
Output: src/app/gen/icons.cpp + src/app/gen/icons.h (committed).
Rendering: 24-unit viewBox, round caps/joins, 8x supersampled, box-filtered, quantised to 4 levels.
"""
import json
import math
import os
import re
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.dirname(ROOT)
ICONS_JSON = os.path.join(REPO, "firmware", "assets", "icons.json")
OUT_CPP = os.path.join(ROOT, "src", "app", "gen", "icons.cpp")
OUT_H = os.path.join(ROOT, "src", "app", "gen", "icons.h")

J = json.load(open(ICONS_JSON))
P = {}
for group in ("status", "modes", "apps", "extra"):
    for k, v in J[group].items():
        P[group + "_" + k] = v
P["phone"] = "M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2"
P["moon_outline"] = "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"
P["download"] = "M12 3v12M7 10l5 5 5-5M4 19h16"
P["boot_home"] = "M3 11l9-7 9 7M5 10v10h14V10M10 20v-6h4v6"
P["unlinked_card"] = "M9 15l6-6M10.5 6.5l1-1a4 4 0 0 1 5.7 5.7l-1 1M13.5 17.5l-1 1a4 4 0 0 1-5.7-5.7l1-1"
P["chev_left"] = "M15 5l-7 7 7 7"
P["chev_right"] = "M9 5l7 7-7 7"
P["chev_down"] = "M6 9l6 6 6-6"
P["chev_up"] = "M6 15l6-6 6 6"
P["wifi_plain"] = J["extra"]["wifi"]
# Sleek display style (original display-styles package, display-styles.js SK_ICON + sleek-cards fragment)
P["sk_sun"] = "M12 3v2M12 19v2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M3 12h2M19 12h2M5.6 18.4L7 17M17 7l1.4-1.4M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z"
P["sk_house"] = "M3 11l9-7 9 7M5 10v10h14V10M10 20v-6h4v6"
P["sk_plug"] = "M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5"
P["sk_battery"] = "M3 8h15a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H3zM22 11v2"
P["sk_thermo"] = "M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"
P["sk_euro"] = "M18 7a6 6 0 1 0 0 10M4 10h9M4 14h9"
P["sk_clock"] = "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 7v5l3 2"
P["sk_bolt"] = "M13 2L4 14h7l-1 8 9-12h-7z"
P["sk_bulb"] = "M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"
P["sk_power"] = "M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0"
P["sk_flame"] = "M12 .98c1.74 4.93 7.25 7.54 7.25 14.79A7.25 7.25 0 0 1 4.75 15.77c0-3.335 1.595-5.365 3.335-6.96 0 3.19 1.74 4.93 3.48 4.93 0-4.93-1.74-8.41.435-12.76z"

# (enum name, path key, px size, stroke width in 24-unit space, filled)
SPECS = [
    ("StatusUnlinked", "extra_unlinked", 20, 2, False),
    ("StatusOffline", "status_offline", 20, 2, False),
    ("StatusSync", "status_sync", 20, 2, False),
    ("StatusUpdate", "status_update", 20, 2, False),
    ("StatusAlert", "status_alert", 20, 2, False),
    ("StatusAway", "status_away", 20, 2, False),
    ("StatusNight", "status_night", 20, 0, True),
    ("StatusLight", "status_light", 20, 2, False),
    ("Train", "modes_train", 22, 2, False),
    ("Bus", "modes_bus", 22, 2, False),
    ("Car", "modes_car", 22, 2, False),
    ("AppHome", "apps_home", 26, 2, False),
    ("AppHouse", "apps_house", 26, 2, False),
    ("AppTravel", "apps_travel", 26, 2, False),
    ("AppSettings", "apps_settings", 26, 2, False),
    ("Flame18", "extra_flame", 18, 0, True),
    ("Flame16", "extra_flame", 16, 0, True),
    ("Lock16", "extra_lock", 16, 2.2, False),
    ("Phone18", "phone", 18, 2, False),
    ("Unlinked28", "unlinked_card", 28, 2, False),
    ("Wifi44", "wifi_plain", 44, 2, False),
    ("Download48", "download", 48, 2, False),
    ("BootHome64", "boot_home", 64, 1.6, False),
    ("Moon20", "moon_outline", 20, 2.2, False),
    ("Tick14", "status_check", 14, 3.4, False),
    ("ChevLeft22", "chev_left", 22, 2.6, False),
    ("ChevRight22", "chev_right", 22, 2.6, False),
    ("ChevLeft20", "chev_left", 20, 2.6, False),
    ("ChevDown12", "chev_down", 12, 3, False),
    ("ChevUp12", "chev_up", 12, 3, False),
    # Sleek display style
    ("SkSun17", "sk_sun", 17, 2.2, False),
    ("SkHouse17", "sk_house", 17, 2.2, False),
    ("SkPlug17", "sk_plug", 17, 2.2, False),
    ("SkBattery17", "sk_battery", 17, 2.2, False),
    ("SkThermo17", "sk_thermo", 17, 2.2, False),
    ("SkEuro17", "sk_euro", 17, 2.2, False),
    ("SkClock17", "sk_clock", 17, 2.2, False),
    ("SkBolt17", "sk_bolt", 17, 2.2, False),
    ("SkBulb18", "sk_bulb", 18, 2.2, False),
    ("SkPower20", "sk_power", 20, 2.4, False),
    ("SkFlame16", "sk_flame", 16, 0, True),
    ("ChevRight20", "chev_right", 20, 2.6, False),
]

TOK = re.compile(r"[MmLlHhVvAaCcSsQqZz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?")


def arc_points(x1, y1, rx, ry, phi, fa, fs, x2, y2):
    # SVG arc endpoint → centre parameterisation (SVG 1.1 F.6.5)
    if rx == 0 or ry == 0:
        return [(x2, y2)]
    phi = math.radians(phi)
    cp, sp = math.cos(phi), math.sin(phi)
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    x1p, y1p = cp * dx + sp * dy, -sp * dx + cp * dy
    rx, ry = abs(rx), abs(ry)
    lam = x1p ** 2 / rx ** 2 + y1p ** 2 / ry ** 2
    if lam > 1:
        rx *= math.sqrt(lam)
        ry *= math.sqrt(lam)
    num = rx ** 2 * ry ** 2 - rx ** 2 * y1p ** 2 - ry ** 2 * x1p ** 2
    den = rx ** 2 * y1p ** 2 + ry ** 2 * x1p ** 2
    co = math.sqrt(max(0, num / den)) if den else 0
    if fa == fs:
        co = -co
    cxp, cyp = co * rx * y1p / ry, -co * ry * x1p / rx
    cx = cp * cxp - sp * cyp + (x1 + x2) / 2
    cy = sp * cxp + cp * cyp + (y1 + y2) / 2

    def ang(ux, uy, vx, vy):
        a = math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        return a
    t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not fs and dt > 0:
        dt -= 2 * math.pi
    elif fs and dt < 0:
        dt += 2 * math.pi
    n = max(4, int(abs(dt) / (math.pi / 32)))
    pts = []
    for i in range(1, n + 1):
        t = t1 + dt * i / n
        x, y = rx * math.cos(t), ry * math.sin(t)
        pts.append((cp * x - sp * y + cx, sp * x + cp * y + cy))
    return pts


def parse(d):
    toks = TOK.findall(d)
    i = 0
    subpaths, cur = [], []
    x = y = sx = sy = 0.0
    cmd = None

    def num():
        nonlocal i
        v = float(toks[i]); i += 1
        return v

    def flag():
        # arc flags may be packed ("01" style) — handle single digit tokens
        nonlocal i
        t = toks[i]
        if len(t) > 1 and t[0] in "01" and not t.startswith("0."):
            toks[i] = t[1:]
            return int(t[0])
        i += 1
        return int(float(t))
    while i < len(toks):
        if re.match(r"[A-Za-z]", toks[i]):
            cmd = toks[i]; i += 1
            if cmd in "Zz":
                if cur:
                    cur.append((sx, sy)); subpaths.append(cur); cur = []
                x, y = sx, sy
                continue
        rel = cmd.islower()
        c = cmd.upper()
        if c == "M":
            nx, ny = num(), num()
            if rel: nx += x; ny += y
            if cur: subpaths.append(cur)
            cur = [(nx, ny)]; x, y = sx, sy = nx, ny
            cmd = "l" if rel else "L"
        elif c == "L":
            nx, ny = num(), num()
            if rel: nx += x; ny += y
            cur.append((nx, ny)); x, y = nx, ny
        elif c == "H":
            nx = num(); nx = nx + x if rel else nx
            cur.append((nx, y)); x = nx
        elif c == "V":
            ny = num(); ny = ny + y if rel else ny
            cur.append((x, ny)); y = ny
        elif c == "A":
            rx, ry, phi = num(), num(), num()
            fa = flag(); fs = flag()
            nx, ny = num(), num()
            if rel: nx += x; ny += y
            cur.extend(arc_points(x, y, rx, ry, phi, fa, fs, nx, ny)); x, y = nx, ny
        elif c == "C":
            pts = [num() for _ in range(6)]
            if rel:
                pts = [pts[k] + (x if k % 2 == 0 else y) for k in range(6)]
            x0, y0 = x, y
            for k in range(1, 17):
                t = k / 16
                a = (1 - t) ** 3; b = 3 * (1 - t) ** 2 * t; cc = 3 * (1 - t) * t * t; dd = t ** 3
                cur.append((a * x0 + b * pts[0] + cc * pts[2] + dd * pts[4], a * y0 + b * pts[1] + cc * pts[3] + dd * pts[5]))
            x, y = pts[4], pts[5]
        else:
            raise ValueError("unsupported path command " + cmd)
    if cur:
        subpaths.append(cur)
    return subpaths


def raster(d, size, stroke, filled):
    S = 8
    big = size * S
    k = big / 24.0
    img = Image.new("L", (big, big), 0)
    dr = ImageDraw.Draw(img)
    for sp in parse(d):
        pts = [(px * k, py * k) for px, py in sp]
        if filled:
            if len(pts) > 2:
                dr.polygon(pts, fill=255)
        else:
            w = stroke * k
            r = w / 2
            for (ax, ay), (bx, by) in zip(pts, pts[1:]):
                dr.line([(ax, ay), (bx, by)], fill=255, width=max(1, int(round(w))))
            for px, py in pts:
                dr.ellipse([px - r, py - r, px + r, py + r], fill=255)
    small = img.resize((size, size), Image.BOX)
    return [min(3, (v + 42) // 85) for v in small.tobytes()]


def main():
    os.makedirs(os.path.dirname(OUT_CPP), exist_ok=True)
    h = ["// GENERATED by tools/icongen.py — do not edit.", "#pragma once", "#include <cstdint>", "namespace x4 {",
         "enum class Icon : uint8_t {", "  " + ", ".join(s[0] for s in SPECS) + ", Count", "};",
         "struct IconData { uint8_t size; const uint8_t* bits; };  // 2 bpp alpha, 4 px/byte MSB first, size x size",
         "const IconData& iconData(Icon i);", "}  // namespace x4"]
    c = ["// GENERATED by tools/icongen.py — do not edit.", '#include "app/gen/icons.h"', "namespace x4 {", "namespace {"]
    entries = []
    for name, key, size, stroke, filled in SPECS:
        cov = raster(P[key], size, stroke, filled)
        blob = bytearray()
        for i in range(0, len(cov), 4):
            b = 0
            for kk in range(4):
                v = cov[i + kk] if i + kk < len(cov) else 0
                b |= v << (6 - 2 * kk)
            blob.append(b)
        c.append(f"const uint8_t k{name}[] = {{" + ",".join(map(str, blob)) + "};")
        entries.append(f"{{{size}, k{name}}}")
    c.append("const IconData kIcons[] = {" + ", ".join(entries) + "};")
    c.append("}  // namespace")
    c.append("const IconData& iconData(Icon i) { return kIcons[static_cast<int>(i)]; }")
    c.append("}  // namespace x4")
    open(OUT_H, "w").write("\n".join(h) + "\n")
    open(OUT_CPP, "w").write("\n".join(c) + "\n")
    print("wrote", OUT_CPP, len(SPECS), "icons")


if __name__ == "__main__":
    main()
