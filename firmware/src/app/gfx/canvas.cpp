#include "app/gfx/canvas.h"
#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <utility>
#include "core/qr.h"

namespace x4 {

// ---------- fonts ----------
static const FontData* scan(Face face, FontWeight w, int size, bool exact) {
  const FontData* best = nullptr;
  for (int pass = 0; pass < 2 && !best; ++pass) {
    for (int t = 0; t < kFontTableCount; ++t) {
      const FontTable& tb = kFontTables[t];
      for (int i = 0; i < *tb.count; ++i) {
        const FontData& f = tb.fonts[i];
        if (f.face != face) continue;
        if (pass == 0 && f.weight != w) continue;
        if (exact) { if (f.weight == w && f.size == size) return &f; continue; }
        if (!best) { best = &f; continue; }
        int d0 = std::abs(int(best->size) - size), d1 = std::abs(int(f.size) - size);
        if (d1 < d0 || (d1 == d0 && f.size < best->size)) best = &f;
      }
    }
    if (exact) return nullptr;
  }
  return best;
}

const FontData* findFont(Face face, FontWeight w, int size) {
  const FontData* f = scan(face, w, size, false);
  return f || face == Face::Classic ? f : scan(Face::Classic, w, size, false);
}

const FontData* findFontExact(Face face, FontWeight w, int size) { return scan(face, w, size, true); }

const Glyph* findGlyph(const FontData* f, uint32_t cp) {
  int lo = 0, hi = int(f->count) - 1;
  while (lo <= hi) {
    int mid = (lo + hi) / 2;
    uint32_t c = f->glyphs[mid].cp;
    if (c == cp) return &f->glyphs[mid];
    if (c < cp) lo = mid + 1; else hi = mid - 1;
  }
  return nullptr;
}

std::vector<uint32_t> utf8Decode(const std::string& s) {
  std::vector<uint32_t> out;
  for (size_t i = 0; i < s.size();) {
    unsigned char c = s[i];
    uint32_t cp; int n;
    if (c < 0x80) { cp = c; n = 1; }
    else if ((c & 0xE0) == 0xC0) { cp = c & 0x1F; n = 2; }
    else if ((c & 0xF0) == 0xE0) { cp = c & 0x0F; n = 3; }
    else { cp = c & 0x07; n = 4; }
    for (int k = 1; k < n && i + k < s.size(); ++k) cp = (cp << 6) | (s[i + k] & 0x3F);
    out.push_back(cp); i += n;
  }
  return out;
}

// ASCII + Latin-1 (à–þ → À–Þ, not ÷; the fonts carry U+00A0–U+00FF). ß and ÿ stay (CSS: SS, Ÿ).
std::string utf8Upper(const std::string& s) {
  std::string o = s;
  for (size_t i = 0; i < o.size(); ++i) {
    unsigned char ch = o[i];
    if (ch >= 'a' && ch <= 'z') o[i] = char(ch - 32);
    else if (ch == 0xC3 && i + 1 < o.size()) {
      unsigned char n = o[i + 1];
      if (n >= 0xA0 && n <= 0xBE && n != 0xB7) o[i + 1] = char(n - 0x20);
      ++i;
    }
  }
  return o;
}

static const Glyph* glyphOrFallback(const FontData* f, uint32_t cp) {
  const Glyph* g = findGlyph(f, cp);
  if (!g && cp == 0x2212) g = findGlyph(f, '-');
  if (!g) g = findGlyph(f, '?');
  return g;
}

int Canvas::ascent(Font f) { const FontData* d = resolveFont(f); return d ? d->ascent : f.size; }
int Canvas::capHeight(Font f) {
  const FontData* d = resolveFont(f);
  if (!d) return f.size * 7 / 10;
  const Glyph* g = findGlyph(d, 'H'); if (!g) g = findGlyph(d, '0');
  return g ? -g->yoff : f.size * 7 / 10;
}

static int advanceOf(const FontData* d, const Glyph* g, uint32_t cp, const TextOpts& o) {
  if (o.tabular && d->digitAdv && cp >= '0' && cp <= '9') return d->digitAdv;   // digitAdv 0 = face has no tabular figures
  return g ? g->adv : 0;
}

int Canvas::textWidth(const std::string& s0, Font f, const TextOpts& o) const {
  const FontData* d = resolveFont(f);
  if (!d) return 0;
  std::string s = o.upper ? utf8Upper(s0) : s0;
  int w = 0, n = 0;
  for (uint32_t cp : utf8Decode(s)) { w += advanceOf(d, glyphOrFallback(d, cp), cp, o); ++n; }
  if (n > 1) w += o.tracking * (n - 1);
  return w;
}

std::string Canvas::fitText(const std::string& s, Font f, const TextOpts& o) const {
  if (o.maxW <= 0 || textWidth(s, f, o) <= o.maxW) return s;
  auto cps = utf8Decode(o.upper ? utf8Upper(s) : s);
  std::string out;
  TextOpts plain = o; plain.maxW = 0; plain.upper = false;
  int ell = textWidth("…", f, plain);
  std::string acc;
  for (uint32_t cp : cps) {
    std::string next = acc;
    if (cp < 0x80) next += char(cp);
    else if (cp < 0x800) { next += char(0xC0 | (cp >> 6)); next += char(0x80 | (cp & 0x3F)); }
    else { next += char(0xE0 | (cp >> 12)); next += char(0x80 | ((cp >> 6) & 0x3F)); next += char(0x80 | (cp & 0x3F)); }
    if (textWidth(next, f, plain) + ell > o.maxW) break;
    acc = next;
  }
  while (!acc.empty() && acc.back() == ' ') acc.pop_back();
  return acc + "…";
}

int Canvas::text(int x, int baseline, const std::string& s0, Font f, const TextOpts& o) {
  const FontData* d = resolveFont(f);
  if (!d) return 0;
  std::string s = fitText(o.upper ? utf8Upper(s0) : s0, f, o);
  TextOpts plain = o; plain.upper = false; plain.maxW = 0;
  int w = textWidth(s, f, plain);
  char face[8] = "";
  if (d->face != Face::Classic) std::snprintf(face, sizeof face, "f%d", int(d->face));
  rec("T%d,%d,%d%c%s,%d,%d%s%s:%s;", x, baseline, f.size, "RBMS"[int(f.weight)], face, int(o.color), o.tracking,
      o.strike ? "s" : "", o.dotted ? "d" : "", s.c_str());
  if (fb_) {
    if (d->size < 20 && o.color != Ink::Paper && !surfs_.empty()) surfKnockout(x, baseline, w, s, d, o);
    int pen = x;
    for (uint32_t cp : utf8Decode(s)) {
      const Glyph* g = glyphOrFallback(d, cp);
      int adv = advanceOf(d, g, cp, o);
      if (g && g->w) {
        int gx = pen + g->xoff;
        if (o.tabular && d->digitAdv && cp >= '0' && cp <= '9') gx = pen + (adv - g->adv) / 2 + g->xoff;
        int gy = baseline + g->yoff;
        const uint8_t* bits = d->bits + g->off;
        int idx = 0;
        for (int yy = 0; yy < g->h; ++yy)
          for (int xx = 0; xx < g->w; ++xx, ++idx) {
            int a = (bits[idx >> 2] >> (6 - 2 * (idx & 3))) & 3;
            if (a) put(gx + xx, gy + yy, o.color, a);
          }
      }
      pen += adv + o.tracking;
    }
  }
  if (o.strike) {
    int th = std::max(2, f.size / 12);
    int y = baseline - capHeight(f) / 2 - th / 2;
    bool r = rec_ != nullptr; std::string* save = rec_; rec_ = nullptr;
    fill(Rect{int16_t(x), int16_t(y), int16_t(w), int16_t(th)}, o.color);
    rec_ = save; (void)r;
  }
  if (o.dotted) {
    std::string* save = rec_; rec_ = nullptr;
    dottedHLine(x, baseline + std::max(3, f.size / 7), w, 2, o.color);
    rec_ = save;
  }
  return w;
}

int Canvas::textRight(int right, int baseline, const std::string& s, Font f, const TextOpts& o) {
  int w = std::min(textWidth(s, f, o), o.maxW > 0 ? o.maxW : 1 << 20);
  text(right - w, baseline, s, f, o);
  return w;
}

int Canvas::textCenter(int cx, int baseline, const std::string& s, Font f, const TextOpts& o) {
  int w = std::min(textWidth(s, f, o), o.maxW > 0 ? o.maxW : 1 << 20);
  text(cx - w / 2, baseline, s, f, o);
  return w;
}

int Canvas::paragraph(int x, int top, int w, int lineH, const std::string& s, Font f, const TextOpts& o, int maxLines) {
  std::vector<std::string> words; std::string cur;
  for (char ch : s) { if (ch == ' ') { words.push_back(cur); cur.clear(); } else cur += ch; }
  words.push_back(cur);
  std::vector<std::string> lines; std::string line;
  for (auto& wd : words) {
    std::string t = line.empty() ? wd : line + " " + wd;
    if (!line.empty() && textWidth(t, f, o) > w) { lines.push_back(line); line = wd; }
    else line = t;
  }
  if (!line.empty()) lines.push_back(line);
  if (maxLines > 0 && int(lines.size()) > maxLines) {   // the rest joins the last line, which ellipsizes at w
    for (size_t i = maxLines; i < lines.size(); ++i) lines[maxLines - 1] += " " + lines[i];
    lines.resize(maxLines);
  }
  int asc = ascent(f);
  int lead = (lineH - (asc + int(f.size) / 4)) / 2;
  for (size_t i = 0; i < lines.size(); ++i) {
    TextOpts lo = o; lo.maxW = w;
    text(x, top + int(i) * lineH + lead + asc, lines[i], f, lo);
  }
  return int(lines.size());
}

// ---------- pixels ----------
void Canvas::rec(const char* fmt, ...) {
  if (!rec_) return;
  char buf[512];
  va_list ap; va_start(ap, fmt);
  int n = std::vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  if (n > 0) rec_->append(buf, std::min<size_t>(n, sizeof buf - 1));
}

Ink Canvas::get(int x, int y) const {
  size_t i = size_t(y) * kScreenW + x;
  return Ink((fb_->data[i >> 2] >> (6 - 2 * (i & 3))) & 3);
}

uint32_t Canvas::grayPuts = 0;

void Canvas::put(int x, int y, Ink c, int a) {
  if (!fb_ || !inClip(x, y) || a <= 0) return;
  if ((c == Ink::G1 || c == Ink::G2) && !surf_) ++grayPuts;
  size_t i = size_t(y) * kScreenW + x;
  uint8_t& b = fb_->data[i >> 2];
  int sh = 6 - 2 * int(i & 3);
  int v;
  if (a >= 3) v = int(c);
  else {
    int bg = (b >> sh) & 3;
    v = (bg * (3 - a) + int(c) * a + 1) / 3;
  }
  b = uint8_t((b & ~(3 << sh)) | (v << sh));
}

// Solid run [x0, x1) of row y, clipped; whole bytes at once (4 px per byte, rows start on a byte: kScreenW % 4 == 0).
void Canvas::span(int y, int x0, int x1, Ink c) {
  if (y < std::max<int>(0, clip_.y) || y >= std::min<int>(kScreenH, clip_.y + clip_.h)) return;
  x0 = std::max({x0, int(clip_.x), 0});
  x1 = std::min({x1, clip_.x + clip_.w, int(kScreenW)});
  if (x0 >= x1) return;
  if ((c == Ink::G1 || c == Ink::G2) && !surf_) grayPuts += uint32_t(x1 - x0);
  uint8_t* row = fb_->data + size_t(y) * (kScreenW / 4);
  const int v = int(c);
  for (; x0 < x1 && (x0 & 3); ++x0) { int sh = 6 - 2 * (x0 & 3); row[x0 >> 2] = uint8_t((row[x0 >> 2] & ~(3 << sh)) | (v << sh)); }
  for (; x1 > x0 && (x1 & 3); --x1) { int sh = 6 - 2 * ((x1 - 1) & 3); row[(x1 - 1) >> 2] = uint8_t((row[(x1 - 1) >> 2] & ~(3 << sh)) | (v << sh)); }
  if (x1 > x0) std::memset(row + (x0 >> 2), v * 0x55, size_t(x1 - x0) >> 2);
}

void Canvas::fill(Rect r, Ink c) {
  rec("F%d,%d,%d,%d,%d;", r.x, r.y, r.w, r.h, int(c));
  if (!fb_) return;
  for (int y = std::max<int>(r.y, 0); y < std::min<int>(r.y + r.h, kScreenH); ++y) span(y, r.x, r.x + r.w, c);
}

void Canvas::invert(Rect r) {
  if (!fb_) return;
  for (int y = r.y; y < r.y + r.h; ++y)
    for (int x = r.x; x < r.x + r.w; ++x)
      if (inClip(x, y)) put(x, y, Ink(3 - int(get(x, y))), 3);
}

// Rounded-rect geometry in quarter pixels (issue #213): edges, the radius (a half pixel when min(w, h) is odd) and the
// 2x2 sample points px + 0.25 / 0.75 are all exact integers, so this is the same test the double version did, without
// soft-float (the ESP32-S3 FPU is single precision).
struct RR4 {
  int x0, y0, x1, y1, r;
  RR4(Rect q, int radius) : x0(4 * q.x), y0(4 * q.y), x1(4 * (q.x + q.w)), y1(4 * (q.y + q.h)),
                            r(std::min(4 * radius, 2 * std::min<int>(q.w, q.h))) {}
  RR4(int a, int b, int c, int d, int rr) : x0(a), y0(b), x1(c), y1(d), r(rr) {}
};
static int ceil4(int a) { return (a + 3 + (1 << 20)) / 4 - (1 << 18); }   // ceil(a / 4) for a > -2^20

// coverage (0..4 of 2x2 samples) of a rounded rectangle at pixel (px, py)
static int rrCov(int px, int py, const RR4& g) {
  int n = 0;
  for (int sy = 0; sy < 2; ++sy)
    for (int sx = 0; sx < 2; ++sx) {
      int x = 4 * px + 1 + 2 * sx, y = 4 * py + 1 + 2 * sy;
      if (x < g.x0 || x > g.x1 || y < g.y0 || y > g.y1) continue;
      int cx = std::min(std::max(x, g.x0 + g.r), g.x1 - g.r), cy = std::min(std::max(y, g.y0 + g.r), g.y1 - g.r);
      int dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= g.r * g.r) ++n;
    }
  return n;
}

