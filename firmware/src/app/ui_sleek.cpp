// Sleek display style: top bar, cards and list rows (docs/DISPLAY_STYLES_PLAN.md §3.3; geometry from the package's
// reference/sleek-*.dc-fragment.html and docs/DISPLAY_STYLES.md). Same inputs, region keys and touch actions as the
// Classic painters in ui_tiles.cpp / ui_chrome.cpp; only the drawing differs. Rects differ only where the design
// changes the layout (grid, top bar height, heating room cards).
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include "app/app_impl.h"
#include "core/catalog.h"
#include "core/history.h"
#include "core/json.h"

namespace x4 {
namespace ui {

bool sleek() { return activeLook().sleek; }

namespace {

int lineH(Font f) { const FontData* d = resolveFont(f); return d ? d->ascent + d->descent : f.size; }
int asc(Font f) { const FontData* d = resolveFont(f); return d ? d->ascent : f.size; }
// baseline of a CSS line box of height lh starting at top (half-leading may be negative)
int baseIn(int top, Font f, double lh) { return int(std::lround(top + (lh - lineH(f)) / 2.0 + asc(f))); }
// baseline that centres a normal line box on cy
int centreBl(int cy, Font f) { return cy - lineH(f) / 2 + asc(f); }

void surfCard(Canvas& c, Rect r, int radius = 20) { c.tone(r, radius, Tone::Surf); }

// − / + drawn as bars (crisper than glyphs), like the Classic round buttons
void minusPlus(Canvas& c, int cx, int cy, bool plus, Ink ink, int len = 14, int th = 3) {
  c.fill(rc(cx - len / 2, cy - th / 2, len, th), ink);
  if (plus) c.fill(rc(cx - th / 2, cy - len / 2, th, len), ink);
}

// 44+ px controls: circle (d = diameter) or pill
void circleBtn(Canvas& c, int cx, int cy, int d, bool dark, bool surf, bool plus, std::function<void()> fn) {
  if (surf) c.tone(rc(cx - d / 2, cy - d / 2, d, d), d / 2, Tone::Surf);
  else c.circle(cx, cy, d / 2, dark ? Ink::Black : Ink::Paper);
  minusPlus(c, cx, cy, plus, dark ? Ink::Paper : Ink::Black);
  if (fn) c.hit(rc(cx - d / 2, cy - d / 2, d, d), std::move(fn));
}
void pillBtn(Canvas& c, Rect r, bool plus, Ink bg, std::function<void()> fn) {
  c.box(r, r.h / 2, bg);
  minusPlus(c, r.x + r.w / 2, r.y + r.h / 2, plus, bg == Ink::Black ? Ink::Paper : Ink::Black);
  if (fn) c.hit(r, std::move(fn));
}
// text pill (44 px): label centred
int textPill(Canvas& c, int right, int cy, const std::string& label, Font f, int padX, bool dark, bool surf, std::function<void()> fn) {
  int w = c.textWidth(label, f) + 2 * padX;
  Rect r = rc(right - w, cy - 22, w, 44);
  if (surf) c.tone(r, 22, Tone::Surf);
  else c.box(r, 22, dark ? Ink::Black : Ink::Paper);
  c.textCenter(r.x + w / 2, centreBl(cy, f), label, f, C(dark ? Ink::Paper : Ink::Black));
  if (fn) c.hit(r, std::move(fn));
  return w;
}

// sub line at the bottom of a card (14 px, ink, padding-bottom 12); returns its top
int subLine(Canvas& c, Rect r, const std::string& s, bool centre = false, Ink ink = Ink::Black) {
  Font f = T4(14);
  int top = r.y + r.h - 12 - lineH(f);
  TextOpts o = C(ink); o.maxW = r.w - 32;
  if (centre) c.textCenter(r.x + r.w / 2, top + asc(f), s, f, o);
  else c.text(r.x + 16, top + asc(f), s, f, o);
  return top;
}

bool onlyDigits(const std::string& s) {
  static const std::string ok = "0123456789 .,:%°–—-+€/−";
  for (uint32_t cp : utf8Decode(s)) {
    bool hit = false;
    for (uint32_t k : utf8Decode(ok)) if (k == cp) hit = true;
    if (!hit) return false;
  }
  return true;
}

// ---------------- stat ----------------
Icon statIcon(const std::string& id) {
  if (id == "sensor.solar_power" || id == "sensor.solar_today") return Icon::SkSun17;
  if (id == "sensor.home_power" || id == "sensor.energy_today") return Icon::SkHouse17;
  if (id == "sensor.grid_power" || id == "sensor.grid_import_today" || id == "sensor.grid_export_today") return Icon::SkPlug17;
  if (id == "sensor.battery_power") return Icon::SkBattery17;
  if (id == "sensor.living_temperature") return Icon::SkThermo17;
  if (id == "sensor.price_min" || id == "sensor.price_max") return Icon::SkEuro17;
  if (id == "sensor.price_cheap_window") return Icon::SkClock17;
  return Icon::SkBolt17;
}

// 24 hourly bars, bottom-aligned in [top, bottom): now INK, past Hatch, future Track (B/W patterns, issue #38)
void spark(Canvas& c, int x0, int w, int bottom, int h, const std::vector<double>& ser, int hour) {
  double mx = *std::max_element(ser.begin(), ser.end());
  int n = 24, avail = w - 2 * (n - 1);
  for (int j = 0; j < n; ++j) {
    int bx = x0 + j * avail / n + 2 * j, bw = (j + 1) * avail / n - j * avail / n;
    int hp = mx > 0 ? std::max(8, int(jsRound(ser[j] / mx * 100))) : 8;
    int bh = std::max(2, int(std::lround(h * hp / 100.0)));
    Rect b = rc(bx, bottom - bh, bw, bh);
    if (j == hour) c.box(b, 2, Ink::Black);
    else if (j < hour) c.tone(b, 2, Tone::Hatch);
    else c.tone(b, 2, Tone::Track);
  }
}

void statCard(Canvas& c, I& a, const Widget& w, Rect r) {
  surfCard(c, r);
  std::string id = w.field("entity");
  StatText s = statText(id, a.data, a.now.h, a.statEntity(id), a.lang);
  if (!w.field("label").empty()) s.label = w.field("label");
  if (s.gap != EntityGap::None) s.sub = gapText(a, s.gap);
  int x0 = r.x + 16, top = r.y + 14;
  c.circle(x0 + 15, top + 15, 15, Ink::Black);
  c.icon(statIcon(id), x0 + 7, top + 7, Ink::Paper);
  TextOpts lo; lo.maxW = r.w - 32 - 38;
  c.text(x0 + 38, centreBl(top + 15, T6(16)), s.label, T6(16), lo);
  int subTop = subLine(c, r, s.sub);
  int valBot = subTop - 4;
  const std::vector<double>* ser = nullptr;
  if (id == "sensor.solar_power" || id == "sensor.solar_today") ser = &a.data.solarSeries;
  if (id == "sensor.home_power" || id == "sensor.energy_today") ser = &a.data.usage;
  if (ser && ser->size() >= 24 && a.now.known) {
    spark(c, x0, r.w - 32, subTop - 4, 22, *ser, a.now.h);
    valBot = subTop - 4 - 22 - 8;
  }
  auto tokenOf = [](const std::string& v) {
    int n = int(utf8Decode(v).size());
    return !onlyDigits(v) ? 40 : n <= 3 ? 62 : n == 4 ? 56 : n == 5 ? 48 : 40;   // big sizes are digits-only fonts
  };
  TextOpts t; t.tracking = -1; t.tabular = true;
  int unitW = s.unit.empty() ? 0 : c.textWidth(s.unit, DS(20)) + 4;
  // #151/#162: drop decimals while 2 significant digits stay, then step the size down; no ellipsis on a number
  std::vector<int> sizes;
  for (int z : {62, 56, 48, 40, 38, 30}) if (z <= tokenOf(s.value)) sizes.push_back(z);
  FitValue fv = fitValue(s.value, sizes, r.w - 32, [&c, &t, unitW](const std::string& v, int z) { return c.textWidth(v, D(z), t) + unitW; });
  s.value = fv.value;
  t.maxW = r.w - 32 - unitW;
  Font vf = D(fv.size);
  double lh = vf.size * 0.9;
  int bl = baseIn(int(valBot - lh), vf, lh);
  if (s.gap != EntityGap::None) { gapRing(c, x0, bl); return; }
  int vw = c.text(x0, bl, s.value, vf, t);
  if (!s.unit.empty()) c.text(x0 + std::min(vw, t.maxW) + 4, bl, s.unit, DS(20));
}

// ---------------- clock (inverted hero) ----------------
// Two regions: the card + date line (tile t<i>), and the minute window below the date line (k<i>: digits + day
// progress), so the minute tick redraws only the window (issue #38).
static const int kClockCardTop = 16;
static int clockHdrBot(Rect r) { return r.y + kClockCardTop + lineH(T6(16)); }

void clockCard(Canvas& c, I& a, const Widget& w, Rect r) {
  (void)w;
  c.box(r, 20, Ink::Black);
  int x0 = r.x + 20, x1 = r.x + r.w - 20, top = r.y + kClockCardTop;
  Font hf = T6(16);
  std::string wd = a.now.date, dm;
  auto sp = wd.find(' ');
  if (sp != std::string::npos) { dm = wd.substr(sp + 1); wd = wd.substr(0, sp); }
  if (!a.asleepAt.empty()) { sp = dm.find(' '); if (sp != std::string::npos) dm = dm.substr(sp + 1); }   // #333: the month; the number is big
  c.text(x0, top + asc(hf), wd, hf, C(Ink::Paper));
  c.textRight(x1, top + asc(hf), dm, hf, C(Ink::Paper));
}

Rect clockWindowRect(Rect r) { int y = clockHdrBot(r) + 2; return rc(r.x, y, r.w, r.y + r.h - y); }

// #333 asleep: the day number in place of the digits, and a paper "Asleep" pill where the day progress was (no time of day)
static void clockWindowAsleep(Canvas& c, I& a, const Widget& w, Rect r) {
  int x0 = r.x + 20, bot = r.y + r.h - 14;
  Font pf = T6(16);
  const std::string mark = a.t(S::asleepBar);
  int pw = c.textWidth(mark, pf) + 24, ph = 28, py = bot - ph;
  c.box(rc(x0, py, pw, ph), ph / 2, Ink::Paper);
  c.text(x0 + 12, centreBl(py + ph / 2, pf), mark, pf);
  Font tf = D(w.rs > 1 ? 150 : 104);
  double lh = tf.size * 0.82;
  int hdrBot = clockHdrBot(r);
  int ttop = int(hdrBot + ((py - 6 - hdrBot) - lh) / 2);
  TextOpts tt = C(Ink::Paper); tt.tracking = -3; tt.tabular = true;
  c.text(x0, baseIn(ttop, tf, lh), a.now.day, tf, tt);
}

void clockWindow(Canvas& c, I& a, const Widget& w, Rect r) {
  c.box(r, 20, Ink::Black);   // clipped to the window by the caller
  if (!a.asleepAt.empty()) { clockWindowAsleep(c, a, w, r); return; }
  int x0 = r.x + 20, x1 = r.x + r.w - 20, bot = r.y + r.h - 14;
  Font af = T4(12);
  int axisTop = bot - lineH(af), barTop = axisTop - 5 - 6, tw = x1 - x0;
  c.fill(rc(x0, barTop + 2, tw, 2), Ink::Paper);   // track: 2 px paper hairline (B/W, #38)
  int pct = a.now.known ? int(jsRound(a.now.minuteOfDay / 1440.0 * 100)) : 0;
  if (pct > 0) c.box(rc(x0, barTop, std::max(6, tw * pct / 100), 6), 3, Ink::Paper);
  static const char* ax[] = {"00", "06", "12", "18", "24"};
  TextOpts at = C(Ink::Paper); at.tabular = true;
  for (int k = 0; k < 5; ++k) {
    int aw = c.textWidth(ax[k], af, at);
    c.text(k == 0 ? x0 : k == 4 ? x1 - aw : x0 + (tw - aw) * k / 4, axisTop + asc(af), ax[k], af, at);
  }
  Font tf = D(w.rs > 1 ? 150 : 104);
  double lh = tf.size * 0.82;
  int hdrBot = clockHdrBot(r);
  int ttop = int(hdrBot + ((barTop - hdrBot) - lh) / 2);
  TextOpts tt = C(Ink::Paper); tt.tracking = -3; tt.tabular = true;
  c.text(x0, baseIn(ttop, tf, lh), a.now.clock, tf, tt);
}

// ---------------- power price ----------------
void priceCard(Canvas& c, I& a, const Widget& w, Rect r) {
  surfCard(c, r);
  const auto& P = a.data.prices;
  int x0 = r.x + 16, x1 = r.x + r.w - 16, top = r.y + 14;
  bool ok = P.size() >= 24 && a.now.known;
  int h = a.now.h;
  std::vector<double> so = P; std::sort(so.begin(), so.end());
  double pn = ok ? a.data.priceAt(h, a.now.m) : 0;   // this quarter-hour's when the source has them (#151)
  bool cheap = ok && pn <= so[7], dear = ok && pn >= so[16];
  int chipW = 0;
  if (ok) {
    std::string chip = a.t(dear ? S::high : cheap ? S::cheap : S::normal);
    chipW = c.textWidth(chip, T7(13)) + 20;
    c.box(rc(x1 - chipW, top, chipW, 26), 13, dear ? Ink::Black : Ink::Paper);
    c.text(x1 - chipW + 10, centreBl(top + 13, T7(13)), chip, T7(13), C(dear ? Ink::Paper : Ink::Black));
  }
  TextOpts lo; lo.maxW = x1 - x0 - chipW - 4;
  Font lf = T6(16);
  std::string lab = w.field("label").empty() ? std::string(a.t(S::powerPrice)) : w.field("label");   // #148
  for (int sz : {16, 15, 14}) { lf = T6(sz); if (c.textWidth(lab, lf) <= lo.maxW) break; }   // wide faces
  c.text(x0, centreBl(top + 13, lf), lab, lf, lo);
  int ch = a.data.cheapestStart(3);
  std::string sub = !ok ? "" : h >= ch && h < ch + 3 ? std::string(a.t(S::cheapestNow)) : a.t(S::cheapestAt, pad2(ch) + "–" + pad2(ch + 3) + " h");
  int subTop = subLine(c, r, sub);
  int sb = subTop - 6;
  if (ok) {
    int n = 24, avail = (x1 - x0) - (n - 1);
    for (int j = 0; j < n; ++j) {
      int bx = x0 + j * avail / n + j, bw = (j + 1) * avail / n - j * avail / n, bh = j == h ? 26 : 16;
      Rect cell = rc(bx, sb - bh, bw, bh);
      if (j == h) c.box(cell, 2, Ink::Black);
      else if (P[j] <= so[7]) c.box(cell, 2, Ink::Paper);
      else if (P[j] >= so[16]) c.tone(cell, 2, Tone::Hatch);
      else c.tone(cell, 2, Tone::Track);
    }
  }
  Font vf = D(58);
  double lh = vf.size * 0.9;
  int bl = baseIn(int(sb - 26 - 6 - lh), vf, lh);
  const std::string& cur = locale::currency();   // the digits face has € only; $ £ SEK in the text face (#147)
  int ew = c.text(x0, bl, cur, cur == "€" ? DS(24) : B(24));
  TextOpts t; t.tracking = -1; t.tabular = true;
  c.text(x0 + ew + 3, bl, ok ? fmtNum(pn, "", 2) : "—", vf, t);
}

// ---------------- battery ring ----------------
void ringCard(Canvas& c, Rect r, const std::string& label, bool ok, int pct, const std::string& sub, bool gap = false) {
  surfCard(c, r);
  int top = r.y + 14;
  Font lf = T6(16);
  TextOpts lo; lo.maxW = r.w - 32;
  c.text(r.x + 16, top + asc(lf), label, lf, lo);
  int ringTop = top + lineH(lf) + 4, cx = r.x + r.w / 2, cy = ringTop + 56;
  c.arcTone(cx, cy, 46, 12, 0, 360, Tone::Track);
  if (ok && pct > 0) c.arc(cx, cy, 46, 12, -90, std::min(100, pct) * 3.6, Ink::Black);
  Font vf = D(40), pf = T7(16);   // design: display 600; the condensed 16 px % loses its slash at 2 bits
  std::string v = ok ? std::to_string(pct) : gap ? "" : "—";   // gap (#86): the empty track is the mark
  TextOpts t; t.tabular = true;
  int w1 = c.textWidth(v, vf, t), w2 = ok ? c.textWidth("%", pf) : 0;
  int bl = baseIn(ringTop + 34, vf, vf.size);
  int x = cx - (w1 + w2) / 2;
  x += c.text(x, bl, v, vf, t);
  if (ok) c.text(x, bl, "%", pf);
  TextOpts so = C(Ink::Black); so.maxW = r.w - 32;
  Font sf = T4(14);
  c.textCenter(cx, ringTop + 112 + 4 + asc(sf), sub, sf, so);
}

void gaugeCard(Canvas& c, I& a, const Widget& w, Rect r) {
  std::string id = w.field("entity");
  if (!id.empty() && id != kGaugeDefaultEntity) {
    const EntityValue* v = a.store.get(id);
    std::string lab = w.field("label").empty() ? friendlyName(id, v) : w.field("label");
    char* end = nullptr;
    double x = entityAvailable(v) ? std::strtod(v->state.c_str(), &end) : 0;
    bool ok = entityAvailable(v) && end && end != v->state.c_str();
    EntityGap gap = entityGap(v);
    ringCard(c, r, lab, ok, ok ? int(jsRound(std::max(0.0, std::min(100.0, x)))) : 0, gapText(a, gap), gap != EntityGap::None);
    return;
  }
  const HomeData& d = a.data;
  std::string sub;
  if (d.batt.ok) { auto f = kw(d.batt.v); sub = d.batt.v > 30 ? a.t(S::charging, f.v + " " + f.u) : d.batt.v < -30 ? a.t(S::discharging, f.v + " " + f.u) : a.t(S::idle); }
  ringCard(c, r, w.field("label").empty() ? std::string(a.t(S::battery)) : w.field("label"), d.soc.ok, d.soc.ok ? int(jsRound(d.soc.v)) : 0, sub);
}

// ---------------- chart (capsule bars + "Now" flag) ----------------
void barsCard(Canvas& c, I& a, const Widget& w, Rect r) {
  surfCard(c, r);
  std::string series = w.field("series");
  const HomeData& d = a.data;
  const std::vector<double>& ser = series == "prices" ? d.prices : series == "solar" ? d.solarSeries : d.usage;
  std::string lab = !w.field("label").empty() ? w.field("label")
                    : series == "prices" ? a.t(S::chartPrices, locale::currency()) : a.t(series == "solar" ? S::chartSolar : S::chartUsage);
  int x0 = r.x + 18, x1 = r.x + r.w - 18, top = r.y + 14, bot = r.y + r.h - 10;
  int h = a.now.h, ch = d.cheapestStart(3);
  std::string summary;
  if (series == "prices") { if (ser.size() >= 24 && a.now.known) summary = a.t(S::pricesSummary, locale::money(d.priceAt(h, a.now.m)), pad2(ch) + "–" + pad2(ch + 3)); }
  else if (series == "solar") { if (d.solarToday.ok) summary = a.t(S::soFar, fmtNum(d.solarToday.v, "kWh")); }
  else if (d.usedToday.ok) summary = a.t(S::soFar, fmtNum(d.usedToday.v, "kWh"));
  Font lf = T6(16), sf = D(20);
  int sumW = summary.empty() ? 0 : c.textWidth(summary, sf);
  if (c.textWidth(lab, lf) + sumW + 10 > x1 - x0) summary.clear(), sumW = 0;
  int hb = top + asc(lf);
  TextOpts lo; lo.maxW = x1 - x0 - sumW - 10;
  c.text(x0, hb, lab, lf, lo);
  if (!summary.empty()) c.textRight(x1, hb, summary, sf);
  Font af = T4(13), lf2 = T6(15);
  // prices (#260): today's low / high under the axis
  hist::Extreme pLo, pHi;
  const bool lh = series == "prices" && ser.size() >= 24 && hist::dayLowHigh(ser.data(), 24, a.lang, pLo, pHi);
  if (lh) {
    std::string l = a.t(S::histLow, fmtNum(pLo.v, "", 2), std::string(pLo.time)), g = a.t(S::histHigh, fmtNum(pHi.v, "", 2), std::string(pHi.time));
    TextOpts lt = C(Ink::Black); lt.tabular = true;
    int lbl = bot - lineH(lf2) + asc(lf2);
    c.text(x0, lbl, l, lf2, lt);
    if (c.textWidth(l, lf2, lt) + 12 + c.textWidth(g, lf2, lt) <= x1 - x0) c.textRight(x1, lbl, g, lf2, lt);
    bot -= lineH(lf2) + 6;
  }
  int axisTop = bot - lineH(af);
  TextOpts at = C(Ink::Black); at.tabular = true;
  static const char* ticks[] = {"00", "06", "12", "18", "24"};
  for (int k = 0; k < 5; ++k) {
    int tw = c.textWidth(ticks[k], af, at);
    c.text(k == 0 ? x0 : k == 4 ? x1 - tw : x0 + (x1 - x0 - tw) * k / 4, axisTop + asc(af), ticks[k], af, at);
  }
  int areaTop = top + lineH(lf) + 6, areaBot = axisTop - 6;
  int barsTop = areaTop + 22, H = areaBot - barsTop;
  if (ser.size() < 24 || H < 10) {
    c.textCenter((x0 + x1) / 2, (areaTop + areaBot) / 2 + 8, "—", D(24), C(Ink::Black));
    return;
  }
  if (a.now.known) {   // "Now" flag over the current hour
    Font ff = T7(12);
    int fw = c.textWidth(a.t(S::now), ff) + 16;
    int fx = x0 + int(std::lround((h + 0.5) / 24.0 * (x1 - x0))) - fw / 2;
    fx = std::max(x0, std::min(x1 - fw, fx));
    c.box(rc(fx, areaTop, fw, 20), 10, Ink::Black);
    c.text(fx + 8, centreBl(areaTop + 10, ff), a.t(S::now), ff, C(Ink::Paper));
  }
  double mx = *std::max_element(ser.begin(), ser.end());
  int n = 24, gap = 5, avail = (x1 - x0) - gap * (n - 1);
  for (int j = 0; j < n; ++j) {
    int bx = x0 + j * avail / n + gap * j, bw = (j + 1) * avail / n - j * avail / n;
    int pct = mx > 0 ? std::max(2, int(jsRound(ser[j] / mx * 100))) : 2;
    int bh = std::max(4, H * pct / 100);
    Rect b = rc(bx, areaBot - bh, bw, bh);
    int rad = std::min(6, bw / 2);
    bool now = a.now.known && j == h;
    bool dark = series == "prices" ? (j >= ch && j < ch + 3) : (a.now.known && j < h);
    if (now) c.box(b, rad, Ink::Black);
    else if (dark) c.tone(b, rad, Tone::Hatch);
    else c.tone(b, rad, Tone::Track);
  }
}

// ---------------- thermostat dial ----------------
void thermoCard(Canvas& c, I& a, const Widget& w, Rect r) {
  surfCard(c, r);
  std::string id = w.field("zone");
  const ZoneState* z = a.data.zone(id);
  auto fr = [](double t) { return std::max(0.0, std::min(1.0, (t - 14) / 12)); };
  int bottomRow = r.y + r.h - 10 - 46;
  int boxTop = r.y + 10 + (w.rs > 1 ? std::max(0, (bottomRow - 6 - (r.y + 10) - 104) / 2) : 0);   // tall: centred
  int cx = r.x + r.w / 2, cy = boxTop - 4 + 60;
  c.arcTone(cx, cy, 44, 9, 135, 270, Tone::Track);
  if (z && z->cur.ok && fr(z->cur.v) > 0) c.arc(cx, cy, 44, 9, 135, 270 * fr(z->cur.v), Ink::Black);
  if (z && z->set.ok) {
    double ang = (135 + 270 * fr(z->set.v)) * 3.14159265358979323846 / 180;
    c.circle(int(std::lround(cx + 44 * std::cos(ang))), int(std::lround(cy + 44 * std::sin(ang))), 8, Ink::Paper, 3, Ink::Black);
  }
  Font vf = D(34), nf = T6(13);
  TextOpts vt; vt.tabular = true;
  std::string cur = z && z->cur.ok ? fmtNum(z->cur.v, "°C") + "°" : "—";
  for (int t : {34, 30, 27}) { vf = D(t); if (c.textWidth(cur, vf, vt) <= 70) break; }   // stay inside the ring (r 44 − 4.5)
  c.textCenter(cx, baseIn(boxTop + 6 + (98 - vf.size) / 2, vf, vf.size), cur, vf, vt);
  // #162: the name sits under the ring's open bottom, card-wide (was 62 px inside the ring: "Slaapk…" twice)
  std::string name = !w.field("label").empty() ? w.field("label") : z ? z->name : id.empty() ? std::string(a.t(S::room)) : id;
  TextOpts no; no.maxW = r.w - 24;
  int nameMid = (cy + 41 + bottomRow) / 2;
  c.textCenter(cx, centreBl(nameMid, nf), fitKeepTail(name, no.maxW, [&c, nf](const std::string& t) { return c.textWidth(t, nf); }), nf, no);
  int by = bottomRow + 23;
  circleBtn(c, r.x + 12 + 23, by, 46, false, false, false, [&a, id] { a.setZone(id, -0.5); });
  circleBtn(c, r.x + r.w - 12 - 23, by, 46, true, false, true, [&a, id] { a.setZone(id, 0.5); });
  TextOpts sv; sv.tabular = true; sv.dotted = a.setOverride.count(id) > 0;
  Font sf = T7(15);
  c.textCenter(cx, centreBl(by, sf), z && z->set.ok ? "→ " + fmtNum(z->set.v, "°C") + "°" : "—", sf, sv);
}

// ---------------- favourite light / switch: the whole card is the switch ----------------
void switchCard(Canvas& c, I& a, Rect r, bool known, bool on, const std::string& value, const std::string& label, Icon icon,
                std::function<void()> toggle, std::function<void()> dec, std::function<void()> inc, bool gap = false) {
  if (on) c.box(r, 20, Ink::Black);
  else surfCard(c, r);
  Ink fg = on ? Ink::Paper : Ink::Black;
  bool dims = dec != nullptr;
  int x0 = r.x + 16, top = r.y + 14;
  int rowY = r.y + r.h - 8 - 44;
  int btnBot = dims ? rowY - 6 : r.y + r.h - 14;
  c.circle(x0 + 17, top + 17, 17, on ? Ink::Paper : Ink::Black);
  c.icon(icon, x0 + 17 - iconData(icon).size / 2, top + 17 - iconData(icon).size / 2, on ? Ink::Black : Ink::Paper);
  Font lf = T6(14), vf = D(38);
  int labTop = btnBot - lineH(lf);
  TextOpts lo = C(on ? Ink::Paper : Ink::Black); lo.maxW = r.w - 32;
  c.text(x0, labTop + asc(lf), label, lf, lo);
  TextOpts vo = C(fg); vo.maxW = r.w - 32;
  if (gap) gapRing(c, x0, baseIn(labTop - 2 - vf.size, vf, vf.size));
  else c.text(x0, baseIn(labTop - 2 - vf.size, vf, vf.size), value, vf, vo);
  if (known && toggle) c.hit(rc(r.x, r.y, r.w, (dims ? rowY : r.y + r.h) - r.y), std::move(toggle));
  if (dims) {
    int bw = (r.w - 16 - 6) / 2;
    pillBtn(c, rc(r.x + 8, rowY, bw, 44), false, Ink::Paper, std::move(dec));
    pillBtn(c, rc(r.x + 8 + bw + 6, rowY, r.w - 16 - 6 - bw, 44), true, Ink::Paper, std::move(inc));
  }
}

void switchTile(Canvas& c, I& a, const Widget& w, Rect r) {
  std::string id = w.field("entity");
  if (domainOf(id) == "light") {
    if (const LightState* l = a.data.light(id.substr(6))) {
      std::string lid = l->id;
      std::string room = a.data.areaNames.count(l->area) ? a.data.areaNames.at(l->area) : l->area;
      switchCard(c, a, r, true, l->on, l->on ? (l->dim ? std::to_string(l->pct) + "%" : a.t(S::on)) : a.t(S::off), room + " · " + l->name,
                 Icon::SkBulb18, [&a, lid] { a.toggleLight(lid); }, [&a, lid] { a.dimLight(lid, -10); }, [&a, lid] { a.dimLight(lid, 10); });
      return;
    }
  }
  std::string lab = w.field("label").empty() ? friendlyName(id, a.store.get(id)) : w.field("label");
  bool known = false;
  bool on = a.entityOn(id, known);
  EntityGap gap = known ? EntityGap::None : entityGap(a.store.get(id));
  if (gap != EntityGap::None) lab += " · " + gapText(a, gap);
  switchCard(c, a, r, known, known && on, !known ? "—" : on ? a.t(S::on) : a.t(S::off), lab, domainOf(id) == "light" ? Icon::SkBulb18 : Icon::SkPower20,
             [&a, id] { a.toggleEntity(id); }, nullptr, nullptr, gap != EntityGap::None);
}

// ---------------- scene (inverted action card) ----------------
void sceneCard(Canvas& c, I& a, const Widget& w, Rect r) {
  SceneAction act = sceneAction(w);
  c.box(r, 20, Ink::Black);
  int x0 = r.x + 16, top = r.y + 14;
  c.circle(x0 + 18, top + 18, 18, Ink::Paper);
  c.icon(Icon::SkPower20, x0 + 8, top + 8, Ink::Black);
  int subTop = subLine(c, r, sceneSub(a, act), false, Ink::Paper);
  Font lf = D(30);
  double lh = lf.size * 1.05;
  int midTop = top + 36, freeH = subTop - midTop;
  TextOpts t = C(Ink::Paper); t.maxW = r.w - 32;
  c.text(x0, baseIn(int(midTop + (freeH - lh) / 2), lf, lh), sceneLabel(a, w, act), lf, t);
  c.hit(r, [&a, act] { a.runScene(act); });
}

// ---------------- setting (stepper capsule) ----------------
void settingCard(Canvas& c, I& a, const Widget& w, Rect r, const std::string& value) {
  surfCard(c, r);
  std::string key = w.field("key");
  const SettingDef* d = findSetting(key);
  Font lf = T6(16);
  TextOpts lo; lo.maxW = r.w - 32;
  c.text(r.x + 16, r.y + 14 + asc(lf), d ? a.t(d->label) : key, lf, lo);
  Rect cap = rc(r.x + 12, r.y + r.h - 12 - 56, r.w - 24, 56);
  c.box(cap, 28, Ink::Paper);
  int cy = cap.y + 28;
  circleBtn(c, cap.x + 6 + 22, cy, 44, false, true, false, nullptr);
  circleBtn(c, cap.x + cap.w - 6 - 22, cy, 44, true, false, true, nullptr);
  c.hit(rc(cap.x, cap.y, cap.w / 2, cap.h), [&a, key] { a.setCfg(key, -1); });
  c.hit(rc(cap.x + cap.w / 2, cap.y, cap.w - cap.w / 2, cap.h), [&a, key] { a.setCfg(key, 1); });
  // value between the buttons; long values ("after 15 min") step down instead of ending in an ellipsis
  TextOpts vt; vt.tabular = true; vt.maxW = cap.w - 12 - 88 - 6;
  Font vf = D(20);
  std::string v = value;
  for (int pass = 0; pass < 2; ++pass) {
    bool fits = false;
    for (Font f : {D(20), D(18), T7(15), T7(13)}) { vf = f; if ((fits = c.textWidth(v, f, vt) <= vt.maxW)) break; }
    if (fits) break;
    for (S k : {S::afterMin, S::everySec, S::everyMin}) {   // the label says it: drop "after " / "every " (the text before {})
      std::string pre = a.t(k); pre.resize(pre.find("{}"));
      if (v.rfind(pre, 0) == 0) { v = v.substr(pre.size()); break; }
    }
  }
  c.textCenter(cap.x + cap.w / 2, centreBl(cy, vf), v, vf, vt);
}

}  // namespace

Rect sleekClockTimeRect(Rect card) { return clockWindowRect(card); }
void sleekClockTime(Canvas& c, I& a, const Widget& w, Rect card) { clockWindow(c, a, w, card); }

// ======================= top bar =======================
static void pagerPos(I& a, int& tot, int& cur) {
  if (a.setup != Setup::None) { tot = 2; cur = a.setup == Setup::Wifi ? 0 : 1; return; }
  auto f = flatPages(a.cfg, a.idx, a.paging());
  int cs = a.curSub();
  tot = int(f.size()); cur = 0;
  for (int i = 0; i < tot; ++i) if (f[i].screen == a.idx && f[i].sub == cs) cur = i;
  if (a.menu == Menu::Apps) cur = -1;   // app switcher open: no current page dot (#151)
}
static int dotsWidth(int nd, int dcur) { int w = 0; for (int k = 0; k < nd; ++k) w += (k == dcur ? 22 : 8) + (k ? 5 : 0); return w; }
static int pagerCapW(I& a) {
  int tot, cur;
  pagerPos(a, tot, cur);
  return 4 + 44 + 2 + std::max(52, dotsWidth(std::min(tot, 8), std::min(cur, 7)) + 20) + 2 + 44 + 4;
}

// clock: its own region (minute tick), fixed width "00:00" right-aligned against the pager
Rect sleekBarTimeRect(I& a) {
  TextOpts ct; ct.tabular = true;
  int right = a.chr.pager ? kScreenW - 12 - pagerCapW(a) - 12 : kScreenW - 12, w = Canvas().textWidth("00:00", D(24), ct);
  if (!a.asleepAt.empty()) w = Canvas().textWidth(a.t(S::asleepBar), T6(16)) + 28;   // #299; #333: a dark pill, no time
  return rc(right - w, 8, w, 48);
}
void sleekBarTime(Canvas& c, I& a) {
  Rect r = sleekBarTimeRect(a);
  if (!a.asleepAt.empty()) {
    c.box(rc(r.x, 16, r.w, 32), 16, Ink::Black);
    c.text(r.x + 14, centreBl(32, T6(16)), a.t(S::asleepBar), T6(16), C(Ink::Paper));
    return;
  }
  Font cf = D(24);
  TextOpts ct; ct.tabular = true;
  c.textRight(r.x + r.w, centreBl(32, cf), a.now.clock, cf, ct);
}

void sleekTopBar(Canvas& c, I& a) {
  bool setup = a.setup != Setup::None;
  const Screen* sc = a.curScreen();
  std::string appTitle = setup ? a.t(S::setup) : a.appTitle(a.appOf());
  // setup (#183): "Step 2 of 2" as the title, no pager (app.cpp)
  std::string pageTitle = setup ? a.t(S::setupStep, a.setup == Setup::Wifi ? "1" : "2", "2")
      : a.menu == Menu::Apps ? a.t(S::allApps) : a.menu == Menu::Pages ? a.t(S::allPages) : (sc ? sc->title : "");
  // 1. app + page title button (x 6, w 250, h 56), content inset 10
  Font af = T6(13), tf = D(27), sf = T6(14);
  double l1 = 13 * 1.2, l2 = tf.size * 1.05;
  int top = int(4 + (56 - (l1 + 1 + l2)) / 2);
  int x = 16;
  if (a.chr.app) {
    TextOpts ao = C(Ink::Black); ao.maxW = 210;
    int aw = c.text(x, baseIn(top, af, l1), appTitle, af, ao);
    if (!setup) c.icon(a.menu == Menu::Apps ? Icon::ChevUp12 : Icon::ChevDown12, x + aw + 5, top + int(l1 - 12) / 2, Ink::Black);
  }
  int nSub = sc && !setup ? subPages(*sc, a.paging()) : 1;
  bool hasSub = !setup && a.menu == Menu::None && nSub > 1 && a.chr.app;
  std::string subText = hasSub ? a.t(S::ofN, std::to_string(a.curSub() + 1), std::to_string(nSub)) : "";
  int subW = hasSub ? c.textWidth(subText, sf) + 8 : 0;
  TextOpts to; to.tracking = 0; to.maxW = 230 - subW;
  int tb = a.chr.app ? baseIn(int(top + l1 + 1), tf, l2) : baseIn(int(4 + (56 - l2) / 2), tf, l2);   // ambient: title alone, centred
  int pw = c.text(x, tb, pageTitle, tf, to);
  if (hasSub) c.text(x + pw + 8, tb, subText, sf, C(Ink::Black));
  if (!setup) c.hit(rc(6, 4, 250, 56), [&a] { a.setMenu(Menu::Apps, "TOUCH app title"); });

  // 4. pager capsule: 52 px SURF, padding 4; Previous = PAPER circle, page dots, Next = INK circle. None in ambient.
  if (a.chr.pager) {
    int tot, cur;
    pagerPos(a, tot, cur);
    int nd = std::min(tot, 8), dcur = std::min(cur, 7);
    int dotsW = dotsWidth(nd, dcur);
    int dbw = std::max(52, dotsW + 20);
    int capW = pagerCapW(a), px0 = kScreenW - 12 - capW;
    c.tone(rc(px0, 6, capW, 52), 26, Tone::Surf);
    c.circle(px0 + 4 + 22, 32, 22, Ink::Paper);
    c.icon(Icon::ChevLeft20, px0 + 4 + 12, 22, Ink::Black);
    int dbx = px0 + 4 + 44 + 2;
    if (a.menu == Menu::Pages) c.tone(rc(dbx, 10, dbw, 44), 22, Tone::Track);
    int dx = dbx + (dbw - dotsW) / 2;
    for (int k = 0; k < nd; ++k) { int dw = k == dcur ? 22 : 8; c.box(rc(dx, 28, dw, 8), 4, Ink::Black); dx += dw + 5; }
    int nx = px0 + capW - 4 - 22;
    c.circle(nx, 32, 22, Ink::Black);
    c.icon(Icon::ChevRight20, nx - 10, 22, Ink::Paper);
    c.hit(rc(px0, 4, 4 + 44 + 2, 56), [&a] { a.nav(-1, "TOUCH ‹"); });
    c.hit(rc(px0 + capW - 50, 4, 50, 56), [&a] { a.nav(1, "TOUCH ›"); });
    if (!setup) c.hit(rc(dbx, 10, dbw, 44), [&a] { a.setMenu(Menu::Pages, "TOUCH page count"); });
  }

  // 3. status icons, battery bar, clock (display face 24 × fk; region "time", sleekBarTime), right-aligned to the pager.
  // Ambient (#27): status icons stay, battery only when low, clock only without a clock tile.
  Rect tr = sleekBarTimeRect(a);
  int right = a.chr.clock ? tr.x - 10 : tr.x + tr.w;
  int batt = a.board.power().batteryPct;
  if (a.chr.battery) {
    Rect bb = rc(right - 24, 26, 24, 12);
    c.tone(bb, 4, Tone::Track);
    int fw = 24 * std::max(0, std::min(100, batt)) / 100;
    if (fw > 0) c.box(rc(bb.x, bb.y, fw, 12), std::min(4, fw / 2), Ink::Black);
    right = bb.x - 4;
    if (batt < kBattLow) { std::string t = std::to_string(batt) + "%"; Font bf = T7(14); int w = c.textWidth(t, bf); c.text(right - w, centreBl(32, bf), t, bf); right -= w; }
    right -= 10;
  }
  if (!setup) {
    auto& st = a.svc.status();
    std::vector<Icon> icons;
    if (!a.linked()) icons.push_back(Icon::StatusUnlinked);
    else if (a.offline()) icons.push_back(Icon::StatusOffline);
    if (!a.setOverride.empty()) icons.push_back(Icon::StatusSync);
    if (st.ota == OtaState::Available && a.set.otaAuto != "off") icons.push_back(Icon::StatusUpdate);
    if (st.ota == OtaState::Failed) icons.push_back(Icon::StatusAlert);
    if (a.data.away) icons.push_back(Icon::StatusAway);
    if (a.quietHour() && !a.quietActive() && !a.sleeping) icons.push_back(Icon::StatusNight);   // peeking in quiet hours
    if (a.set.brightness > 0 && !a.quietActive()) icons.push_back(Icon::StatusLight);
    for (auto it = icons.rbegin(); it != icons.rend(); ++it) { right -= 20; c.icon(*it, right, 22); right -= 10; }
  }
}

// ======================= cards =======================
bool sleekTile(Canvas& c, I& a, const Widget& w, Rect r, const std::string& settingText) {
  if (w.type == "stat") statCard(c, a, w, r);
  else if (w.type == "clock") clockCard(c, a, w, r);
  else if (w.type == "price") priceCard(c, a, w, r);
  else if (w.type == "gauge") gaugeCard(c, a, w, r);
  else if (w.type == "bars") barsCard(c, a, w, r);
  else if (w.type == "thermo") thermoCard(c, a, w, r);
  else if (w.type == "switch") switchTile(c, a, w, r);
  else if (w.type == "scene") sceneCard(c, a, w, r);
  else if (w.type == "setting") settingCard(c, a, w, r, settingText);
  else return false;   // route, unknown: Classic layout on a Sleek card (tileFrame), Sleek typeface
  return true;
}

// ======================= lists =======================
void sleekListRegions(I& a, const Widget& w, int i, Rect r, std::vector<RegionDef>& out) {
  std::string ti = std::to_string(i);
  bool zones = w.type == "zoneList";
  Rect hdr = rc(r.x, r.y + 4, r.w, 48);
  // the list tile itself is PAPER with no radius: an empty frame region keeps the Classic key set
  out.push_back({"t" + ti, r, [](Canvas&) {}});
  int sub = a.curSub();
  if (zones) {
    std::vector<ZoneState> zs = pickZones(a.data.zones, w);
    int pages = zonePages(int(zs.size()));
    int page = std::min(sub, pages - 1);
    int from = page * kPerPage, to = std::min(int(zs.size()), from + kPerPage);
    int total = int(zs.size()), heating = 0;
    for (auto& z : zs) heating += z.heating();
    std::string range = pages > 1 ? a.t(S::roomsRange, std::to_string(from + 1) + "–" + std::to_string(to), std::to_string(total))
                                  : a.t(S::nRooms, std::to_string(total));
    std::string summary = range + " · " + a.t(S::nHeating, std::to_string(heating)) + (a.data.away ? std::string(" · ") + a.t(S::away) : "");
    bool away = a.data.away, awayOk = a.data.awayOk();   // #148: no away pill when no zone offers the preset
    out.push_back({"h" + ti, hdr, [&a, hdr, summary, away, awayOk](Canvas& c) {
      Font pf = T7(15);
      int bw = awayOk ? textPill(c, hdr.x + hdr.w, hdr.y + 24, a.t(away ? S::setHome : S::setAway), pf, 18, true, false, [&a] { a.toggleAway(); }) : 0;
      TextOpts t; t.maxW = hdr.w - bw - 12;
      c.text(hdr.x, centreBl(hdr.y + 24, D(22)), summary, D(22), t);
    }});
    // room cards: 5 x 2, gap 8, row order
    int gtop = hdr.y + 48 + 8, gh = r.y + r.h - gtop;
    for (int k = from; k < to; ++k) {
      int j = k - from, col = j % 5, row = j / 5;
      int cx0 = r.x + int(std::lround(col * (r.w + 8) / 5.0)), cx1 = r.x + int(std::lround((col + 1) * (r.w + 8) / 5.0)) - 8;
      int cy0 = gtop + row * (gh + 8) / 2, cy1 = gtop + (row + 1) * (gh + 8) / 2 - 8;
      Rect rr = rc(cx0, cy0, cx1 - cx0, cy1 - cy0);
      ZoneState z = zs[k];
      out.push_back({"z:" + z.id, rr, [&a, z, rr](Canvas& c) {
        bool heat = z.heating();
        if (heat) c.box(rr, 16, Ink::Black);
        else c.tone(rr, 16, Tone::Surf);
        Ink fg = heat ? Ink::Paper : Ink::Black;
        int x0 = rr.x + 10, x1 = rr.x + rr.w - 10;
        Font nf = T6(15);
        TextOpts no = C(fg); no.maxW = x1 - x0 - (heat ? 19 : 0);
        c.text(x0, rr.y + 10 + asc(nf), fitKeepTail(z.name, no.maxW, [&c, nf](const std::string& s) { return c.textWidth(s, nf); }), nf, no);
        if (heat) c.icon(Icon::SkFlame16, x1 - 16, rr.y + 10 + (lineH(nf) - 16) / 2, Ink::Paper);
        int by = rr.y + rr.h - 8 - 44;
        int bw = (rr.w - 20 - 6) / 2;
        std::string id = z.id;
        pillBtn(c, rc(x0, by, bw, 44), false, Ink::Paper, [&a, id] { a.setZone(id, -0.5); });
        pillBtn(c, rc(x0 + bw + 6, by, rr.w - 20 - 6 - bw, 44), true, Ink::Paper, [&a, id] { a.setZone(id, 0.5); });
        Font vf = D(34);
        int nameBot = rr.y + 10 + lineH(nf);
        int vtop = nameBot + (by - nameBot - vf.size) / 2;
        int bl = baseIn(vtop, vf, vf.size);
        TextOpts vt = C(fg); vt.tabular = true;
        c.text(x0, bl, z.cur.ok ? fmtNum(z.cur.v, "°C") + "°" : "—", vf, vt);
        TextOpts st = C(heat ? Ink::Paper : Ink::Black); st.tabular = true; st.dotted = a.setOverride.count(z.id) > 0;
        c.textRight(x1, bl, z.set.ok ? "→" + fmtNum(z.set.v, "°C") : "—", T7(13), st);
      }});
    }
    return;
  }
  std::vector<LightGroup> groups = pickLights(a.data.lightGroups, w);
  auto pages = layoutLights(groups);
  int shown = 0, lit = 0;
  for (auto& g : groups) for (auto& id : g.ids) if (const LightState* l = a.data.light(id)) { ++shown; lit += l->on; }
  std::string summary = a.t(S::lightsOnOf, std::to_string(lit), std::to_string(shown));
  out.push_back({"h" + ti, hdr, [&a, hdr, summary](Canvas& c) {
    int bw = textPill(c, hdr.x + hdr.w, hdr.y + 24, a.t(S::allLightsOff), T7(15), 18, true, false, [&a] { a.allOff(); });
    TextOpts t; t.maxW = hdr.w - bw - 12;
    c.text(hdr.x, centreBl(hdr.y + 24, D(22)), summary, D(22), t);
  }});
  if (pages.empty()) return;
  const LightPage& page = pages[std::min(sub, int(pages.size()) - 1)];
  int gtop = hdr.y + 48 + 6, gh = r.y + r.h - gtop;
  int colW = (r.w - 24) / 2;
  for (int j = 0; j < int(page.size()); ++j) {
    const LightCell& it = page[j];
    if (it.kind == LightCell::Spacer) continue;
    int col = j / kPerCol, row = j % kPerCol;
    int y0 = gtop + row * (gh + 6) / kPerCol, y1 = gtop + (row + 1) * (gh + 6) / kPerCol - 6;
    Rect rr = rc(r.x + col * (colW + 24), y0, colW, y1 - y0);
    if (it.kind == LightCell::Header) {
      LightCell cell = it;
      std::vector<std::string> ids;
      for (auto& g : groups) if (g.area == it.area) ids = g.ids;
      out.push_back({"r:" + it.area + (it.cont ? ":c" : ""), rr, [&a, cell, ids, rr](Canvas& c) {
        int on = 0, n = 0;
        for (auto& id : ids) if (const LightState* l = a.data.light(id)) { ++n; on += l->on; }
        std::string room = (a.data.areaNames.count(cell.area) ? a.data.areaNames.at(cell.area) : cell.area) + (cell.cont ? " (cont.)" : "");
        std::string area = cell.area;
        int cy = rr.y + rr.h / 2;
        int bw = textPill(c, rr.x + rr.w, cy, a.t(on ? S::allOff : S::allOn), T7(14), 14, false, true, [&a, area, ids] { a.roomLights(area, ids); });
        Font rf = D(20), cf = T4(14);
        int bl = rr.y + rr.h - 6 - (lineH(rf) - asc(rf));
        TextOpts ro; ro.maxW = rr.w - bw - 100;
        int w = c.text(rr.x, bl, room, rf, ro);
        TextOpts co = C(Ink::Black); co.maxW = rr.w - bw - w - 16;
        c.text(rr.x + w + 8, bl, a.t(S::onOf, std::to_string(on), std::to_string(n)), cf, co);
      }});
    } else {
      const LightState* l = a.data.light(it.id);
      if (!l) continue;
      LightState ls = *l;
      out.push_back({"l:" + it.id, rr, [&a, ls, rr](Canvas& c) {
        int cy = rr.y + rr.h / 2;
        int ctrlW = ls.dim ? 44 + 8 + 44 : 96;
        Rect cap = rc(rr.x, cy - 26, rr.w - ctrlW - 8, 52);
        if (ls.on) c.box(cap, 26, Ink::Black);
        else c.tone(cap, 26, Tone::Surf);
        Ink fg = ls.on ? Ink::Paper : Ink::Black;
        c.circle(cap.x + 8 + 18, cy, 18, Ink::Paper);
        c.icon(Icon::SkBulb18, cap.x + 8 + 9, cy - 9, Ink::Black);
        std::string v = ls.on ? (ls.dim ? std::to_string(ls.pct) + "%" : a.t(S::on)) : a.t(S::off);
        Font vf = D(18), nf = T6(17);
        TextOpts vt = C(fg); vt.tabular = true;
        int vw = c.textWidth(v, vf, vt);
        c.text(cap.x + cap.w - 16 - vw, centreBl(cy, vf), v, vf, vt);
        TextOpts nt = C(fg); nt.maxW = cap.w - 16 - vw - 10 - (8 + 36 + 10);
        c.text(cap.x + 8 + 36 + 10, centreBl(cy, nf), ls.name, nf, nt);
        if (ls.on) {
          Rect tr = rc(cap.x + 52, cap.y + cap.h - 7 - 3, cap.w - 52 - 18, 3);
          c.tone(tr, 1, Tone::Hatch);
          int fw = tr.w * std::max(0, std::min(100, ls.dim ? ls.pct : 100)) / 100;
          if (fw > 0) c.box(rc(tr.x, tr.y, fw, 3), 1, Ink::Paper);
        }
        std::string id = ls.id;
        c.hit(cap, [&a, id] { a.toggleLight(id); });
        int right = rr.x + rr.w;
        if (ls.dim) {
          circleBtn(c, right - ctrlW + 22, cy, 44, false, true, false, [&a, id] { a.dimLight(id, -10); });
          circleBtn(c, right - 22, cy, 44, false, true, true, [&a, id] { a.dimLight(id, 10); });
        } else {
          c.textCenter(right - 48, centreBl(cy, T4(13)), a.t(S::onOffOnly), T4(13), C(Ink::Black));
        }
      }});
    }
  }
}

}  // namespace ui
}  // namespace x4
