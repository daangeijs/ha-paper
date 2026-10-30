// Good morning page (eink-ha-os#330, emulator Device.tsx GOOD MORNING, text from core/morning.cpp): greeting + date on the left,
// today's weather on the right; a rule, today's events, bins due today / tonight. The block is centred vertically, so a
// page with only the greeting row sits in the middle. Classic look in both styles, like the quiet face.
#include <algorithm>
#include "app/app_impl.h"
#include "core/bins.h"
#include "core/morning.h"

namespace x4 {
namespace ui {

namespace {
constexpr int kX0 = 56, kX1 = kScreenW - 56, kGap = 20, kRow = 33, kRowGap = 6, kTimeW = 128;

morning::View viewOf(I& a) {
  const quiet::Sources src = quiet::sources(a.cfg.screens);   // eink-ha-os#328: the Tomorrow row's sources
  auto tile = [&](const quiet::Ref& r) -> const Widget* { return r.screen >= 0 ? &a.cfg.screens[size_t(r.screen)].widgets[size_t(r.widget)] : nullptr; };
  const Widget* wx = tile(src.weather);
  const Widget* ag = tile(src.agenda);
  const Widget* bt = tile(src.bins);
  const wx::Forecast* fc = wx ? a.wxOf(wx->field("entity")) : nullptr;
  const auto* slot = ag ? a.agendaOf(agenda::keyOf(ag->field("entities"))) : nullptr;
  const agenda::Fetch* ev = slot && slot->state == agenda::State::Ok ? &slot->f : nullptr;
  std::vector<morning::Bin> bins;
  if (bt)
    for (auto& b : bins::inputs(bt->field("entities"), bt->field("labels"), a.store))
      bins.push_back({b.label, bins::days(b.v, a.now.epochMs, a.now.tz)});
  return morning::view({a.now.epochMs, a.now.tz, a.lang, fc, ev, bt ? &bins : nullptr});
}
}  // namespace

void morningFace(Canvas& c, I& a) {
  const morning::View v = viewOf(a);
  const Font hf = B(46), df = B(26), tf = B(34), rf = R(26), ef = B(26), nf = R(26), mf = R(18);
  // heights (CSS line boxes of the emulator face)
  const int leftH = 46 + 10 + 31;
  const int colH = (v.temps.empty() ? 0 : 37) + (v.rain.empty() ? 0 : 33);
  const int headH = std::max(leftH, v.weather ? std::max(v.hasIcon ? 44 : 0, colH) : 0);
  const int nEv = int(v.events.size()), nBin = int(v.bins.size());
  const int evH = nEv ? nEv * kRow + (nEv - 1) * kRowGap + (v.more.empty() ? 0 : kRowGap + 22) : 0;
  const int binH = nBin ? nBin * kRow + (nBin - 1) * kRowGap : 0;
  const bool below = nEv || nBin;
  const int h = headH + (below ? kGap + 2 : 0) + (nEv ? kGap + evH : 0) + (nBin ? kGap + binH : 0);
  int y = std::max(16, (kScreenH - h) / 2);
  // greeting + date
  const int ly = y + (headH - leftH) / 2;
  c.text(kX0, baseline(ly, hf, 1.0), v.head, hf);
  c.text(kX0, baseline(ly + 46 + 10, df, 1.2), v.date, df);
  // weather, right-aligned: drawing, then high / low over the rain line
  if (v.weather) {
    TextOpts to; to.tabular = true;
    const int cw = std::max(v.temps.empty() ? 0 : c.textWidth(v.temps, tf, to), v.rain.empty() ? 0 : c.textWidth(v.rain, rf));
    const int cx = kX1 - cw;
    int cy = y + (headH - colH) / 2;
    if (!v.temps.empty()) { c.text(cx, baseline(cy, tf, 1.1), v.temps, tf, to); cy += 37; }
    if (!v.rain.empty()) c.text(cx, baseline(cy, rf, 1.25), v.rain, rf);
    if (v.hasIcon) c.icon(Icon(int(Icon::WxSun44) + int(v.icon)), cx - 14 - 44, y + (headH - 44) / 2, Ink::Black);
  }
  y += headH;
  if (below) { y += kGap; c.hline(kX0, y, kX1 - kX0, 2, Ink::Black); y += 2; }
  if (nEv) {
    y += kGap;
    TextOpts to; to.tabular = true;
    TextOpts no; no.maxW = kX1 - kX0 - kTimeW;
    for (int i = 0; i < nEv; ++i) {
      c.text(kX0, baseline(y, ef, 1.25), v.events[size_t(i)].time, ef, to);
      c.text(kX0 + kTimeW, baseline(y, nf, 1.25), v.events[size_t(i)].title, nf, no);
      y += kRow + (i + 1 < nEv ? kRowGap : 0);
    }
    if (!v.more.empty()) { y += kRowGap; c.text(kX0 + kTimeW, baseline(y, mf, 1.2), v.more, mf); y += 22; }
  }
  if (nBin) {
    y += kGap;
    for (int i = 0; i < nBin; ++i) {
      const auto& b = v.bins[size_t(i)];
      const int bl = baseline(y, ef, 1.25);
      int x = kX0 + c.text(kX0, bl, b.labels, ef);
      x += c.text(x, bl, " · ", nf);
      TextOpts wo; wo.maxW = std::max(0, kX1 - x);
      c.text(x, bl, b.when, nf, wo);
      y += kRow + kRowGap;
    }
  }
}

}  // namespace ui
}  // namespace x4