// Per row: solid spans, 2x2 coverage only in the corner squares, a ring only touches its border strips.
void Canvas::rrectCoverage(Rect r, int radius, int, Ink c, bool ring, int bw) {
  if (!fb_) return;
  const RR4 o(r, radius);
  const int b4 = 4 * bw;
  const RR4 in(o.x0 + b4, o.y0 + b4, o.x1 - b4, o.y1 - b4, std::max(0, o.r - b4));
  const int ya = std::max({int(r.y), int(clip_.y), 0}), yb = std::min({r.y + r.h, clip_.y + clip_.h, int(kScreenH)});
  const int xa = std::max({int(r.x), int(clip_.x), 0}), xb = std::min({r.x + r.w, clip_.x + clip_.w, int(kScreenW)});
  const int lcEnd = ceil4(o.x0 + o.r + 4), rcBeg = std::max(lcEnd, ceil4(o.x1 - o.r - 4));   // corner columns
  const int tcEnd = ceil4(o.y0 + o.r + 4), bcBeg = ceil4(o.y1 - o.r - 4);                    // corner rows
  const int ix0 = r.x + bw, ix1 = r.x + r.w - bw;   // ring interior columns (straight part)
  auto pix = [&](int x, int y) {
    int cov = rrCov(x, y, o) - (ring ? rrCov(x, y, in) : 0);
    if (cov > 0) put(x, y, c, cov >= 4 ? 3 : cov >= 2 ? 2 : 1);
  };
  auto straight = [&](int y, int p, int q) {   // columns [p, q) outside the corner squares
    if (p >= q) return;
    if (!ring || y < r.y + bw || y >= r.y + r.h - bw || ix0 >= ix1) { span(y, p, q, c); return; }
    int e = std::min(q, ix0);
    span(y, p, e, c);
    span(y, std::max({p, ix1, e}), q, c);
  };
  for (int y = ya; y < yb; ++y) {
    if (y >= tcEnd && y < bcBeg) { straight(y, xa, xb); continue; }
    for (int x = xa; x < std::min(xb, lcEnd); ++x) pix(x, y);
    straight(y, std::max(xa, lcEnd), std::min(xb, rcBeg));
    for (int x = std::max(xa, rcBeg); x < xb; ++x) pix(x, y);
  }
}

