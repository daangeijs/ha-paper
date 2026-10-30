// Weather tile (#318, emulator Device.tsx WeatherTile, text from core/weather.cpp view): the hero row (120 px drawing,
// temperature, condition · feels, high / low / wind / rain on the right) and, full screen (rs 2), the 5-day strip with
// 44 px drawings, high / low and a rain bar (solid from half the scale, else hatched). Classic: one frame with a 2 px
// rule; Modern: two surface cards. 1-bit: Ink / Hatch only.
#include <algorithm>
#include <cmath>
#include "app/app_impl.h"
#include "core/weather.h"

namespace x4 {
namespace ui {

namespace {
Icon heroIcon(wx::Icon i) { return Icon(int(Icon::WxSun120) + int(i)); }
Icon dayIcon(wx::Icon i) { return Icon(int(Icon::WxSun44) + int(i)); }

void hero(Canvas& c, I& a, const wx::View& v, Rect h, bool sl) {
  const int pad = 24, sz = 120;
  c.icon(heroIcon(v.icon), h.x + pad, h.y + (h.h - sz) / 2, Ink::Black);
  // right column: High 13°  Low 6° / Wind 4 Bft SW / Rain from 15:00
  Font lf = sl ? T4(17) : R(18), vf = sl ? T7(19) : B(19);
  TextOpts vo; vo.tabular = true;
  const int right = h.x + h.w - pad, lineH = 30, colTop = h.y + (h.h - 3 * lineH) / 2;
  auto bl = [&](int k) { return baseline(colTop + k * lineH, vf, double(lineH) / vf.size); };
  auto pair = [&](int x, int b, const char* lab, const std::string& val) {   // right-aligned at x; returns its left edge
    x -= c.textWidth(val, vf, vo);
    c.text(x, b, val, vf, vo);
    x -= 6 + c.textWidth(lab, lf);
    c.text(x, b, lab, lf);
    return x;
  };
  int left = pair(right, bl(0), a.t(S::wxLow), v.low);
  left = std::min(left, pair(left - 14, bl(0), a.t(S::wxHigh), v.high));
  left = std::min(left, pair(right, bl(1), a.t(S::wxWind), v.wind));
  left = std::min(left, pair(right, bl(2), a.t(S::wxRain), v.rain));
  // temperature, condition · feels
  Font tf = sl ? D(104) : B(92), cf = sl ? T7(21) : B(21);
  const int tx = h.x + pad + sz + pad, maxW = std::max(0, left - 16 - tx);
  const int tCap = Canvas::capHeight(tf), cCap = Canvas::capHeight(cf), blockH = tCap + 18 + cCap;
  const int tbl = h.y + (h.h - blockH) / 2 + tCap, cbl = tbl + 18 + cCap;
  TextOpts co; co.maxW = maxW;
  if (v.gap != EntityGap::None) {
    gapRing(c, tx, tbl);
    c.text(tx, cbl, gapText(a, v.gap), cf, co);
    return;
  }
  TextOpts to; to.tabular = true; to.tracking = -2; to.maxW = maxW;
  c.text(tx, tbl, v.temp, tf, to);
  std::string line = v.cond;
  if (!v.feels.empty()) line += (line.empty() ? "" : " · ") + v.feels;
  c.text(tx, cbl, line, cf, co);
}

void strip(Canvas& c, I& a, const wx::View& v, Rect s, bool sl) {
  Font nf = sl ? T7(18) : B(18), hf = sl ? D(22) : B(22), lf = sl ? T4(18) : R(19), mf = sl ? T4(15) : R(15);
  if (!v.nDays) {
    c.textCenter(s.x + s.w / 2, s.y + s.h / 2 + Canvas::capHeight(nf) / 2, a.t(S::wxNoForecast), nf, C(Ink::Black));
    return;
  }
  const int x0 = s.x + 16, colW = (s.w - 32) / wx::kDays, top = s.y + 10, bot = s.y + s.h - 10;
  TextOpts to; to.tabular = true;
  for (int i = 0; i < v.nDays; ++i) {
    const wx::Day& d = v.days[i];
    const int cx = x0 + i * colW + colW / 2;
    const int nbl = top + Canvas::capHeight(nf);
    c.textCenter(cx, nbl, d.name, nf, C(Ink::Black));
    const int iy = nbl + 8;
    c.icon(dayIcon(d.icon), cx - 22, iy, Ink::Black);
    const int tbl = iy + 44 + 6 + Canvas::capHeight(hf);
    const int hw = c.textWidth(d.hi, hf, to), lw = c.textWidth(d.lo, lf, to), tx = cx - (hw + 8 + lw) / 2;
    c.text(tx, tbl, d.hi, hf, to);
    c.text(tx + hw + 8, tbl, d.lo, lf, to);
    // rain bar between the temperatures and the amount
    const int mbl = bot, barBot = mbl - Canvas::capHeight(mf) - 8, barTop = std::max(tbl + 10, barBot - 34);
    const int bw = colW * 6 / 10, bx = cx - bw / 2, H = barBot - barTop;
    if (H >= 4) {
      c.hline(bx, barBot - 2, bw, 2, Ink::Black);
      const int fh = d.bar > 0 ? std::max(2, int(std::lround(d.bar * (H - 2)))) : 0;
      if (fh) {
        Rect b = rc(bx, barBot - 2 - fh, bw, fh);
        if (d.bar >= 0.5) c.fill(b, Ink::Black);
        else c.tone(b, 0, Tone::Hatch);
      }
    }
    if (!d.mm.empty()) c.textCenter(cx, mbl, d.mm, mf, to);
  }
}
}  // namespace

void weatherTile(Canvas& c, I& a, const Widget& w, Rect r) {
  const bool sl = sleek(), tall = w.rs > 1;
  const std::string id = w.field("entity");
  wx::View v;
  wx::view(a.store.get(id), a.wxOf(id), a.now.epochMs, a.now.tz, a.lang, v);
  if (!tall) {
    tileFrame(c, r);
    hero(c, a, v, r, sl);
    return;
  }
  if (sl) {   // two cards, 10 px apart
    const int hh = (r.h - 10) / 2;
    Rect h = rc(r.x, r.y, r.w, hh), s = rc(r.x, r.y + hh + 10, r.w, r.h - hh - 10);
    c.tone(h, 20, Tone::Surf);
    c.tone(s, 20, Tone::Surf);
    hero(c, a, v, h, sl);
    strip(c, a, v, s, sl);
    return;
  }
  tileFrame(c, r);
  const int hh = r.h / 2;
  hero(c, a, v, rc(r.x, r.y, r.w, hh), sl);
  c.hline(r.x + 14, r.y + hh - 1, r.w - 28, 2, Ink::Black);
  strip(c, a, v, rc(r.x, r.y + hh + 1, r.w, r.h - hh - 1), sl);
}

}  // namespace ui
}  // namespace x4
