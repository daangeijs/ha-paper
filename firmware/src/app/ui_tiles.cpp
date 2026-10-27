// Dashboard widgets: stat, clock, price, gauge, bars, history, route, thermo, switch, scene, setting, ghost, link card, lists.
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include "app/app_impl.h"
#include "core/catalog.h"
#include "core/history.h"
#include "core/history_chart.h"
#include "core/json.h"

namespace x4 {
namespace ui {

static int mid(int top, int h, Font f) { int ch = Canvas::capHeight(f); return top + (h - ch) / 2 + ch; }

// #199 text scale: tile labels B20 (arm's length), sub lines R18; a sub line that does not fit at 18 steps down to
// 16 before it ellipsizes ("Discharging 2.50 kW", "7 kamers verwarmen" on a 1-wide tile).
static const int kLabel = 20, kLabelH = 24, kSubH = 22;
static void subLine(Canvas& c, int x, int top, const std::string& s, int maxW, TextOpts o = C(Ink::Black)) {
  Font f = c.textWidth(s, R(18)) <= maxW ? R(18) : R(16);
  o.maxW = maxW;
  c.text(x, baseline(top, f, 1.2), s, f, o);
}

// value + unit on a shared baseline
static void valueUnit(Canvas& c, int x, int bl, const std::string& v, int vs, const std::string& u, int us, int gap = 6, const std::string& pre = "", int ps = 22) {
  TextOpts t; t.tracking = vs >= 50 ? -2 : -1; t.tabular = true;
  if (!pre.empty()) x += c.text(x, bl, pre, B(ps)) + 4;
  int w = c.text(x, bl, v, B(vs), t);
  if (!u.empty()) c.text(x + w + gap, bl, u, B(us));
}

// value + unit that fit maxW (#151, #162 core fitValue): drop decimals while 2 significant digits stay
// ("28.30 kWh" → "28.3 kWh", "0.2534" → "0.25"), then a smaller value size
static void fitValueUnit(Canvas& c, std::string& v, int& vs, const std::string& u, int us, int maxW, int gap = 6) {
  const int uw = u.empty() ? 0 : gap + c.textWidth(u, B(us));
  std::vector<int> sizes;
  for (int s : {50, 46, 44, 40, 36, 34}) if (s <= vs) sizes.push_back(s);
  FitValue f = fitValue(v, sizes, maxW, [&c, uw](const std::string& x, int size) {
    TextOpts t; t.tabular = true; t.tracking = size >= 50 ? -2 : -1;
    return c.textWidth(x, B(size), t) + uw;
  });
  v = f.value; vs = f.size;
}

// A tile label that is too wide for one B20 line: two lines when it has a space (lines() = 2), else B18/B16 on one
// line, then the ellipsis ("TERUGGELEVERD"). Sleek keeps its own one-line label.
static int labelLines(Canvas& c, const std::string& s, int maxW) {
  if (sleek()) return 1;
  TextOpts o; o.upper = true;
  if (c.textWidth(s, B(kLabel), o) <= maxW || s.find(' ') == std::string::npos) return 1;
  return Canvas(nullptr).paragraph(0, 0, maxW, kLabelH, s, B(kLabel), o, 2);
}
static void tileLabel(Canvas& c, int x, int top, const std::string& s, int maxW, int lines) {
  TextOpts o; o.upper = true; o.maxW = maxW;
  if (lines == 2) { c.paragraph(x, top, maxW, kLabelH, s, B(kLabel), o, 2); return; }
  int size = kLabel;
  if (!sleek()) while (size > 16 && c.textWidth(s, B(size), o) > maxW) size -= 2;
  if (sleek() || size == kLabel) { label(c, x, top, s, kLabel, Ink::Black, maxW); return; }
  c.text(x, baseline(top, B(size), 1.2) + (kLabelH - int(size * 1.2)) / 2, s, B(size), o);   // same cap line centre
}

// three-part column with space-between (label / value / sub)
struct Col3 { int labelTop, valueBl, subTop; };
static Col3 col3(Rect r, int valueSize, int extra = 0) {   // extra: a 2nd label line
  int top = r.y + 12, bottom = r.y + r.h - 12;
  int lh = kLabelH, sh = kSubH;
  int free = (bottom - top) - lh - valueSize - sh - extra;
  int g = free / 2;
  Col3 c;
  c.labelTop = top;
  int vtop = top + lh + extra + g;
  c.valueBl = baseline(vtop, B(valueSize), 1.0);
  c.subTop = bottom - sh;
  return c;
}

void gapRing(Canvas& c, int x, int bl) { c.circle(x + 14, bl - 14, 14, Ink::Paper, 3, Ink::Black); }
std::string gapText(I& a, EntityGap g) { return g == EntityGap::None ? std::string() : a.t(g == EntityGap::Unavailable ? S::gapUnavailable : S::gapUnknown); }

static void statTile(Canvas& c, I& a, const Widget& w, Rect r) {
  std::string id = w.field("entity");
  StatText s = statText(id, a.data, a.now.h, a.statEntity(id), a.lang);
  if (!w.field("label").empty()) s.label = w.field("label");
  if (s.gap != EntityGap::None) s.sub = gapText(a, s.gap);
  int ll = labelLines(c, s.label, r.w - 28);
  Col3 k = col3(r, 50, (ll - 1) * kLabelH);
  tileLabel(c, r.x + 14, k.labelTop, s.label, r.w - 28, ll);
  if (s.gap != EntityGap::None) gapRing(c, r.x + 14, k.valueBl);
  else { int vs = 50; fitValueUnit(c, s.value, vs, s.unit, 18, r.w - 28); valueUnit(c, r.x + 14, k.valueBl, s.value, vs, s.unit, 18); }
  subLine(c, r.x + 14, k.subTop, s.sub, r.w - 28);
}

// The digits are their own region k<i> (clockTime), so the minute tick redraws only them (issue #38).
static int clockTop(Rect r) { return r.y + (r.h - (87 + 4 + 24)) / 2; }
static TextOpts clockOpts() { TextOpts t; t.tracking = -4; t.tabular = true; return t; }

static void clockTile(Canvas& c, I& a, Rect r) {
  TextOpts d; d.maxW = r.w - 36;
  // #299: asleep, the digits are the update time; the date line says so
  c.text(r.x + 18, baseline(clockTop(r) + 87 + 4, B(20), 1.2), a.asleepAt.empty() ? a.now.date : std::string(a.t(S::clockAsleep)), B(20), d);
}

Rect clockTimeRect(I& a, const Widget& w, Rect r) {
  (void)a;
  if (sleek()) return sleekClockTimeRect(r);
  (void)w;
  int cw = std::min(r.w - 18, Canvas().textWidth("00:00", B(92), clockOpts()) + 8);
  return rc(r.x + 16, clockTop(r), cw, 87);
}

void clockTime(Canvas& c, I& a, const Widget& w, Rect r) {
  if (sleek()) { sleekClockTime(c, a, w, r); return; }
  c.text(r.x + 18, baseline(clockTop(r), B(92), 0.95), a.asleepAt.empty() ? a.now.clock : a.asleepAt, B(92), clockOpts());
}

static void priceTile(Canvas& c, I& a, const Widget& w, Rect r) {
  const auto& P = a.data.prices;
  Col3 k = col3(r, 50);
  std::string lab = w.field("label").empty() ? std::string(a.t(S::price)) : w.field("label");   // #148
  if (P.size() < 24 || !a.now.known) {
    tileLabel(c, r.x + 14, k.labelTop, lab, r.w - 28, 1);
    c.text(r.x + 14, k.valueBl, "—", B(50));
    return;
  }
  int h = a.now.h;
  double p = a.data.priceAt(h, a.now.m);   // this quarter-hour's when the source has them (#151)
  std::vector<double> s = P; std::sort(s.begin(), s.end());
  bool cheap = p <= s[7], dear = p >= s[16];
  std::string tag = utf8Upper(a.t(cheap ? S::cheap : dear ? S::high : S::normal));
  // #199: tag B16, one step smaller per px it lacks beside the label (down to B13, "GOEDKOOP" next to "PRIJS")
  TextOpts lo; lo.upper = true;
  int room = r.w - 28 - c.textWidth(lab, B(kLabel), lo) - 8, ts = 16;
  while (ts > 13 && c.textWidth(tag, B(ts)) + 14 > room) --ts;
  int tw = c.textWidth(tag, B(ts)) + 14;
  Rect tb = rc(r.x + r.w - 14 - tw, k.labelTop, tw, 26);
  tileLabel(c, r.x + 14, k.labelTop, lab, r.w - 28 - tw - 8, 1);
  c.box(tb, 4, dear ? Ink::Black : Ink::Paper, 2, Ink::Black);
  c.textCenter(tb.x + tb.w / 2, mid(tb.y, tb.h, B(ts)), tag, B(ts), C(dear ? Ink::Paper : Ink::Black));
  TextOpts t; t.tracking = -2; t.tabular = true;
  int x = r.x + 14;
  x += c.text(x, k.valueBl, locale::currency(), B(22)) + 3;
  x += c.text(x, k.valueBl, fmtNum(p, "", 2), B(50), t) + 4;
  c.text(x, k.valueBl, "/kWh", B(16));
  int ch = a.data.cheapestStart(3);
  std::string sub = h >= ch && h < ch + 3 ? std::string(a.t(S::cheapestNow)) : a.t(S::cheapestAt, pad2(ch) + "–" + pad2(ch + 3) + " h");
  subLine(c, r.x + 14, k.subTop, sub, r.w - 28);
}

// an HA entity's state as a gauge percent, clamped 0–100; false = not a number
static bool entityPct(const EntityValue* v, int& pct) {
  char* end = nullptr;
  double x = entityAvailable(v) ? std::strtod(v->state.c_str(), &end) : 0;
  bool ok = entityAvailable(v) && end && end != v->state.c_str();
  pct = ok ? int(jsRound(std::max(0.0, std::min(100.0, x)))) : 0;
  return ok;
}

// gauge on any HA entity: percent bar of its state (0–100)
static void entityGaugeTile(Canvas& c, I& a, const Widget& w, Rect r, const std::string& id) {
  const EntityValue* v = a.store.get(id);
  int top = r.y + 12;
  std::string lab = w.field("label").empty() ? friendlyName(id, v) : w.field("label");
  int lh = labelLines(c, lab, r.w - 28) * kLabelH;
  int g = ((r.y + r.h - 12 - top) - lh - 50 - 18 - kSubH) / 3;
  tileLabel(c, r.x + 14, top, lab, r.w - 28, lh / kLabelH);
  int vtop = top + lh + g;
  int pct = 0;
  bool ok = entityPct(v, pct);
  EntityGap gap = entityGap(v);
  if (gap != EntityGap::None) gapRing(c, r.x + 14, baseline(vtop, B(50), 1.0));
  else valueUnit(c, r.x + 14, baseline(vtop, B(50), 1.0), ok ? std::to_string(pct) : "—", 50, ok ? "%" : "", 20, 4);
  Rect bar = rc(r.x + 14, vtop + 50 + g, r.w - 28, 18);
  c.frame(bar, 2, Ink::Black, 4);
  c.fill(rc(bar.x + 4, bar.y + 4, (bar.w - 8) * pct / 100, bar.h - 8), Ink::Black);
  if (gap != EntityGap::None) subLine(c, r.x + 14, r.y + r.h - 12 - kSubH, gapText(a, gap), r.w - 28);
}

static void gaugeTile(Canvas& c, I& a, const Widget& w, Rect r) {
  std::string id = w.field("entity");
  if (!id.empty() && id != kGaugeDefaultEntity) { entityGaugeTile(c, a, w, r, id); return; }
  const HomeData& d = a.data;
  int top = r.y + 12, bottom = r.y + r.h - 12;
  std::string lab = w.field("label").empty() ? std::string(a.t(S::homeBattery)) : w.field("label");
  int lh = labelLines(c, lab, r.w - 28) * kLabelH;
  int g = ((bottom - top) - lh - 50 - 18 - kSubH) / 3;
  tileLabel(c, r.x + 14, top, lab, r.w - 28, lh / kLabelH);
  int vtop = top + lh + g;
  int pct = d.soc.ok ? int(jsRound(d.soc.v)) : 0;
  valueUnit(c, r.x + 14, baseline(vtop, B(50), 1.0), d.soc.ok ? std::to_string(pct) : "—", 50, d.soc.ok ? "%" : "", 20, 4);
  Rect bar = rc(r.x + 14, vtop + 50 + g, r.w - 28, 18);
  c.frame(bar, 2, Ink::Black, 4);
  c.fill(rc(bar.x + 4, bar.y + 4, (bar.w - 8) * std::max(0, std::min(100, pct)) / 100, bar.h - 8), Ink::Black);
  std::string sub;
  if (d.batt.ok) { auto f = kw(d.batt.v); sub = d.batt.v > 30 ? a.t(S::charging, f.v + " " + f.u) : d.batt.v < -30 ? a.t(S::discharging, f.v + " " + f.u) : a.t(S::idle); }
  subLine(c, r.x + 14, bottom - kSubH, sub, r.w - 28);
}

static void barsTile(Canvas& c, I& a, const Widget& w, Rect r) {
  std::string series = w.field("series");
  const HomeData& d = a.data;
  const std::vector<double>& ser = series == "prices" ? d.prices : series == "solar" ? d.solarSeries : d.usage;
  std::string lab = !w.field("label").empty() ? w.field("label")
                    : series == "prices" ? a.t(S::chartPrices, locale::currency()) : a.t(series == "solar" ? S::chartSolar : S::chartUsage);
  int x0 = r.x + 14, x1 = r.x + r.w - 14, top = r.y + 10, bottom = r.y + r.h - 8;
  int h = a.now.h;
  std::string summary;
  int ch = d.cheapestStart(3);
  if (series == "prices") { if (ser.size() >= 24 && a.now.known) summary = a.t(S::pricesSummary, locale::money(d.priceAt(h, a.now.m)), pad2(ch) + "–" + pad2(ch + 3)); }
  else if (series == "solar") { if (d.solarToday.ok) summary = a.t(S::soFar, fmtNum(d.solarToday.v, "kWh")); }
  else if (d.usedToday.ok) summary = a.t(S::soFar, fmtNum(d.usedToday.v, "kWh"));
  int sumW = c.textWidth(summary, B(18));
  TextOpts lo; lo.upper = true;
  if (c.textWidth(lab, B(kLabel), lo) + sumW + 10 > x1 - x0) summary.clear(), sumW = 0;   // narrow tile: label wins
  label(c, x0, top, lab, kLabel, Ink::Black, x1 - x0 - sumW - 10);
  if (!summary.empty()) c.textRight(x1, baseline(top, B(kLabel), 1.2), summary, B(18));
  // prices (#260): today's low / high under the axis, a caret over the hour now (room above the bars)
  const bool pr = series == "prices";
  int axisTop = bottom - 21 - (pr ? 27 : 0);
  int chartTop = top + kLabelH + 6 + (pr ? 14 : 0), chartBot = axisTop - 6 - 2;
  c.hline(x0, chartBot, x1 - x0, 2, Ink::Black);
  if (ser.size() >= 24) {
    double mx = *std::max_element(ser.begin(), ser.end());
    int n = 24, gap = 3;
    double bw = double(x1 - x0 - gap * (n - 1)) / n;
    int H = chartBot - chartTop;
    for (int j = 0; j < n; ++j) {
      int pct = mx > 0 ? std::max(2, int(jsRound(ser[j] / mx * 100))) : 2;
      int bh = H * pct / 100;
      // now ink; cheapest 3 h (prices) / past hours: Hatch; the rest: Track. B/W patterns, issue #38
      bool dark = series == "prices" ? (j >= ch && j < ch + 3) : j < h;
      int bx = x0 + int(j * (bw + gap));
      int bx2 = x0 + int(j * (bw + gap) + bw);
      Rect b = rc(bx, chartBot - bh, bx2 - bx, bh + 2), foot = rc(bx, chartBot - std::min(bh, 2), bx2 - bx, std::min(bh, 2));
      if (j == h) { c.box(b, 2, Ink::Black); c.fill(foot, Ink::Black); }
      else { Tone t = dark ? Tone::Hatch : Tone::Track; c.tone(b, 2, t); c.tone(foot, 0, t); }
      if (pr && a.now.known && j == h)   // 14 × 10 caret, 4 px above the bar
        for (int k = 0, cx = (bx + bx2) / 2; k < 10; ++k) { int hw = 7 - k * 6 / 9; c.hline(cx - hw, chartBot - bh - 14 + k, 2 * hw, 1, Ink::Black); }
    }
    hist::Extreme pLo, pHi;
    if (pr && hist::dayLowHigh(ser.data(), 24, a.lang, pLo, pHi)) {
      std::string l = a.t(S::histLow, fmtNum(pLo.v, "", 2), std::string(pLo.time)), g = a.t(S::histHigh, fmtNum(pHi.v, "", 2), std::string(pHi.time));
      TextOpts lt = C(Ink::Black); lt.tabular = true;
      int lbl = baseline(bottom - 21, B(18), 1.2);
      c.text(x0, lbl, l, B(18), lt);
      if (c.textWidth(l, B(18), lt) + 12 + c.textWidth(g, B(18), lt) <= x1 - x0) c.textRight(x1, lbl, g, B(18), lt);
    }
  } else {
    c.textCenter((x0 + x1) / 2, (chartTop + chartBot) / 2 + 8, "—", B(24), C(Ink::Black));
  }
  static const char* ticks[] = {"00", "06", "12", "18", "24"};
  int abl = baseline(axisTop, R(18), 1.2);
  for (int k = 0; k < 5; ++k) {
    int tw = c.textWidth(ticks[k], R(18));
    int tx = k == 0 ? x0 : k == 4 ? x1 - tw : x0 + (x1 - x0) * k / 4 - tw / 2;
    c.text(tx, abl, ticks[k], R(18), C(Ink::Black));
  }
}

// History tile (#270, emulator Device.tsx HistoryPlot, geometry core/history_chart): bars from zero or an auto-ranged
// line, gaps blank, the latest bucket with data solid ink (bar) or a dot (line), axis ticks, low / high with times.
// #304: area (line over a Track-dithered fill), step, dots, a dashed threshold line, min / max / last on the plot.
// Classic: 2 px line, square bars, uppercase name; Modern (on its card): 3 px line, rounded bars. 1-bit: Hatch /
// Track / Ink only. The redraw is the region signature: bar rects and line ends in pixels, so a value change below a pixel
// draws nothing.
static void historyTile(Canvas& c, I& a, const Widget& w, Rect r) {
  const bool sl = sleek();
  const hist::Spec sp = hist::specOf(w);
  const auto* slot = a.histOf(hist::seriesKey(sp));
  hist::Chart ch;
  hist::chart(sp, slot && slot->s.n ? &slot->s : nullptr, slot ? slot->state : hist::State::Loading, a.now.epochMs, a.now.tz,
              a.lang, ch);
  const EntityValue* raw = a.store.get(sp.entity);
  StatText st = statText(sp.entity, a.data, a.now.h, a.statEntity(sp.entity), a.lang);
  std::string lab = !w.field("label").empty() ? w.field("label") : st.label;
  std::string sum = st.gap != EntityGap::None ? gapText(a, st.gap) : st.value + (st.unit.empty() || st.value == "—" ? "" : " " + st.unit);
  // #292: an attribute / forecast series shows its value now (the bucket holding now) in its own unit, 1 decimal
  const std::string srcUnit = hist::sourceUnit(sp);
  const bool src = sp.kind != hist::Kind::Recorder;
  if (src && st.gap == EntityGap::None) {
    double nv = hist::kNone;
    if (ch.v) {
      const int64_t i = (hist::bucketStart(a.now.epochMs, sp.bucketMs, a.now.tz) - slot->s.start) / sp.bucketMs;
      if (i >= 0 && i < ch.n) nv = ch.v[i];
    }
    sum = !raw || !hist::has(nv) ? "—" : fmtNum(nv, srcUnit, 1) + (srcUnit.empty() ? "" : " " + srcUnit);
  }
  const int x0 = r.x + (sl ? 18 : 14), x1 = r.x + r.w - (sl ? 18 : 14), top = r.y + (sl ? 14 : 10), bot = r.y + r.h - (sl ? 10 : 8);
  // header: name left (ellipsis), live value right
  Font lf = sl ? T6(16) : B(kLabel), sf = sl ? D(22) : B(20);
  TextOpts vo; vo.tabular = true;
  const int sumW = c.textWidth(sum, sf, vo), hdrH = sl ? int(std::lround(sf.size * 1.2)) : kLabelH;
  const int hb = baseline(top, sf, double(hdrH) / sf.size);
  TextOpts lo; lo.upper = !sl; lo.maxW = std::max(0, x1 - x0 - sumW - 10);
  c.text(x0, hb, lab, lf, lo);
  c.textRight(x1, hb, sum, sf, vo);
  // footer: low / high, then the ticks above it
  Font tf = sl ? T4(15) : R(17), mf = sl ? T6(15) : B(17);
  const int lhH = int(std::lround(mf.size * 1.2)), tickH = 20;
  int y = bot;
  const int dp = src ? 1 : displayPrecision(raw);
  const std::string& u = src ? srcUnit : st.unit;
  if (ch.lowHigh) {
    y -= lhH;
    std::string low = a.t(S::histLow, fmtNum(ch.low.v, u, dp), ch.low.time), high = a.t(S::histHigh, fmtNum(ch.high.v, u, dp), ch.high.time);
    TextOpts mo; mo.tabular = true;
    const int bl = baseline(y, mf, 1.2), hw = c.textWidth(high, mf, mo);
    if (c.textWidth(low, mf, mo) + 12 + hw <= x1 - x0) c.text(x0, bl, low, mf, mo);   // too narrow: the high only
    c.textRight(x1, bl, high, mf, mo);
    y -= 4;
  }
  y -= tickH;
  const int W = x1 - x0, tbl = baseline(y, tf, double(tickH) / tf.size);
  TextOpts to; to.tabular = true;
  for (int k = 0; k < ch.nTicks; ++k) {
    const hist::Tick& t = ch.ticks[k];
    int tx = x0 + int(std::lround(t.x * W)), tw = c.textWidth(t.text, tf, to);
    c.text(t.x < 0.06 ? tx : t.x > 0.94 ? tx - tw : tx - tw / 2, tbl, t.text, tf, to);
  }
  // plot: between the header (+ 4 gap + 4 margin) and the ticks (4 gap)
  const int pTop = top + hdrH + 8, pBot = y - 4;
  if (pBot - pTop < 12) return;
  const bool hasState = ch.state != hist::State::Ok && ch.state != hist::State::Loading;
  const bool zeroLine = ch.style == hist::Style::Bars && !hasState && hist::has(ch.zero);
  const int aBot = zeroLine ? pBot : pBot - 2, H = aBot - pTop;   // the dotted baseline is 2 px under the area
  if (!zeroLine) c.dottedHLine(x0, pBot - 2, W, 2, Ink::Black);
  auto py = [&](double f) { return aBot - int(std::lround(f * H)); };
  auto px = [&](double f) { return x0 + int(std::lround(f * W)); };
  if (hasState) {
    Font xf = sl ? T7(18) : B(18);
    c.textCenter((x0 + x1) / 2, (pTop + aBot) / 2 + Canvas::capHeight(xf) / 2, hist::stateText(ch.state, a.lang), xf, C(Ink::Black));
    return;
  }
  if (ch.style == hist::Style::Bars) {
    const int n = ch.n, gap = n > 48 ? 1 : n > 24 ? 2 : 4;
    const double bw = double(W - gap * (n - 1)) / n;
    for (int i = 0; i < n; ++i) {
      if (ch.gap(i)) continue;
      int bx = x0 + int(std::lround(i * (bw + gap))), bx2 = x0 + int(std::lround(i * (bw + gap) + bw));
      int yb = py(ch.barB(i)), yt = std::min(py(ch.barT(i)), yb - 3);   // at least 3 px, as the emulator's max(3px, …)
      Rect b = rc(bx, yt, std::max(1, bx2 - bx), yb - yt);
      int rad = sl ? std::min(4, b.w / 2) : 0;
      if (i == ch.latest) c.box(b, rad, Ink::Black);
      else c.tone(b, rad, Tone::Hatch);
    }
    if (zeroLine) c.hline(x0, py(ch.zero) - 1, W, 2, Ink::Black);
  }
  auto vy = [&](int i) { return py(ch.y(ch.v[i])); };
  if (ch.style == hist::Style::Area)   // under each run of 2+ points, down to the plot bottom
    for (int i = 0; i + 1 < ch.n; ++i)
      if (!ch.gap(i) && !ch.gap(i + 1)) c.toneUnder(px(ch.x(i)), vy(i), px(ch.x(i + 1)), vy(i + 1), aBot, Tone::Track);
  if (hist::has(ch.threshold)) c.dashedHLine(x0, py(ch.threshold) - 1, W, 2, 6, 4, Ink::Black);
  const int th = sl ? 3 : 2;
  if (ch.style == hist::Style::Line || ch.style == hist::Style::Area) {
    int xPrev = 0, yPrev = 0;
    bool open = false;
    for (int i = 0; i < ch.n; ++i) {
      if (ch.gap(i)) { open = false; continue; }
      int x = px(ch.x(i)), yy = vy(i);
      bool lone = !open && (i + 1 >= ch.n || ch.gap(i + 1));
      if (open || lone) c.line(open ? xPrev : x, open ? yPrev : yy, x, yy, th, Ink::Black);
      xPrev = x; yPrev = yy; open = true;
    }
  } else if (ch.style == hist::Style::Step) {   // a flat run per bucket, joined upright to the next one
    for (int i = 0; i < ch.n; ++i) {
      if (ch.gap(i)) continue;
      const int xr = px(ch.edge(i + 1)), yy = vy(i);
      c.line(px(ch.edge(i)), yy, xr, yy, th, Ink::Black);
      if (i + 1 < ch.n && !ch.gap(i + 1)) c.line(xr, yy, xr, vy(i + 1), th, Ink::Black);
    }
  } else if (ch.style == hist::Style::Dots) {
    const int d = hist::dotPx(ch.n);
    for (int i = 0; i < ch.n; ++i) if (!ch.gap(i) && i != ch.latest) c.circle(px(ch.x(i)), vy(i), d / 2, Ink::Black);
  }
  if (ch.style != hist::Style::Bars && ch.latest >= 0) c.circle(px(ch.x(ch.latest)), vy(ch.latest), 8, Ink::Black, 2, Ink::Paper);
  // values on the plot: beside the point, on the tile's ground, kept inside the plot
  TextOpts no; no.tabular = true;
  const int cap = Canvas::capHeight(mf);
  for (int k = 0; k < ch.nLabels; ++k) {
    const hist::Label& l = ch.labels[k];
    const std::string t = fmtNum(ch.v[l.i], u, dp);
    const int tw = c.textWidth(t, mf, no), xp = px(ch.x(l.i));
    const int tx = std::max(x0 + 3, std::min(x1 - 3 - tw, l.right ? xp + 12 : xp - 12 - tw));
    const int bl = std::max(pTop + cap + 3, std::min(aBot - 3, vy(l.i) + cap / 2));
    const Rect bg = rc(tx - 3, bl - cap - 3, tw + 6, cap + 6);   // the line knocked out behind the text: card surface on Modern
    if (sl) c.tone(bg, 0, Tone::Surf);
    else c.fill(bg, Ink::Paper);
    c.text(tx, bl, t, mf, no);
  }
}

static void badge(Canvas& c, int right, int top, int lvl, bool car) {
  const SevDef& S = sevDef(lvl);
  bool red = lvl == 4;
  std::string word = car ? S.car : S.word;
  int ww = c.textWidth(word, B(15));
  int w = 8 + 4 * 5 + 3 * 2 + 7 + ww + 10;
  Rect b = rc(right - w, top, w, 30);
  c.box(b, 15, red ? Ink::Black : Ink::Paper, 2, Ink::Black);
  Ink fg = red ? Ink::Paper : Ink::Black;
  int x = b.x + 8, base = b.y + 21;
  for (int k = 0; k < 4; ++k) {
    int h = 6 + k * 2;
    Rect sg = rc(x + k * 7, base - h, 5, h);
    Ink fill = k < lvl ? (red ? Ink::Paper : Ink::Black) : (red ? Ink::Black : Ink::Paper);
    c.fill(sg, fill);
    c.frame(sg, 1, fg);
  }
  c.text(x + 4 * 7 + 5, mid(b.y, b.h, B(15)), word, B(15), C(fg));
}

static void routeTile(Canvas& c, I& a, const Widget& w, Rect r) {
  // A user route (#145): label + mode + entity; the data is the entity's (spec/SCHEMA.md "Route sensors").
  std::string mode = w.field("mode"), id = w.field("entity");
  bool isCar = mode == "car";
  int x0 = r.x + 14, x1 = r.x + r.w - 14, top = r.y + 10, bottom = r.y + r.h - 9;
  const EntityValue* raw = id.empty() ? nullptr : a.store.get(id);
  EntityGap gap = entityGap(raw);
  RouteState st = entityAvailable(raw) ? routeState(raw, isCar, a.lang) : RouteState();
  const RouteState* rs = st.has ? &st : nullptr;
  int lvl = 1;
  std::vector<DepartureState> deps;
  if (rs && !isCar) {
    for (auto& d : rs->deps) if (!a.now.known || d.minuteOfDay + (d.minuteOfDay < a.now.minuteOfDay - 720 ? 1440 : 0) > a.now.minuteOfDay) deps.push_back(d);
    if (deps.size() > 3) deps.resize(3);
    std::vector<DepartureSev> ds;
    for (auto& d : deps) ds.push_back({d.delay, d.cancelled});
    lvl = routeLevel(ds);
  }
  bool carOk = rs && isCar && rs->eta.ok;
  bool carLvl = carOk && rs->typical.ok && rs->typical.v > 0;
  if (carLvl) lvl = carLevel(rs->eta.v, rs->typical.v);
  bool hasData = rs && (isCar ? carOk : !deps.empty());
  bool hasBadge = hasData && (!isCar || carLvl);
  // header (34 px)
  c.icon(isCar ? Icon::Car : mode == "bus" ? Icon::Bus : Icon::Train, x0, top + 6);
  int badgeW = 0;
  if (hasBadge) {
    const SevDef& S = sevDef(lvl);
    badgeW = 8 + 26 + 7 + c.textWidth(isCar ? S.car : S.word, B(15)) + 10;
    badge(c, x1, top + 2, lvl, isCar);
  }
  TextOpts t; t.maxW = x1 - x0 - 30 - badgeW - 8;
  std::string title = !w.field("label").empty() ? w.field("label") : raw ? friendlyName(id, raw) : id.empty() ? a.t(S::palRoute) : id;
  c.text(x0 + 30, mid(top, 34, B(18)), title, B(18), t);
  // footer note
  static const S kTransitNote[4] = {S::routeNote1, S::routeNote2, S::routeNote3, S::routeNote4};
  static const S kCarNote[4] = {S::carNote1, S::carNote2, S::carNote3, S::carNote4};
  std::string note = id.empty() ? a.t(S::routePick)
                     : gap != EntityGap::None ? gapText(a, gap)
                     : rs && !rs->note.empty() ? rs->note
                     : hasBadge ? a.t(isCar ? kCarNote[lvl - 1] : kTransitNote[lvl - 1])
                     : hasData ? std::string() : a.t(S::noDataYet);
  if (mode == "bus" && hasData && rs->perHour > 0 && rs->note.empty()) note += " · " + a.t(S::perHour, std::to_string(rs->perHour));
  int footTop = bottom - 5 - 18;
  rule(c, x0, footTop - 2, x1 - x0, false);
  TextOpts nt; nt.maxW = x1 - x0;
  c.text(x0, baseline(footTop + 5 - 2, lvl >= 3 ? B(15) : R(15), 1.2), note, lvl >= 3 ? B(15) : R(15), nt);
  int bodyTop = top + 34 + 4, bodyBot = footTop - 2 - 4;
  if (gap != EntityGap::None) {   // #86: HA has the sensor but no value
    c.dottedHLine(x0, bodyTop, x1 - x0, 1, Ink::Black);
    gapRing(c, x0, (bodyTop + bodyBot) / 2 + 14);
    return;
  }
  if (isCar) {
    c.dottedHLine(x0, bodyTop, x1 - x0, 1, Ink::Black);
    if (!carOk) { c.text(x0, (bodyTop + bodyBot) / 2 + 16, "—", B(44), C(Ink::Black)); return; }
    int eta = int(jsRound(rs->eta.v)), typ = int(jsRound(rs->typical.v)), extra = eta - typ;
    int bl = bodyTop + (bodyBot - bodyTop) / 2 + 10;
    TextOpts vt; vt.tracking = -1; vt.tabular = true;
    int x = x0 + c.text(x0, bl, std::to_string(eta), B(52), vt) + 6;
    x += c.text(x, bl, "min", B(20));
    std::string arrive = a.now.known ? hhmm(a.now.minuteOfDay + eta) : std::string("—");
    TextOpts ar = C(Ink::Black);
    if (w.cs >= 3) {   // #303: the arrival time as a second big value, caption beside it
      c.dottedVLine(x + 14, bl - 44, 52, 1, Ink::Black);
      x += 14 + 1 + 20;
      x += c.text(x, bl, arrive, B(52), vt) + 10;
      ar.maxW = x1 - x;
      c.text(x, bl, a.t(S::arriveCaption), R(17), ar);
    } else {
      x += 10; ar.maxW = x1 - x;
      c.text(x, bl, a.t(S::arriveIfLeave, arrive), R(17), ar);
    }
    if (carLvl) c.text(x0, bl + 26, a.t(S::usually, std::to_string(typ) + " min") + (extra > 0 ? " · " + a.t(S::traffic, std::to_string(extra)) : ""), R(16), C(Ink::Black));
    return;
  }
  int n = 3, rh = (bodyBot - bodyTop) / n;
  for (int j = 0; j < n; ++j) {
    int ry = bodyTop + j * rh;
    c.dottedHLine(x0, ry, x1 - x0, 1, Ink::Black);
    if (j >= int(deps.size())) { if (j == 0) c.text(x0, mid(ry, rh, B(21)), "—", B(21), C(Ink::Black)); continue; }
    auto& d = deps[j];
    TextOpts tt; tt.tabular = true; tt.strike = d.cancelled;
    int bl = mid(ry, rh, B(21));
    c.text(x0, bl, hhmm(d.minuteOfDay), B(21), tt);
    int dl = d.cancelled ? 0 : int(jsRound(d.delay));
    if (dl > 0) { TextOpts dt; dt.tabular = true; c.text(x0 + 70, bl, "+" + std::to_string(dl), B(18), dt); }
    TextOpts it2; it2.maxW = x1 - (x0 + 120);
    c.text(x0 + 120, bl, d.cancelled ? a.t(S::cancelled) : d.info, d.cancelled ? B(16) : R(16), it2);
  }
}

static void thermoTile(Canvas& c, I& a, const Widget& w, Rect r) {
  std::string id = w.field("zone");
  const ZoneState* z = a.data.zone(id);
  bool tall = w.rs > 1;
  int x0 = r.x + 14, x1 = r.x + r.w - 14, top = r.y + 12, bottom = r.y + r.h - 12;
  std::string name = !w.field("label").empty() ? w.field("label") : z ? z->name : id.empty() ? std::string(a.t(S::room)) : id;
  bool heat = z && z->heating();
  int nameW = x1 - x0 - (heat ? 24 : 0);   // #162: keep the last word ("Slaapk… voor") and clear the flame
  c.text(x0, baseline(top, B(20), 1.2), fitKeepTail(name, nameW, [&c](const std::string& t) { return c.textWidth(t, B(20)); }), B(20));
  if (heat) c.icon(Icon::Flame18, x1 - 18, top + 3);
  int big = tall ? 76 : 40;
  {   // shrink the big value until value + ° fit the tile (emulator clips instead)
    TextOpts m; m.tracking = -2; m.tabular = true;
    std::string v = z && z->cur.ok ? fmtNum(z->cur.v, "°C") : "—";
    static const int steps[] = {76, 52, 50, 46, 44, 40, 36};
    for (int sz : steps) { if (sz > big) continue; big = sz; if (c.textWidth(v, B(sz), m) + 16 <= x1 - x0) break; }
  }
  int ctrlTop = bottom - 48 - 10;
  c.hline(x0, ctrlTop, x1 - x0, 2, Ink::Black);
  int vtop = top + 22 + (tall ? 20 : 6);
  TextOpts vt; vt.tracking = -2; vt.tabular = true;
  int vw = c.text(x0, baseline(vtop, B(big), 1.0), z && z->cur.ok ? fmtNum(z->cur.v, "°C") : "—", B(big), vt);
  c.text(x0 + vw + 2, baseline(vtop, B(22), 1.0) + 4, "°", B(22));
  if (tall && z) {
    std::string sub = z->heating() ? a.t(S::heatingTo, fmtNum(z->set.v, "°C") + "°") : a.t(S::atSetTemp);
    TextOpts so = C(Ink::Black); so.maxW = x1 - x0;
    c.text(x0, ctrlTop - 14, sub, R(18), so);
  }
  int cy = ctrlTop + 10 + 24;
  roundButton(c, x0 + 24, cy, 48, "−", 26, [&a, id] { a.setZone(id, -0.5); });
  roundButton(c, x1 - 24, cy, 48, "+", 26, [&a, id] { a.setZone(id, 0.5); });
  TextOpts s; s.tracking = 1;
  c.textCenter((x0 + x1) / 2, cy - 8, utf8Upper(a.t(S::setTemp)), B(16), s);
  TextOpts sv; sv.tabular = true; sv.dotted = a.setOverride.count(id) > 0;
  int setSize = x1 - x0 - 96 >= 70 ? 24 : 21;
  c.textCenter((x0 + x1) / 2, cy + 16, z && z->set.ok ? fmtNum(z->set.v, "°C") + "°" : "—", B(setSize), sv);
}

static void lightSwitch(Canvas& c, int x, int y, int w, int h, bool on) {
  c.box(rc(x, y, w, h), h / 2, on ? Ink::Black : Ink::Paper, 2, Ink::Black);
  int k = h - 8;
  int kx = on ? x + w - 4 - k / 2 : x + 4 + k / 2;
  c.circle(kx, y + h / 2, k / 2, Ink::Paper, 2, Ink::Black);
}

static std::string lightValue(I& a, const LightState* l) {
  return !l ? "—" : l->on ? (l->dim ? std::to_string(l->pct) + "%" : a.t(S::on)) : a.t(S::off);
}

static void lightTile(Canvas& c, I& a, const std::string& id, Rect r) {
  const LightState* l = a.data.light(id);
  int x0 = r.x + 14, x1 = r.x + r.w - 14;
  std::string lab = l ? (a.data.areaNames.count(l->area) ? a.data.areaNames.at(l->area) : l->area) + " · " + l->name : id;
  if (c.textWidth(lab, B(18)) <= x1 - x0 - 56 || !l) {
    TextOpts t; t.maxW = x1 - x0 - 56;
    c.text(x0, baseline(r.y + 12, B(18), 1.2), lab, B(18), t);
  } else {   // narrow tile: room on line 1, light on line 2 (emulator wraps "Room · Light")
    TextOpts t; t.maxW = x1 - x0 - 56;
    c.text(x0, baseline(r.y + 12, B(18), 1.2), lab.substr(0, lab.find(" · ")), B(18), t);
    t.maxW = x1 - x0;
    c.text(x0, baseline(r.y + 12 + 22, B(18), 1.2), l->name, B(18), t);
  }
  if (l) lightSwitch(c, x1 - 48, r.y + 12, 48, 26, l->on);
  std::string v = lightValue(a, l);
  int btnTop = r.y + r.h - 2 - 46;
  c.text(x0, btnTop - 14, v, B(34));
  if (l) {
    std::string lid = l->id;
    c.hit(rc(r.x, r.y, r.w, btnTop - r.y), [&a, lid] { a.toggleLight(lid); });
  }
  c.hline(r.x, btnTop - 2, r.w, 2, Ink::Black);
  c.vline(r.x + r.w / 2 - 1, btnTop, 46, 2, Ink::Black);
  std::string lid = l ? l->id : id;
  int cy = btnTop + 23;
  c.fill(rc(r.x + r.w / 4 - 6, cy - 1, 12, 3), Ink::Black);
  c.fill(rc(r.x + 3 * r.w / 4 - 6, cy - 1, 12, 3), Ink::Black);
  c.fill(rc(r.x + 3 * r.w / 4 - 1, cy - 6, 3, 12), Ink::Black);
  c.hit(rc(r.x, btnTop, r.w / 2, 46), [&a, lid] { a.dimLight(lid, -10); });
  c.hit(rc(r.x + r.w / 2, btnTop, r.w / 2, 46), [&a, lid] { a.dimLight(lid, 10); });
}

// switch widget: light.<id> known to the light list → light tile (with dimming); anything else → on/off toggle
static void switchTile(Canvas& c, I& a, const Widget& w, Rect r) {
  std::string id = w.field("entity");
  if (domainOf(id) == "light" && a.data.light(id.substr(6))) { lightTile(c, a, id.substr(6), r); return; }
  int x0 = r.x + 14, x1 = r.x + r.w - 14;
  std::string lab = w.field("label").empty() ? friendlyName(id, a.store.get(id)) : w.field("label");
  TextOpts t; t.maxW = x1 - x0 - 56;
  c.text(x0, baseline(r.y + 12, B(18), 1.2), lab, B(18), t);
  bool known = false;
  bool on = a.entityOn(id, known);
  if (known) lightSwitch(c, x1 - 48, r.y + 12, 48, 26, on);
  EntityGap gap = known ? EntityGap::None : entityGap(a.store.get(id));
  if (gap != EntityGap::None) {   // ring + the word on the value line (emulator: flex, centred)
    int bl = r.y + r.h - 16, cy = bl - 14;
    gapRing(c, x0, bl);
    TextOpts go = C(Ink::Black); go.maxW = x1 - x0 - 36;
    c.text(x0 + 36, cy + Canvas::capHeight(R(16)) / 2, gapText(a, gap), R(16), go);
  } else {
    c.text(x0, r.y + r.h - 16, !known ? "—" : on ? a.t(S::on) : a.t(S::off), B(34));
  }
  if (known) c.hit(r, [&a, id] { a.toggleEntity(id); });
}

std::string sceneLabel(I& a, const Widget& w, const SceneAction& s) {
  if (!w.field("label").empty()) return w.field("label");
  return s.entityId == "all" ? std::string(a.t(S::allLightsOff)) : friendlyName(s.entityId, a.store.get(s.entityId));
}

std::string sceneSub(I& a, const SceneAction& s) {
  if (s.entityId != "all") return a.t(S::tapToRun);
  return a.t(S::lightsOnOf, std::to_string(a.data.lightsOn()), std::to_string(a.data.lights.size()));
}

// scene tile (#146): a scene / script entity runs it; none = all lights off (with the lights-on count)
static void sceneTile(Canvas& c, I& a, const Widget& w, Rect r) {
  SceneAction act = sceneAction(w);
  Col3 k = col3(r, 30);
  label(c, r.x + 14, k.labelTop, a.t(act.domain == "script" ? S::script : S::scene), kLabel);
  TextOpts t; t.maxW = r.w - 28;
  c.text(r.x + 14, k.valueBl, sceneLabel(a, w, act), B(30), t);
  subLine(c, r.x + 14, k.subTop, sceneSub(a, act), r.w - 28);
  c.hit(r, [&a, act] { a.runScene(act); });
}

std::string settingValue(const I& a, const std::string& key) {
  const DisplaySettings& s = a.set;
  if (key == "brightness") return s.brightness == 0 ? std::string(a.t(S::off)) : std::to_string(s.brightness) + "%";
  if (key == "warmth") return std::to_string(s.warmth) + "%";
  if (key == "lightTimeout")   // #220
    return s.lightTimeout == 0 ? std::string(a.t(S::never)) : s.lightTimeout < 60 ? a.t(S::afterSec, std::to_string(s.lightTimeout))
                                                                                   : a.t(S::afterMin, std::to_string(s.lightTimeout / 60));
  if (key == "quiet") {   // #295
    if (s.quiet == "off") return a.t(S::off);
    auto d = s.quiet.find('-');
    return pad2(std::atoi(s.quiet.substr(0, d).c_str())) + "–" + pad2(std::atoi(s.quiet.substr(d + 1).c_str()));
  }
  if (key == "returnHome" || key == "standby") {
    int m = idleMinutes(key == "standby" ? s.standby : s.returnHome);
    return m == 0 ? std::string(a.t(S::never)) : a.t(S::afterMin, std::to_string(m));
  }
  if (key == "clock") return a.t(s.clock == "12" ? S::hour12 : S::hour24);
  if (key == "interval") return a.t(S::everySec, std::to_string(s.intervalSec));
  if (key == "cleanEvery" || key == "fullEvery")   // #26
    return s.cleanEvery == 60 ? std::string(a.t(S::hourly)) : s.cleanEvery == 120 ? std::string(a.t(S::every2h)) : a.t(S::everyMin, std::to_string(s.cleanEvery));
  if (key == "style") return a.t(s.style == "sleek" ? S::styleSleek : S::styleClassic);
  if (key == "typeface") return s.typeface == "bricolage" ? "Bricolage" : s.typeface == "fraunces" ? "Fraunces" : s.typeface == "geist" ? "Geist" : "Archivo";
  if (key == "surface") return a.t(s.surface == "dots" ? S::surfDots : S::surfDither);
  if (key == "powerSave")
    return a.t(s.powerSave == "off" ? S::psOff : s.powerSave == "standby" ? S::psStandby : S::psGlance);
  if (key == "wakeEvery") return std::to_string(s.wakeEvery) + " min";
  if (key == "liveMin") return std::to_string(s.liveMin) + " min";
  return "?";
}

static void settingTile(Canvas& c, I& a, const Widget& w, Rect r) {
  std::string key = w.field("key");
  const SettingDef* d = findSetting(key);
  int top = r.y + 12, bottom = r.y + r.h - 12;
  std::string lab = d ? a.t(d->label) : key;
  int ll = labelLines(c, lab, r.w - 28);   // "TERUG NAAR START", "SCHERM VERVERSEN" wrap (#199)
  tileLabel(c, r.x + 14, top, lab, r.w - 28, ll);
  top += (ll - 1) * kLabelH;
  // title + value only (#310), spaced like the emulator's column
  int g = ((bottom - top) - kLabelH - 31 - 46) / 2;
  TextOpts t; t.tabular = true; t.maxW = r.w - 28;
  c.text(r.x + 14, baseline(top + kLabelH + g, B(26), 1.2), settingValue(a, key), B(26), t);
  int bw = (r.w - 28 - 8) / 2;
  Rect m = rc(r.x + 14, bottom - 46, bw, 46), p = rc(r.x + 14 + bw + 8, bottom - 46, bw, 46);
  c.box(m, 8, Ink::Paper, 2, Ink::Black);
  c.box(p, 8, Ink::Paper, 2, Ink::Black);
  int cy = m.y + 23;
  c.fill(rc(m.x + bw / 2 - 7, cy - 1, 14, 3), Ink::Black);
  c.fill(rc(p.x + bw / 2 - 7, cy - 1, 14, 3), Ink::Black);
  c.fill(rc(p.x + bw / 2 - 1, cy - 7, 3, 14), Ink::Black);
  c.hit(m, [&a, key] { a.setCfg(key, -1); });
  c.hit(p, [&a, key] { a.setCfg(key, 1); });
}

void tile(Canvas& c, I& a, const Widget& w, int, Rect r) {
  if (sleek() && sleekTile(c, a, w, r, w.type == "setting" ? settingValue(a, w.field("key")) : std::string())) return;
  tileFrame(c, r);
  if (w.type == "stat") statTile(c, a, w, r);
  else if (w.type == "clock") clockTile(c, a, r);
  else if (w.type == "price") priceTile(c, a, w, r);
  else if (w.type == "gauge") gaugeTile(c, a, w, r);
  else if (w.type == "bars") barsTile(c, a, w, r);
  else if (w.type == "history") historyTile(c, a, w, r);
  else if (w.type == "route") routeTile(c, a, w, r);
  else if (w.type == "thermo") thermoTile(c, a, w, r);
  else if (w.type == "switch") switchTile(c, a, w, r);
  else if (w.type == "scene") sceneTile(c, a, w, r);
  else if (w.type == "setting") settingTile(c, a, w, r);
  else {
    Col3 k = col3(r, 50);
    label(c, r.x + 14, k.labelTop, w.type, kLabel);
    c.text(r.x + 14, k.valueBl, "?", B(50));
    subLine(c, r.x + 14, k.subTop, a.t(S::unknownWidget), r.w - 28);
  }
}

// Console Values view (#122, emulator tileValues): the tile's big value as drawn, on one line; "" = no single value.
std::string tileValue(I& a, const Widget& w) {
  std::string id = w.field("entity");
  if (w.type == "clock") return a.now.clock;
  if (w.type == "zoneList") {   // #161: "3 of 9 heating" / "4 of 9 lights on", like the tile's header
    std::vector<ZoneState> zs = pickZones(a.data.zones, w);
    int heating = 0;
    for (auto& z : zs) heating += z.heating();
    return zs.empty() ? std::string("—") : a.t(S::nOfHeating, std::to_string(heating), std::to_string(zs.size()));
  }
  if (w.type == "lightList") {
    int shown = 0, lit = 0;
    for (auto& g : pickLights(a.data.lightGroups, w)) for (auto& id : g.ids) if (const LightState* l = a.data.light(id)) { ++shown; lit += l->on; }
    return shown ? a.t(S::lightsOnOf, std::to_string(lit), std::to_string(shown)) : std::string("—");
  }
  if (w.type != "stat" && w.type != "price" && w.type != "gauge" && w.type != "thermo" && w.type != "switch") return "";
  // an HA entity with no value: the word, not "—" (#86); logical ids and the light list have their own sources
  bool light = domainOf(id) == "light" && a.data.light(id.substr(6));
  const EntityValue* raw = !id.empty() && !findEntity(id) && id != kGaugeDefaultEntity && !light ? a.store.get(id) : nullptr;
  if (raw && (raw->state == "unavailable" || raw->state == "unknown")) return a.t(raw->state == "unavailable" ? S::gapUnavailable : S::gapUnknown);
  if (w.type == "stat") {
    StatText s = statText(id, a.data, a.now.h, a.statEntity(id), a.lang);
    return s.value == "—" || s.unit.empty() ? s.value : s.value + " " + s.unit;
  }
  if (w.type == "price") {
    const auto& P = a.data.prices;
    return P.size() < 24 || !a.now.known ? std::string("—") : locale::currency() + " " + fmtNum(a.data.priceAt(a.now.h, a.now.m), "", 2);
  }
  if (w.type == "gauge") {
    int pct = 0;
    bool ok = !id.empty() && id != kGaugeDefaultEntity ? entityPct(a.store.get(id), pct) : a.data.soc.ok;
    if (ok && (id.empty() || id == kGaugeDefaultEntity)) pct = int(jsRound(a.data.soc.v));
    return ok ? std::to_string(pct) + "%" : "—";
  }
  if (w.type == "thermo") {
    const ZoneState* z = a.data.zone(w.field("zone"));
    return z && z->cur.ok ? fmtNum(z->cur.v, "°C") + "°" : "—";
  }
  if (light) return lightValue(a, a.data.light(id.substr(6)));
  bool known = false;
  bool on = a.entityOn(id, known);
  return !known ? "—" : on ? a.t(S::on) : a.t(S::off);
}

void ghost(Canvas& c, const Widget& w, Rect r, Lang l) {
  tileFrame(c, r, true);
  tileLabel(c, r.x + 14, r.y + 12, ghostLabel(w, l), r.w - 28, 1);
  int free = r.h - 24 - kLabelH - 44 - 16;
  c.text(r.x + 14, baseline(r.y + 12 + kLabelH + free / 2, B(44), 1.0), "—", B(44), C(Ink::Black));
}

void linkCard(Canvas& c, I& a, Rect r) {
  tileFrame(c, r);
  int x0 = r.x + 18, x1 = r.x + r.w - 18, y = r.y + 16;
  c.text(x0, baseline(y, B(24), 1.15), a.t(S::linkHa), B(24));
  y += 28 + 10;
  y += 20 * c.paragraph(x0, y, x1 - x0, 20, a.t(S::linkHaWhy), R(15), C(Ink::Black)) + 10;
  auto& st = a.svc.status();
  std::string code = st.pairingCode.empty() ? "····" : st.pairingCode;
  std::string url = qrBase(a) + "/link?p=" + st.pairingCode;
  c.box(rc(x0, y, 128, 128), 8, Ink::Paper, 0);
  c.qr(x0, y, 128, url);
  c.text(x0 + 142, y + 40, a.t(S::pairingCode), R(13), C(Ink::Black));
  TextOpts pc; pc.tracking = 5;
  c.text(x0 + 142, y + 40 + 32, code, B(28), pc);
  c.text(x0 + 142, y + 40 + 32 + 22, a.t(S::scanWithPhone), R(13), C(Ink::Black));
  y += 128 + 10;
  static const S T[] = {S::lnkScan, S::lnkFind, S::lnkSignIn, S::lnkKey};
  int stage = st.ha == HaState::Linking ? 2 : 0;
  int btnTop = r.y + r.h - 16 - 44;
  int rowH = (btnTop - 10 - y) / 4;
  for (int k = 0; k < 4; ++k) {
    int ry = y + k * rowH;
    c.dottedHLine(x0, ry, x1 - x0, 1, Ink::Black);
    bool done = stage > k, cur = stage == k && st.ha == HaState::Linking;
    int cx = x0 + 11, cy = ry + rowH / 2;
    c.circle(cx, cy, 11, done ? Ink::Black : Ink::Paper, cur ? 3 : 2, Ink::Black);
    if (done) c.icon(Icon::Tick14, cx - 7, cy - 7, Ink::Paper);
    else c.textCenter(cx, cy + 4, std::to_string(k + 1), B(12));
    c.text(x0 + 32, mid(ry, rowH, B(15)), a.t(T[k]), done || cur ? B(15) : R(15));
  }
  button(c, rc(x0, btnTop, x1 - x0, 44), a.t(S::showBigCode), B(15), true, [&a] { a.linkFromCard(); });
}

// ---------------- lists (regions: frame + header + one per row) ----------------
// #199: room names B20, or B18 for the whole page when one does not fit (then the ellipsis); NOW B20 vs SET B22
// (weight and size, not gray, tell them apart; #38)
static const int kZoneSetW = 154, kZoneNowW = 52;
static int zoneNameMax(const ZoneState& z, int colW) { return colW - kZoneSetW - 8 - kZoneNowW - 8 - (z.heating() ? 22 : 0); }
static void zoneRow(Canvas& c, I& a, const ZoneState& z, Rect r, Font nf) {
  c.dottedHLine(r.x, r.y, r.w, 1, Ink::Black);
  int sx = r.x + r.w - kZoneSetW, nx = sx - 8 - kZoneNowW;
  int cy = r.y + r.h / 2;
  int maxW = zoneNameMax(z, r.w);
  int bl = cy + Canvas::capHeight(nf) / 2;
  TextOpts nt; nt.maxW = maxW;
  int w = c.text(r.x, bl, fitKeepTail(z.name, maxW, [&c, nf](const std::string& s) { return c.textWidth(s, nf); }), nf, nt);
  if (z.heating()) c.icon(Icon::Flame16, r.x + w + 6, cy - 8);
  TextOpts ct = C(Ink::Black); ct.tabular = true;
  c.textRight(nx + kZoneNowW, cy + Canvas::capHeight(B(20)) / 2, z.cur.ok ? fmtNum(z.cur.v, "°C") + "°" : "—", B(20), ct);
  std::string id = z.id;
  roundButton(c, sx + 23, cy, 46, "−", 24, [&a, id] { a.setZone(id, -0.5); });
  roundButton(c, sx + kZoneSetW - 23, cy, 46, "+", 24, [&a, id] { a.setZone(id, 0.5); });
  TextOpts sv; sv.tabular = true; sv.dotted = a.setOverride.count(z.id) > 0;
  c.textCenter(sx + kZoneSetW / 2, cy + Canvas::capHeight(B(22)) / 2, z.set.ok ? fmtNum(z.set.v, "°C") + "°" : "—", B(22), sv);
}

static void lightHeaderRow(Canvas& c, I& a, const LightCell& it, const std::vector<std::string>& ids, Rect r, bool firstInCol) {
  if (!firstInCol) c.hline(r.x, r.y, r.w, 2, Ink::Black);
  int on = 0, n = 0;
  for (auto& id : ids) if (const LightState* l = a.data.light(id)) { ++n; on += l->on; }
  std::string room = (a.data.areaNames.count(it.area) ? a.data.areaNames.at(it.area) : it.area) + (it.cont ? " (cont.)" : "");
  std::string tl = a.t(on ? S::allOff : S::allOn);
  int bw = c.textWidth(tl, B(18)) + 24 + 4;
  int cy = r.y + r.h / 2;
  int bl = cy + Canvas::capHeight(B(18)) / 2;
  TextOpts up; up.upper = true; up.maxW = r.w - bw - 100;   // #199: room B18, count R18 (were 15)
  int w = c.text(r.x, bl, room, B(18), up);
  TextOpts cnt = C(Ink::Black); cnt.maxW = r.w - bw - w - 16;
  c.text(r.x + w + 8, bl, a.t(S::onOf, std::to_string(on), std::to_string(n)), R(18), cnt);
  std::string area = it.area;
  button(c, rc(r.x + r.w - bw, cy - 22, bw, 44), tl, B(18), false, [&a, area, ids] { a.roomLights(area, ids); });
}

// #199: name B20, or B18 for the whole page when one does not fit (then the ellipsis); value B20; "on / off only" R18
// on up to two lines (were B18 / R17 / R13). The name gets what the value leaves (emulator: a 52 px value column).
static std::string lightRowValue(I& a, const LightState& l) { return l.on ? (l.dim ? std::to_string(l.pct) + "%" : a.t(S::on)) : a.t(S::off); }
static int lightNameMax(Canvas& c, I& a, const LightState& l, int w) {
  return w - 96 - 8 - c.textWidth(lightRowValue(a, l), B(20)) - 8 - (4 + 44 + 10);
}
static void lightRow(Canvas& c, I& a, const LightState& l, Rect r, bool firstInCol, Font nf) {
  if (!firstInCol) c.dottedHLine(r.x, r.y, r.w, 1, Ink::Black);
  int cy = r.y + r.h / 2;
  int right = r.x + r.w;
  int ctrlW = 96;
  int valX = right - ctrlW - 8;
  lightSwitch(c, r.x + 4, cy - 12, 44, 24, l.on);
  int nx = r.x + 4 + 44 + 10, maxW = lightNameMax(c, a, l, r.w);
  TextOpts nt; nt.maxW = maxW;
  c.text(nx, cy + Canvas::capHeight(nf) / 2, l.name, nf, nt);
  std::string id = l.id;
  c.hit(rc(r.x, cy - 24, nx + maxW - r.x, 48), [&a, id] { a.toggleLight(id); });
  c.textRight(valX, cy + Canvas::capHeight(B(20)) / 2, lightRowValue(a, l), B(20));
  if (l.dim) {
    roundButton(c, right - ctrlW + 22, cy, 44, "−", 22, [&a, id] { a.dimLight(id, -10); });
    roundButton(c, right - 22, cy, 44, "+", 22, [&a, id] { a.dimLight(id, 10); });
  } else {
    // one line, else the balanced split into two centred lines ("alleen" / "aan / uit")
    std::string t = a.t(S::onOffOnly);
    std::vector<std::string> lines{t};
    if (c.textWidth(t, R(18)) > ctrlW) {
      int best = 1 << 30;
      for (size_t p = t.find(' '); p != std::string::npos; p = t.find(' ', p + 1)) {
        int w = std::max(c.textWidth(t.substr(0, p), R(18)), c.textWidth(t.substr(p + 1), R(18)));
        if (w < best) { best = w; lines = {t.substr(0, p), t.substr(p + 1)}; }
      }
    }
    TextOpts ot = C(Ink::Black); ot.maxW = ctrlW;
    int bl = cy - int(lines.size()) * 11 + 11 + Canvas::capHeight(R(18)) / 2;
    for (auto& ln : lines) { c.textCenter(right - ctrlW / 2, bl, ln, R(18), ot); bl += 22; }
  }
}

void listRegions(I& a, const Widget& w, int i, Rect r, std::vector<RegionDef>& out) {
  if (sleek()) { sleekListRegions(a, w, i, r, out); return; }
  std::string ti = std::to_string(i);
  bool zones = w.type == "zoneList";
  int x0 = r.x + 2 + 14, x1 = r.x + r.w - 2 - 14, top = r.y + 2 + 8, bottom = r.y + r.h - 2 - 6;
  Rect hdr = rc(x0, top, x1 - x0, 48);
  int colGap = 28, colW = (x1 - x0 - colGap) / 2;
  int rowsTop = top + 48 + 4 + (zones ? 24 + 4 : 0);
  int rowH = (bottom - rowsTop) / kPerCol;
  // frame (+ column headings for heating)
  out.push_back({"t" + ti, r, [&a, r, zones, x0, top, colW, colGap](Canvas& c) {
    tileFrame(c, r);
    if (!zones) return;
    TextOpts o = C(Ink::Black);
    int bl = top + 48 + 4 + 19;   // column heads B20 (#199, was B13)
    for (int k = 0; k < 2; ++k) {
      int cx = x0 + k * (colW + colGap);
      c.text(cx, bl, utf8Upper(a.t(S::room)), B(20), o);
      c.textRight(cx + colW - kZoneSetW - 8, bl, utf8Upper(a.t(S::now)), B(20), o);
      c.textCenter(cx + colW - kZoneSetW / 2, bl, utf8Upper(a.t(S::setTemp)), B(20), o);
    }
  }});
  int sub = a.curSub();
  if (zones) {
    std::vector<ZoneState> zs = pickZones(a.data.zones, w);
    int pages = zonePages(int(zs.size()));
    int page = std::min(sub, pages - 1);
    int from = page * kPerPage, to = std::min(int(zs.size()), from + kPerPage);
    int heating = 0;
    for (auto& z : zs) heating += z.heating();
    int total = int(zs.size());
    std::string range = pages > 1 ? a.t(S::roomsRange, std::to_string(from + 1) + "–" + std::to_string(to), std::to_string(total))
                                  : a.t(S::nRooms, std::to_string(total));
    std::string summary = range + " · " + a.t(S::nHeating, std::to_string(heating)) + (a.data.away ? std::string(" · ") + a.t(S::away) : "");
    bool away = a.data.away, awayOk = a.data.awayOk();   // #148: no away button when no zone offers the preset
    out.push_back({"h" + ti, hdr, [&a, hdr, summary, away, awayOk](Canvas& c) {
      std::string bl = a.t(away ? S::setHome : S::setAway);
      int bw = awayOk ? c.textWidth(bl, B(18)) + 28 + 4 : 0;
      TextOpts t; t.maxW = hdr.w - bw - 12;
      c.text(hdr.x, mid(hdr.y, hdr.h, B(20)), summary, B(20), t);
      if (awayOk) button(c, rc(hdr.x + hdr.w - bw, hdr.y + 2, bw, 44), bl, B(18), false, [&a] { a.toggleAway(); });
    }});
    Font nf = B(20);
    Canvas m(nullptr);
    for (int k = from; k < to; ++k) if (m.textWidth(zs[k].name, B(20)) > zoneNameMax(zs[k], colW)) nf = B(18);
    for (int k = from; k < to; ++k) {
      int j = k - from;
      Rect rr = rc(x0 + (j / kPerCol) * (colW + colGap), rowsTop + (j % kPerCol) * rowH, colW, rowH);
      ZoneState z = zs[k];
      out.push_back({"z:" + z.id, rr, [&a, z, rr, nf](Canvas& c) { zoneRow(c, a, z, rr, nf); }});
    }
    return;
  }
  std::vector<LightGroup> groups = pickLights(a.data.lightGroups, w);
  auto pages = layoutLights(groups);
  int shown = 0, lit = 0;
  for (auto& g : groups) for (auto& id : g.ids) if (const LightState* l = a.data.light(id)) { ++shown; lit += l->on; }
  std::string summary = a.t(S::lightsOnOf, std::to_string(lit), std::to_string(shown));
  out.push_back({"h" + ti, hdr, [&a, hdr, summary](Canvas& c) {
    int bw = c.textWidth(a.t(S::allLightsOff), B(18)) + 28 + 4;
    TextOpts t; t.maxW = hdr.w - bw - 12;
    c.text(hdr.x, mid(hdr.y, hdr.h, B(20)), summary, B(20), t);
    button(c, rc(hdr.x + hdr.w - bw, hdr.y + 2, bw, 44), a.t(S::allLightsOff), B(18), false, [&a] { a.allOff(); });
  }});
  if (pages.empty()) return;
  const LightPage& page = pages[std::min(sub, int(pages.size()) - 1)];
  Font nf = B(20);
  Canvas m(nullptr);
  for (auto& it : page)
    if (it.kind == LightCell::Light)
      if (const LightState* l = a.data.light(it.id)) if (m.textWidth(l->name, B(20)) > lightNameMax(m, a, *l, colW)) nf = B(18);
  for (int j = 0; j < int(page.size()); ++j) {
    const LightCell& it = page[j];
    if (it.kind == LightCell::Spacer) continue;
    Rect rr = rc(x0 + (j / kPerCol) * (colW + colGap), rowsTop + (j % kPerCol) * rowH, colW, rowH);
    bool first = j % kPerCol == 0;
    if (it.kind == LightCell::Header) {
      LightCell cell = it;
      std::vector<std::string> ids;
      for (auto& g : groups) if (g.area == it.area) ids = g.ids;
      out.push_back({"r:" + it.area + (it.cont ? ":c" : ""), rr, [&a, cell, ids, rr, first](Canvas& c) { lightHeaderRow(c, a, cell, ids, rr, first); }});
    } else {
      const LightState* l = a.data.light(it.id);
      if (!l) continue;
      LightState ls = *l;
      out.push_back({"l:" + it.id, rr, [&a, ls, rr, first, nf](Canvas& c) { lightRow(c, a, ls, rr, first, nf); }});
    }
  }
}

}  // namespace ui
}  // namespace x4