void Canvas::frame(Rect r, int bw, Ink c, int radius) {
  rec("R%d,%d,%d,%d,%d,%d,%d;", r.x, r.y, r.w, r.h, bw, int(c), radius);
  rrectCoverage(r, radius, 0, c, true, bw);
}

void Canvas::box(Rect r, int radius, Ink fc, int bw, Ink border) {
  rec("B%d,%d,%d,%d,%d,%d,%d,%d;", r.x, r.y, r.w, r.h, radius, int(fc), bw, int(border));
  std::string* save = rec_; rec_ = nullptr;
  rrectCoverage(r, radius, 0, fc, false, 0);
  if (bw > 0) rrectCoverage(r, radius, 0, border, true, bw);
  rec_ = save;
}

void Canvas::dashedFrame(Rect r, int bw, Ink c, int radius, int dash, int gapLen) {
  rec("D%d,%d,%d,%d,%d,%d,%d;", r.x, r.y, r.w, r.h, bw, int(c), radius);
  if (!fb_) return;
  std::string* save = rec_; rec_ = nullptr;
  // corners solid (arcs), straight edges dashed
  Rect saveClip = clip_;
  auto corner = [&](int cx, int cy) {
    Rect cr{int16_t(cx), int16_t(cy), int16_t(radius), int16_t(radius)};
    Rect inter{int16_t(std::max(cr.x, saveClip.x)), int16_t(std::max(cr.y, saveClip.y)), 0, 0};
    int ex = std::min(cr.x + cr.w, saveClip.x + saveClip.w), ey = std::min(cr.y + cr.h, saveClip.y + saveClip.h);
    inter.w = int16_t(std::max(0, ex - inter.x)); inter.h = int16_t(std::max(0, ey - inter.y));
    clip_ = inter;
    rrectCoverage(r, radius, 0, c, true, bw);
    clip_ = saveClip;
  };
  corner(r.x, r.y); corner(r.x + r.w - radius, r.y); corner(r.x, r.y + r.h - radius); corner(r.x + r.w - radius, r.y + r.h - radius);
  for (int x = r.x + radius; x < r.x + r.w - radius; x += dash + gapLen) {
    int w = std::min(dash, r.x + r.w - radius - x);
    fill(Rect{int16_t(x), r.y, int16_t(w), int16_t(bw)}, c);
    fill(Rect{int16_t(x), int16_t(r.y + r.h - bw), int16_t(w), int16_t(bw)}, c);
  }
  for (int y = r.y + radius; y < r.y + r.h - radius; y += dash + gapLen) {
    int h = std::min(dash, r.y + r.h - radius - y);
    fill(Rect{r.x, int16_t(y), int16_t(bw), int16_t(h)}, c);
    fill(Rect{int16_t(r.x + r.w - bw), int16_t(y), int16_t(bw), int16_t(h)}, c);
  }
  rec_ = save;
}

void Canvas::dottedHLine(int x, int y, int w, int th, Ink c) {
  rec("d%d,%d,%d;", x, y, w);
  std::string* save = rec_; rec_ = nullptr;
  for (int i = 0; i < w; i += th * 2) fill(Rect{int16_t(x + i), int16_t(y), int16_t(std::min(th, w - i)), int16_t(th)}, c);
  rec_ = save;
}

void Canvas::line(int x0, int y0, int x1, int y1, int th, Ink c) {
  rec("L%d,%d,%d,%d,%d,%d;", x0, y0, x1, y1, th, int(c));
  if (!fb_) return;
  const int dx = std::abs(x1 - x0), dy = -std::abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, o = th / 2;
  int err = dx + dy;
  for (;;) {
    for (int y = y0 - o; y < y0 - o + th; ++y) span(y, x0 - o, x0 - o + th, c);
    if (x0 == x1 && y0 == y1) break;
    int e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

void Canvas::circle(int cx, int cy, int r, Ink fc, int bw, Ink border) {
  Rect rr{int16_t(cx - r), int16_t(cy - r), int16_t(2 * r), int16_t(2 * r)};
  rec("C%d,%d,%d,%d,%d,%d;", cx, cy, r, int(fc), bw, int(border));
  std::string* save = rec_; rec_ = nullptr;
  rrectCoverage(rr, r, 0, fc, false, 0);
  if (bw > 0) rrectCoverage(rr, r, 0, border, true, bw);
  rec_ = save;
}

void Canvas::icon(Icon i, int x, int y, Ink c) {
  rec("I%d,%d,%d,%d;", int(i), x, y, int(c));
  if (!fb_) return;
  const IconData& d = iconData(i);
  int idx = 0;
  for (int yy = 0; yy < d.size; ++yy)
    for (int xx = 0; xx < d.size; ++xx, ++idx) {
      int a = (d.bits[idx >> 2] >> (6 - 2 * (idx & 3))) & 3;
      if (a) put(x + xx, y + yy, c, a);
    }
}

void Canvas::qr(int x, int y, int px, const std::string& text) {
  rec("Q%d,%d,%d:%s;", x, y, px, text.c_str());
  if (!fb_) return;
  QrMatrix m;
  if (!encodeQr(text, m) || m.size <= 0) return;
  int quiet = 2;
  int scale = std::max(1, px / (m.size + 2 * quiet));
  int total = scale * (m.size + 2 * quiet);
  int ox = x + (px - total) / 2 + quiet * scale, oy = y + (px - total) / 2 + quiet * scale;
  std::string* save = rec_; rec_ = nullptr;
  for (int r = 0; r < m.size; ++r)
    for (int c = 0; c < m.size; ++c)
      if (m.at(c, r)) fill(Rect{int16_t(ox + c * scale), int16_t(oy + r * scale), int16_t(scale), int16_t(scale)}, Ink::Black);
  rec_ = save;
}

// ---------- palette entries without a native level (gfx/style.h) ----------
// The one table EINK_NOTES.md §1 asks for: which pixel of a Tone fill gets which ink. Everything else is Paper.
static bool toneInk(Tone t, int x, int y, Ink& ink, bool dots) {
  if (t == Tone::Track) { ink = Ink::Black; return (x & 1) == 0 && (y & 1) == 0; }               // 25 % black
  if (t == Tone::Hatch) { ink = Ink::Black; return ((x + y) & 3) < 2; }                           // 50 % stripes
  if (dots) {                                                                                     // option D
    ink = Ink::Black;
    return (y & 3) == 0 && (x & 3) == ((y >> 2) & 1) * 2;                                         // 1 in 16, staggered
  }
  ink = Ink::G2;                                                                                  // option B
  return (x & 1) == 0 && (y & 1) == 0;                                                            // 25 % of level 2
}
static bool toneInk(Tone t, int x, int y, Ink& ink) { return toneInk(t, x, y, ink, activeLook().surface == Surface::Dots); }

void Canvas::tone(Rect r, int radius, Tone t) {
  rec("S%d,%d,%d,%d,%d,%d,%d;", r.x, r.y, r.w, r.h, radius, int(t), int(activeLook().surface));
  if (!fb_) return;
  if (t == Tone::Surf) surfs_.push_back({r, radius});
  surf_ = t == Tone::Surf;   // the card surface may be gray (dither option): not counted in grayPuts
  const bool dots = activeLook().surface == Surface::Dots;
  const RR4 g(r, radius);
  const int ya = std::max({int(r.y), int(clip_.y), 0}), yb = std::min({r.y + r.h, clip_.y + clip_.h, int(kScreenH)});
  const int xa = std::max({int(r.x), int(clip_.x), 0}), xb = std::min({r.x + r.w, clip_.x + clip_.w, int(kScreenW)});
  const int lcEnd = ceil4(g.x0 + g.r), rcBeg = ceil4(g.x1 - g.r), tcEnd = ceil4(g.y0 + g.r), bcBeg = ceil4(g.y1 - g.r);
  auto pix = [&](int x, int y) { Ink ink; put(x, y, toneInk(t, x, y, ink, dots) ? ink : Ink::Paper, 3); };
  for (int y = ya; y < yb; ++y) {
    // every pattern repeats every 4 px in x: one byte value per row for the straight part
    int vals[4], gray = 0;
    uint8_t pat = 0;
    for (int k = 0; k < 4; ++k) {
      Ink ink;
      vals[k] = toneInk(t, k, y, ink, dots) ? int(ink) : int(Ink::Paper);
      pat = uint8_t(pat | (vals[k] << (6 - 2 * k)));
    }
    auto run = [&](int p, int q) {   // [p, q) already clipped
      if (p >= q) return;
      uint8_t* row = fb_->data + size_t(y) * (kScreenW / 4);
      for (int x = p; x < q; ++x) gray += vals[x & 3] == 1 || vals[x & 3] == 2;
      for (; p < q && (p & 3); ++p) { int sh = 6 - 2 * (p & 3); row[p >> 2] = uint8_t((row[p >> 2] & ~(3 << sh)) | (vals[p & 3] << sh)); }
      for (; q > p && (q & 3); --q) { int sh = 6 - 2 * ((q - 1) & 3); row[(q - 1) >> 2] = uint8_t((row[(q - 1) >> 2] & ~(3 << sh)) | (vals[(q - 1) & 3] << sh)); }
      if (q > p) std::memset(row + (p >> 2), pat, size_t(q - p) >> 2);
    };
    if (y >= tcEnd && y < bcBeg) run(xa, xb);
    else {
      const int m0 = std::max(xa, lcEnd), m1 = std::max(m0, std::min(xb, rcBeg));
      for (int x = xa; x < xb; ++x) {
        if (x == m0) { run(m0, m1); x = m1; if (x >= xb) break; }
        if ((x < lcEnd || x >= rcBeg) && rrCov(x, y, g) < 2) continue;   // hard edge: patterns don't anti-alias
        pix(x, y);
      }
    }
    if (!surf_) grayPuts += uint32_t(gray);
  }
  surf_ = false;
}

// Text under 20 px on the card surface (issue #28): surface texture pixels (dither or dots) within 2 px of a glyph go
// back to paper, so dots never touch or sit inside small strokes. Only pixels that still hold the texture are cleared.
void Canvas::surfKnockout(int x, int baseline, int tw, const std::string& s, const FontData* d, const TextOpts& o) {
  const int halo = 2;
  int top = baseline - d->ascent - halo, h = d->ascent + d->descent + 2 * halo;
  int w = tw + 2 * halo + 4, left = x - halo - 2;
  std::vector<SurfArea> hit;
  for (auto& a : surfs_)
    if (left < a.r.x + a.r.w && left + w > a.r.x && top < a.r.y + a.r.h && top + h > a.r.y) hit.push_back(a);
  if (hit.empty() || w <= 0 || h <= 0) return;
  std::vector<uint8_t> near(size_t(w) * h, 0);   // 1 = within `halo` px of glyph ink
  int pen = x;
  for (uint32_t cp : utf8Decode(s)) {
    const Glyph* g = glyphOrFallback(d, cp);
    int adv = advanceOf(d, g, cp, o);
    if (g && g->w) {
      int gx = pen + g->xoff;
      if (o.tabular && d->digitAdv && cp >= '0' && cp <= '9') gx = pen + (adv - g->adv) / 2 + g->xoff;
      int gy = baseline + g->yoff, idx = 0;
      for (int yy = 0; yy < g->h; ++yy)
        for (int xx = 0; xx < g->w; ++xx, ++idx) {
          if (!((d->bits[g->off + (idx >> 2)] >> (6 - 2 * (idx & 3))) & 3)) continue;
          for (int dy = -halo; dy <= halo; ++dy)
            for (int dx = -halo; dx <= halo; ++dx) {
              int px = gx + xx + dx - left, py = gy + yy + dy - top;
              if (px >= 0 && py >= 0 && px < w && py < h) near[size_t(py) * w + px] = 1;
            }
        }
    }
    pen += adv + o.tracking;
  }
  for (int py = 0; py < h; ++py)
    for (int px = 0; px < w; ++px) {
      int X = left + px, Y = top + py;
      if (!near[size_t(py) * w + px] || !inClip(X, Y)) continue;
      for (auto& a : hit) {
        if (!contains(a.r, X, Y)) continue;
        const RR4 g(a.r, a.radius);
        bool corner = (4 * Y < g.y0 + g.r || 4 * Y >= g.y1 - g.r) && (4 * X < g.x0 + g.r || 4 * X >= g.x1 - g.r);
        if (corner && rrCov(X, Y, g) < 2) continue;
        Ink ink;
        if (toneInk(Tone::Surf, X, Y, ink) && get(X, Y) == ink) put(X, Y, Ink::Paper, 3);
        break;
      }
    }
}

void Canvas::arc(int cx, int cy, double radius, double stroke, double fromDeg, double sweepDeg, Ink c) {
  rec("A%d,%d,%d,%d,%d,%d,%d;", cx, cy, int(radius * 10), int(stroke * 10), int(fromDeg * 10), int(sweepDeg * 10), int(c));
  arcImpl(cx, cy, radius, stroke, fromDeg, sweepDeg, c, -1);
}

void Canvas::dashedHLine(int x, int y, int w, int th, int dash, int gapLen, Ink c) {
  rec("h%d,%d,%d,%d,%d,%d;", x, y, w, th, dash, gapLen);
  std::string* save = rec_; rec_ = nullptr;
  for (int i = 0; i < w; i += dash + gapLen) fill(Rect{int16_t(x + i), int16_t(y), int16_t(std::min(dash, w - i)), int16_t(th)}, c);
  rec_ = save;
}

void Canvas::toneUnder(int xa, int ya, int xb, int yb, int yBase, Tone t) {
  rec("U%d,%d,%d,%d,%d,%d;", xa, ya, xb, yb, yBase, int(t));
  if (!fb_ || xb < xa) return;
  std::string* save = rec_; rec_ = nullptr;
  for (int x = xa; x <= xb; ++x) {
    const int y = xb == xa ? std::min(ya, yb) : ya + int(std::lround(double(yb - ya) * (x - xa) / (xb - xa)));
    if (yBase > y) tone(Rect{int16_t(x), int16_t(y), 1, int16_t(yBase - y)}, 0, t);
  }
  rec_ = save;
}

void Canvas::dottedVLine(int x, int y, int h, int th, Ink c) {
  rec("v%d,%d,%d;", x, y, h);
  std::string* save = rec_; rec_ = nullptr;
  for (int i = 0; i < h; i += th * 2) fill(Rect{int16_t(x), int16_t(y + i), int16_t(th), int16_t(std::min(th, h - i))}, c);
  rec_ = save;
}

void Canvas::arcTone(int cx, int cy, double radius, double stroke, double fromDeg, double sweepDeg, Tone t) {
  rec("a%d,%d,%d,%d,%d,%d,%d;", cx, cy, int(radius * 10), int(stroke * 10), int(fromDeg * 10), int(sweepDeg * 10), int(t));
  arcImpl(cx, cy, radius, stroke, fromDeg, sweepDeg, Ink::Black, int(t));
}

// 4x4 supersampled stroke of a circular arc with round caps. `exact` is the reference test of one sample in doubles;
// those are soft-float on the ESP32-S3, so only pixels near an angle or cap boundary still use it (issue #213). The radial
// band is tested in 1/8 px integers (exact when radius and stroke/2 are multiples of 1/8), angles and caps in float with a
// margin; anything inside the margin falls back to `exact`. Same pixels as the all-double version.
namespace {
constexpr double kPi = 3.14159265358979323846;
struct ArcRef {   // the double reference tests, kept out of line so the per-pixel loop has no soft-float
  int cx, cy;
  double rad, stroke, a0, a1, ex0, ey0, ex1, ey1, s2;
  bool full;
  // the per-pixel loop's integer / float view of the same arc
  int R;
  bool intBand;
  int32_t loD, hiD;   // 1/8 px squared; rad, stroke < 1024 keep every sample's d^2 below 2^31
  float fa0, fa1, fs2, capR, fex0, fey0, fex1, fey1;
  __attribute__((noinline)) ArcRef(int x, int y, double r, double s, double fromDeg, double sweepDeg)
      : cx(x), cy(y), rad(r), stroke(s), a0(fromDeg * kPi / 180), a1((fromDeg + sweepDeg) * kPi / 180),
        ex0(cx + rad * std::cos(a0)), ey0(cy + rad * std::sin(a0)), ex1(cx + rad * std::cos(a1)), ey1(cy + rad * std::sin(a1)),
        s2(stroke * stroke / 4), full(sweepDeg >= 360), R(int(rad + stroke) + 1) {
    intBand = rad >= 0 && rad < 1024 && stroke >= 0 && stroke < 1024 && rad * 8 == std::floor(rad * 8) &&
              stroke * 4 == std::floor(stroke * 4);
    const int lo8 = int((rad - stroke / 2) * 8), hi8 = int((rad + stroke / 2) * 8);
    loD = lo8 > 0 ? lo8 * lo8 : -1;
    hiD = hi8 * hi8;
    fa0 = float(a0); fa1 = float(a1); fs2 = float(s2); capR = float(stroke / 2) + 0.6f;
    fex0 = float(ex0); fey0 = float(ey0); fex1 = float(ex1); fey1 = float(ey1);
  }
  __attribute__((noinline)) bool angIn(int x, int y, int sx, int sy) const {
    double a = std::atan2(y + (sy + 0.5) / 4 - cy, x + (sx + 0.5) / 4 - cx);
    while (a < a0) a += 2 * kPi;
    return a <= a1;
  }
  __attribute__((noinline)) bool capIn(int x, int y, int sx, int sy) const {
    double X = x + (sx + 0.5) / 4, Y = y + (sy + 0.5) / 4;
    return (X - ex0) * (X - ex0) + (Y - ey0) * (Y - ey0) <= s2 || (X - ex1) * (X - ex1) + (Y - ey1) * (Y - ey1) <= s2;
  }
  __attribute__((noinline)) bool exact(int x, int y, int sx, int sy) const {
    double X = x + (sx + 0.5) / 4, Y = y + (sy + 0.5) / 4, dx = X - cx, dy = Y - cy;
    double d = std::sqrt(dx * dx + dy * dy);
    bool in = false;
    if (std::fabs(d - rad) <= stroke / 2) in = full || angIn(x, y, sx, sy);
    if (!in && !full) in = capIn(x, y, sx, sy);
    return in;
  }
};
}  // namespace

void Canvas::arcImpl(int cx, int cy, double rad, double stroke, double fromDeg, double sweepDeg, Ink c, int tone) {
  if (!fb_ || sweepDeg <= 0) return;
  const ArcRef ref(cx, cy, rad, stroke, fromDeg, sweepDeg);
  const int R = ref.R;
  const bool full = ref.full, intBand = ref.intBand;
  const int32_t loD = ref.loD, hiD = ref.hiD;
  const float fa0 = ref.fa0, fa1 = ref.fa1, fs2 = ref.fs2, capR = ref.capR;
  const float fex0 = ref.fex0, fey0 = ref.fey0, fex1 = ref.fex1, fey1 = ref.fey1;
  constexpr float f2pi = float(2 * kPi), fpi = float(kPi);
  auto wrap = [&](float a) { while (a < fa0) a += f2pi; return a; };
  // one sample's angle in float; 0 = out, 1 = in, -1 = too close to call
  auto angF = [&](float dx, float dy, float m) {
    float a = std::atan2(dy, dx);
    if (std::fabs(a) >= fpi - m) return -1;
    float w = wrap(a);
    if (w - fa0 < m || fa0 + f2pi - w <= m) return -1;
    return w + m <= fa1 ? 1 : w - m > fa1 ? 0 : -1;
  };
  auto capF = [&](float X, float Y, int x, int y, int sx, int sy) {
    float q0 = (X - fex0) * (X - fex0) + (Y - fey0) * (Y - fey0), q1 = (X - fex1) * (X - fex1) + (Y - fey1) * (Y - fey1);
    const float m = 1e-3f * (fs2 + 1);
    if (q0 < fs2 - m || q1 < fs2 - m) return true;
    if (q0 > fs2 + m && q1 > fs2 + m) return false;
    return ref.capIn(x, y, sx, sy);
  };
  for (int y = cy - R; y <= cy + R; ++y)
    for (int x = cx - R; x <= cx + R; ++x) {
      if (!inClip(x, y)) continue;
      int n = 0;
      if (!intBand) {
        for (int sy = 0; sy < 4; ++sy) for (int sx = 0; sx < 4; ++sx) n += ref.exact(x, y, sx, sy);
      } else {
        bool band[16];
        int nb = 0;
        for (int sy = 0; sy < 4; ++sy)
          for (int sx = 0; sx < 4; ++sx) {
            int32_t dx8 = 8 * (x - cx) + 2 * sx + 1, dy8 = 8 * (y - cy) + 2 * sy + 1, D = dx8 * dx8 + dy8 * dy8;
            nb += band[sy * 4 + sx] = D >= loD && D <= hiD;
          }
        const float cxf = float(x - cx) + 0.5f, cyf = float(y - cy) + 0.5f;
        int pixAng = 1;   // all in-band samples share one angle verdict (1 in, 0 out) or -1: decide per sample
        if (!full && nb) {
          float dc = std::sqrt(cxf * cxf + cyf * cyf);
          pixAng = dc > 4 ? angF(cxf, cyf, 0.6f / dc + 1e-3f) : -1;
        }
        bool nearCap = false;
        if (!full) {
          float q0 = (cxf - (fex0 - cx)) * (cxf - (fex0 - cx)) + (cyf - (fey0 - cy)) * (cyf - (fey0 - cy));
          float q1 = (cxf - (fex1 - cx)) * (cxf - (fex1 - cx)) + (cyf - (fey1 - cy)) * (cyf - (fey1 - cy));
          nearCap = q0 <= capR * capR || q1 <= capR * capR;
        }
        if (full || (pixAng >= 0 && !nearCap)) {
          n = pixAng ? nb : 0;
        } else {
          for (int sy = 0; sy < 4; ++sy)
            for (int sx = 0; sx < 4; ++sx) {
              bool in = band[sy * 4 + sx];
              float dxf = float(x - cx) + (sx + 0.5f) / 4, dyf = float(y - cy) + (sy + 0.5f) / 4;
              if (in) {
                int v = pixAng >= 0 ? pixAng : angF(dxf, dyf, 1e-3f);
                in = v >= 0 ? v == 1 : ref.angIn(x, y, sx, sy);
              }
              if (!in && nearCap) in = capF(float(x) + (sx + 0.5f) / 4, float(y) + (sy + 0.5f) / 4, x, y, sx, sy);
              n += in;
            }
        }
      }
      if (tone >= 0) {
        if (n < 8) continue;
        Ink ink;
        put(x, y, toneInk(Tone(tone), x, y, ink) ? ink : Ink::Paper, 3);
      } else if (n) {
        put(x, y, c, n >= 14 ? 3 : n >= 8 ? 2 : n >= 3 ? 1 : 0);
      }
    }
}

void Canvas::hit(Rect r, std::function<void()> fn) {
  if (hits_) hits_->push_back(Hit{r, std::move(fn), region_});
}

}  // namespace x4
