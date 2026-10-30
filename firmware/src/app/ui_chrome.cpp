// Top bar, app switcher / page overview, boot, quiet, standby, OTA install faces, "needs Home Assistant" card.
// Geometry follows the emulator markup (Main.dc.html lines 50–760).
#include <algorithm>
#include <ctime>
#include "app/app_impl.h"
#include "core/bins.h"
#include "core/catalog.h"
#include "core/empty_house.h"
#include "core/json.h"

namespace x4 {
namespace ui {

int baseline(int top, Font f, double lineH) {
  const FontData* d = resolveFont(f);
  int A = d ? d->ascent : f.size, D = d ? d->descent : f.size / 4;
  return top + int((lineH * f.size - (A + D)) / 2.0 + 0.5) + A;
}
// baseline that vertically centres capitals in [top, top+h)
static int mid(int top, int h, Font f) { int ch = Canvas::capHeight(f); return top + (h - ch) / 2 + ch; }

// Sleek (screens that keep the Classic layout, reference/sleek-fallback.css): borderless surface cards with a 20 px
// radius, paper-filled pills and circles instead of outlined buttons, sentence-case labels, 1 px light dividers.
void tileFrame(Canvas& c, Rect r, bool ghost) {
  if (sleek()) { if (ghost) c.dashedFrame(r, 2, Ink::Black, 20, 2, 2); else c.tone(r, 20, Tone::Surf); return; }
  if (ghost) c.dashedFrame(r, 2, Ink::Black, 10, 2, 2);
  else c.box(r, 10, Ink::Paper, 2, Ink::Black);
}

void rule(Canvas& c, int x, int y, int len, bool vertical) {
  if (sleek()) { if (vertical) c.dottedVLine(x, y, len, 1, Ink::Black); else c.dottedHLine(x, y, len, 1, Ink::Black); return; }
  if (vertical) c.vline(x, y, len, 2, Ink::Black); else c.hline(x, y, len, 2, Ink::Black);
}

void btnBox(Canvas& c, Rect r, bool dark, int radius) {
  if (sleek()) c.box(r, r.h / 2, dark ? Ink::Black : Ink::Paper);
  else c.box(r, radius, dark ? Ink::Black : Ink::Paper, 2, Ink::Black);
}

void button(Canvas& c, Rect r, const std::string& label, Font f, bool dark, std::function<void()> fn, int radius) {
  btnBox(c, r, dark, radius);
  TextOpts o = C(dark ? Ink::Paper : Ink::Black); o.maxW = r.w - 8;
  c.textCenter(r.x + r.w / 2, mid(r.y, r.h, f), label, f, o);
  if (fn) c.hit(r, std::move(fn));
}

void roundButton(Canvas& c, int cx, int cy, int d, const std::string& label, int size, std::function<void()> fn) {
  if (sleek()) c.circle(cx, cy, d / 2, Ink::Paper);
  else c.circle(cx, cy, d / 2, Ink::Paper, 2, Ink::Black);
  // − and + drawn as bars (crisper than glyphs at this size)
  int len = size / 2 + 1, th = std::max(2, size / 9);
  c.fill(rc(cx - len / 2, cy - th / 2, len, th), Ink::Black);
  if (label == "+") c.fill(rc(cx - th / 2, cy - len / 2, th, len), Ink::Black);
  if (fn) c.hit(rc(cx - d / 2, cy - d / 2, d, d), std::move(fn));
}

void label(Canvas& c, int x, int top, const std::string& s, int size, Ink ink, int maxW) {
  if (sleek()) { TextOpts o = C(ink); o.maxW = maxW; c.text(x, baseline(top, T6(size), 1.2), s, T6(size), o); return; }
  TextOpts o = C(ink); o.upper = true; o.tracking = size >= 20 ? 0 : 1; o.maxW = maxW;   // eink-ha-os#199: B20 labels untracked
  c.text(x, baseline(top, B(size), 1.2), s, B(size), o);
}

void kvRow(Canvas& c, int x, int top, int w, const std::string& k, const std::string& v, int size, int padBottom) {
  int bl = baseline(top, R(size), 1.2);
  int kw = c.text(x, bl, k, R(size), C(Ink::Black));
  TextOpts o; o.maxW = w - kw - 8;
  c.textRight(x + w, bl, v, B(size), o);
  c.dottedHLine(x, top + int(size * 1.2) + padBottom, w, 1, Ink::Black);
}

// ---------------- top bar ----------------
// The top-bar clock is its own region "time" (issue eink-ha-os#38): fixed "00:00" width, right-aligned against the pager, so the
// minute tick redraws only this box instead of the whole bar. Ambient (eink-ha-os#27): no pager, so it moves to the right edge.
Rect barTimeRect(I& a) {
  if (sleek()) return sleekBarTimeRect(a);
  TextOpts ct; ct.tabular = true;
  int right = a.chr.pager ? kScreenW - 6 - kZonePager - 12 : kScreenW - 6, w = Canvas().textWidth("00:00", B(22), ct);
  if (!a.asleepAt.empty()) w = Canvas().textWidth(a.t(S::asleepBar), B(18));   // eink-ha-os#299, eink-ha-os#333: no time of day
  return rc(right - w, 8, w, 40);
}
void barTime(Canvas& c, I& a) {
  if (sleek()) { sleekBarTime(c, a); return; }
  Rect r = barTimeRect(a);
  if (!a.asleepAt.empty()) { c.textRight(r.x + r.w, 35, a.t(S::asleepBar), B(18)); return; }   // eink-ha-os#299: not live
  TextOpts ct; ct.tabular = true;
  c.textRight(r.x + r.w, 37, a.now.clock, B(22), ct);
}

void topBar(Canvas& c, I& a) {
  if (sleek()) { sleekTopBar(c, a); return; }
  c.hline(0, kTopBarH, kScreenW, kTopRule, Ink::Black);
  // zone 1: app + page (232 px)
  Rect z1 = rc(6, 3, kZoneApp, 50);
  bool setup = a.setup != Setup::None;
  std::string appTitle = setup ? a.t(S::setup) : a.appTitle(a.appOf());
  const Screen* sc = a.curScreen();
  // setup (eink-ha-os#183): "Step 2 of 2" as the title, no pager (app.cpp)
  std::string pageTitle = setup ? a.t(S::setupStep, a.setup == Setup::Wifi ? "1" : "2", "2")
      : a.menu == Menu::Apps ? a.t(S::allApps) : a.menu == Menu::Pages ? a.t(S::allPages) : (sc ? sc->title : "");
  int x = z1.x + 8;
  int y1 = z1.y + 7;
  if (a.chr.app) {
    // grid glyph (4 rounded squares, 12 px), centred on the B20 caps (eink-ha-os#199)
    for (int k = 0; k < 4; ++k) c.box(rc(x + (k % 2) * 7, y1 + 3 + (k / 2) * 7, 5, 5), 1, Ink::Black);
    TextOpts up; up.upper = true; up.tracking = 1; up.maxW = z1.w - 16 - 17 - 17;
    int tw = c.text(x + 17, y1 + 15, appTitle, B(20), up);
    c.icon(a.menu == Menu::Apps ? Icon::ChevUp12 : Icon::ChevDown12, x + 17 + tw + 5, y1 + 3);
  }
  int nSub = sc && !setup ? subPages(*sc, a.paging()) : 1;
  bool hasSub = !setup && a.menu == Menu::None && nSub > 1 && a.chr.app;
  std::string subText = hasSub ? a.t(S::ofN, std::to_string(a.curSub() + 1), std::to_string(nSub)) : "";
  int subW = hasSub ? c.textWidth(subText, B(18)) + 6 : 0;
  TextOpts tt; tt.maxW = z1.w - 16 - subW;
  int tb = a.chr.app ? y1 + 37 : baseline(z1.y + int((z1.h - 21 * 1.15) / 2), B(21), 1.15);   // ambient: title alone, centred
  int pw = c.text(x, tb, pageTitle, B(21), tt);
  if (hasSub) c.text(x + pw + 6, tb, subText, B(18), C(Ink::Black));
  if (!setup) c.hit(z1, [&a] { a.setMenu(Menu::Apps, "TOUCH app title"); });

  // zone 3: pager (176 px); none in ambient
  Rect pg = rc(kScreenW - 6 - kZonePager, 6, kZonePager, 44);
  if (a.chr.pager) {
    bool pagesOpen = a.menu == Menu::Pages;
    c.box(pg, 8, Ink::Paper, 2, Ink::Black);
    if (pagesOpen) c.box(rc(pg.x + 56, pg.y + 2, pg.w - 112, pg.h - 4), 0, Ink::Black);
    c.vline(pg.x + 56, pg.y, pg.h, 2, Ink::Black);
    c.vline(pg.x + pg.w - 58, pg.y, pg.h, 2, Ink::Black);
    c.icon(Icon::ChevLeft22, pg.x + 17, pg.y + 11);
    c.icon(Icon::ChevRight22, pg.x + pg.w - 39, pg.y + 11);
    std::string pageText;
    if (a.menu != Menu::Apps) {   // app switcher open: no page position (eink-ha-os#151)
      auto f = flatPages(a.cfg, a.idx, a.paging());
      int pos = 0, cs = a.curSub();
      for (int i = 0; i < int(f.size()); ++i) if (f[i].screen == a.idx && f[i].sub == cs) pos = i;
      pageText = std::to_string(pos + 1) + " / " + std::to_string(f.size());
  }
  Ink pf = pagesOpen ? Ink::Paper : Ink::Black;
  TextOpts pt = C(pf); pt.tabular = true;
  int cx = pg.x + pg.w / 2;
  c.textCenter(cx, pg.y + 25, pageText, B(18), pt);
  for (int k = -1; k <= 1; ++k) c.fill(rc(cx - 2 + k * 6, pg.y + 30, 4, 4), pf);
  c.hit(rc(pg.x, pg.y - 6, 56, 56), [&a] { a.nav(-1, "TOUCH ‹"); });
  c.hit(rc(pg.x + pg.w - 56, pg.y - 6, 56, 56), [&a] { a.nav(1, "TOUCH ›"); });
  if (!setup) c.hit(rc(pg.x + 58, pg.y, pg.w - 116, pg.h), [&a] { a.setMenu(Menu::Pages, "TOUCH page count"); });
  }

  // zone 2: status icons, battery, clock (region "time", barTime) — right-aligned against the pager. Ambient: the
  // status icons always stay (information), the battery only when low, the clock only without a clock tile.
  Rect tr = barTimeRect(a);
  int right = a.chr.clock ? tr.x - 10 : tr.x + tr.w;
  int batt = a.board.power().batteryPct;
  if (a.chr.battery) {
    // battery 26×13 + nub
    int bx = right - 29, by = 22;
    c.frame(rc(bx, by, 26, 13), 2, Ink::Black, 3);
    c.fill(rc(bx + 3, by + 3, std::max(0, (20 * batt + 50) / 100), 7), Ink::Black);
    c.fill(rc(bx + 26, by + 3, 3, 6), Ink::Black);
    right = bx - 4;
    if (batt < kBattLow) { std::string t = std::to_string(batt) + "%"; int w = c.textWidth(t, B(18)); c.text(right - w, 35, t, B(18)); right -= w; }
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
    for (auto it = icons.rbegin(); it != icons.rend(); ++it) {
      // HA unreachable (eink-ha-os#86): "since 14:05" (the last data) right of the icon; the tiles keep their last values
      if (*it == Icon::StatusOffline && st.haLastDataEpoch > 0) {
        time_t t = time_t(st.haLastDataEpoch); struct tm tm; localtime_r(&t, &tm);
        std::string since = a.t(S::since, pad2(tm.tm_hour) + ":" + pad2(tm.tm_min));
        right -= c.textWidth(since, R(18)); c.text(right, 35, since, R(18)); right -= 6;
      }
      right -= 20; c.icon(*it, right, 18); right -= 10;
    }
  }
}

// ---------------- app switcher / page overview ----------------
void menu(Canvas& c, I& a, Rect r) {
  int x0 = r.x + 14, y0 = r.y + 14, w = r.w - 28;
  std::string heading;
  auto f = flatPages(a.cfg, a.idx, a.paging());
  if (a.menu == Menu::Apps) heading = a.t(S::apps);
  else heading = a.appTitle(a.appOf()) + " · " + a.t(S::nPages, std::to_string(f.size()));
  TextOpts ho = C(Ink::Black); ho.upper = !sleek(); ho.tracking = sleek() ? 0 : 1;
  c.text(x0, baseline(y0, B(20), 1.2), heading, B(20), ho);
  int gy = y0 + 24 + 10, cw = (w - 3 * 12) / 4, ch = 132;
  struct Item { std::string title, desc, pages, num; Icon icon; bool hasIcon; bool cur; std::function<void()> go; };
  std::vector<Item> items;
  if (a.menu == Menu::Apps) {
    // built-in apps keep their icon + description; custom apps show their number
    static const char* builtin[] = {"home", "house", "travel", "settings"};
    static const Icon icons[] = {Icon::AppHome, Icon::AppHouse, Icon::AppTravel, Icon::AppSettings};
    int k = 0;
    for (auto& ap : a.appList()) {
      int first = firstScreenOfApp(a.cfg, ap.id);
      int n = first >= 0 ? int(flatPages(a.cfg, first, a.paging()).size()) : 0;
      std::string id = ap.id;
      int b = -1;
      for (int q = 0; q < 4; ++q) if (ap.id == builtin[q]) b = q;
      const AppDef* def = b >= 0 ? findApp(ap.id) : nullptr;
      ++k;
      items.push_back({ap.title, def ? a.t(def->desc) : "", n == 1 ? std::string(a.t(S::page1)) : a.t(S::nPages, std::to_string(n)), std::to_string(k),
                       b >= 0 ? icons[b] : Icon::AppHome, b >= 0, ap.id == a.appOf(), [&a, id] { a.openApp(id); }});
    }
  } else {
    int cs = a.curSub();
    for (int k = 0; k < int(f.size()); ++k) {
      const Screen& x = a.cfg.screens[f[k].screen];
      int n = subPages(x, a.paging());
      int si = f[k].screen, q = f[k].sub;
      items.push_back({x.title, x.widgets.size() == 1 ? std::string(a.t(S::widget1)) : a.t(S::nWidgets, std::to_string(x.widgets.size())),
                       n > 1 ? a.t(S::partOf, std::to_string(q + 1), std::to_string(n)) : "", std::to_string(k + 1),
                       Icon::AppHome, false, si == a.idx && q == cs, [&a, si, q] { a.openPage(si, q); }});
    }
  }
  for (int k = 0; k < int(items.size()); ++k) {
    int col = k % 4, row = k / 4;
    Rect b = rc(x0 + col * (cw + 12), gy + row * (ch + 12), cw, ch);
    if (b.y + b.h > r.y + r.h) break;
    auto& it = items[k];
    if (sleek()) { c.tone(b, 20, Tone::Surf); if (it.cur) c.frame(b, 3, Ink::Black, 20); }
    else c.box(b, 10, Ink::Paper, it.cur ? 4 : 2, Ink::Black);
    if (it.hasIcon) c.icon(it.icon, b.x + 14, b.y + 12);
    else c.text(b.x + 14, b.y + 12 + 20, it.num, B(20), C(Ink::Black));
    if (!it.pages.empty()) c.textRight(b.x + b.w - 14, b.y + 12 + 20, it.pages, B(20), C(Ink::Black));
    // eink-ha-os#199: title B26 up to 2 lines, the R18 description below it up to 2 lines; together at most 3 (ellipsis),
    // bottom-aligned ("Overview, prices, energy, solar" no longer cut after "prices,")
    Canvas m(nullptr);
    int lines = std::max(1, m.paragraph(0, 0, b.w - 28, 30, it.title, B(26), TextOpts(), 2));
    int dl = it.desc.empty() ? 0 : std::max(1, m.paragraph(0, 0, b.w - 28, 22, it.desc, R(18), TextOpts(), 3 - lines));
    int bottom = b.y + b.h - 10;
    c.paragraph(b.x + 14, bottom - dl * 22 - 2 - lines * 30, b.w - 28, 30, it.title, B(26), TextOpts(), 2);
    if (dl) c.paragraph(b.x + 14, bottom - dl * 22, b.w - 28, 22, it.desc, R(18), C(Ink::Black), dl);
    c.hit(b, it.go);
  }
}

// ---------------- faces ----------------
void bootFace(Canvas& c, I& a) {
  int cy = kScreenH / 2;
  c.icon(Icon::BootHome64, kScreenW / 2 - 32, cy - 32 - 18 - 53);
  TextOpts t; t.tracking = 0;
  c.textCenter(kScreenW / 2, cy + 22, "HA Paper", B(44), t);
  c.textCenter(kScreenW / 2, cy + 22 + 18 + 26, a.bootMsg, R(18), C(Ink::G1));
}

// Power held 2 s (eink-ha-os#258): the boot-face layout; the panel keeps it while the board is off
void offFace(Canvas& c, I& a) {
  int cy = kScreenH / 2;
  c.icon(Icon::BootHome64, kScreenW / 2 - 32, cy - 32 - 18 - 53);
  TextOpts t; t.tracking = 0;
  c.textCenter(kScreenW / 2, cy + 22, a.t(S::offTitle), B(44), t);
  c.textCenter(kScreenW / 2, cy + 22 + 18 + 26, a.t(S::offHint), R(18), C(Ink::G1));
}

static int boldPair(Canvas& c, int x, int bl, const std::string& k, const std::string& v, int size) {
  int w = c.text(x, bl, k + " ", R(size));
  return w + c.text(x + w, bl, v, B(size));
}
static int pairW(Canvas& c, const std::string& k, const std::string& v, int size) { return c.textWidth(k + " ", R(size)) + c.textWidth(v, B(size)); }

// Standby: the big clock is region "time" (faceTime), the rest of the face only changes with the data.
static const int kStandbyTop = 112;
static TextOpts faceClockOpts() { TextOpts ct; ct.tracking = -7; ct.tabular = true; return ct; }
static int faceBl(I&) { return kStandbyTop + 108; }

Rect faceTimeRect(I& a) {
  int w = Canvas().textWidth("00:00", B(150), faceClockOpts()) + 16, ch = Canvas::capHeight(B(150)), bl = faceBl(a);
  return rc(kScreenW / 2 - w / 2, bl - ch - 6, w, ch + 12);
}
void faceTime(Canvas& c, I& a) {
  c.textCenter(kScreenW / 2, faceBl(a), a.asleepAt.empty() ? a.now.clock : a.now.day, B(150), faceClockOpts());   // eink-ha-os#333
}

// eink-ha-os#199: stats at 26 px (names R26, values B26), date B28, footer R18. Standby (4 stats) is a centred 2×2 grid.
static const int kFaceStatGap = 40, kFaceRowH = 36;
static void bigClockFace(Canvas& c, I& a, int top, const std::vector<std::pair<std::string, std::string>>& stats, const std::string& foot,
                         bool grid) {
  int bl = top + 108;
  c.textCenter(kScreenW / 2, bl + 20 + 28, a.asleepAt.empty() ? a.now.date : a.now.dayLine, B(28));
  int sb = bl + 48 + 22 + 30, n = int(stats.size());
  std::vector<int> wd;
  for (auto& s : stats) wd.push_back(pairW(c, s.first, s.second, 26));
  if (grid) {   // two columns, each as wide as its widest pair, the block centred
    int c0 = 0, c1 = 0;
    for (int i = 0; i < n; ++i) (i % 2 ? c1 : c0) = std::max(i % 2 ? c1 : c0, wd[i]);
    int x0 = kScreenW / 2 - (c0 + kFaceStatGap + c1) / 2;
    for (int i = 0; i < n; ++i) boldPair(c, x0 + (i % 2) * (c0 + kFaceStatGap), sb + (i / 2) * kFaceRowH, stats[i].first, stats[i].second, 26);
    sb += ((n + 1) / 2 - 1) * kFaceRowH;
  } else {
    for (int i = 0; i < n;) {
      int j = i, row = wd[i];
      while (j + 1 < n && row + kFaceStatGap + wd[j + 1] <= kScreenW - 40) row += kFaceStatGap + wd[++j];
      int x = kScreenW / 2 - row / 2;
      for (int k = i; k <= j; ++k) x += boldPair(c, x, sb, stats[k].first, stats[k].second, 26) + kFaceStatGap;
      i = j + 1;
      if (i < n) sb += kFaceRowH;
    }
  }
  c.textCenter(kScreenW / 2, sb + 12 + 26, foot, R(18), C(Ink::Black));
}

// The Tomorrow / Today row (eink-ha-os#328, core/tomorrow.h) from the first weather, agenda and bins tiles' data; endHour: the
// quiet window's end (Tomorrow after it) or quiet::kTodayEnd (the glance face, eink-ha-os#356).
quiet::Row quietRow(I& a, int endHour) {
  const auto& scs = a.cfg.screens;
  const quiet::Sources src = quiet::sources(scs);
  auto tile = [&](const quiet::Ref& r) -> const Widget* { return r.screen < 0 ? nullptr : &scs[size_t(r.screen)].widgets[size_t(r.widget)]; };
  quiet::In in;
  in.now = a.now.epochMs; in.tz = a.now.tz; in.lang = a.lang; in.endHour = endHour;
  if (const Widget* w = tile(src.weather)) in.fc = a.wxOf(w->field("entity"));
  if (const Widget* w = tile(src.agenda)) {
    const auto* slot = a.agendaOf(agenda::keyOf(w->field("entities")));
    if (slot && slot->state == agenda::State::Ok) in.events = &slot->f;
  }
  std::vector<quiet::BinDay> days;
  if (const Widget* w = tile(src.bins)) {
    for (auto& b : bins::inputs(w->field("entities"), w->field("labels"), a.store)) days.push_back({b.label, bins::days(b.v, in.now, in.tz)});
    in.bins = &days;
    in.tonight = bins::tonightHour(w->field("tonight"));
  }
  return quiet::tomorrow(in);
}

std::string staleAt(I& a) {
  const int64_t last = a.svc.status().haLastDataEpoch;
  if (!nightStale(a.board.epochSeconds(), last)) return "";
  time_t tt = time_t(last); struct tm tm; localtime_r(&tt, &tm);
  return pad2(tm.tm_hour) + ":" + pad2(tm.tm_min);
}

namespace {
// One sleep face (eink-ha-os#356, emulator Device.tsx SLEEP FACE): no clock (a deep-sleeping panel would keep a wrong time). A
// 52 px title, a 28 px line under it, then either the Tomorrow / Today row (a head, one centred line per item: a 44 px
// weather drawing, the bold part, the text) or facts wrapping into centred rows, and an 18 px footer.
struct SleepFace {
  std::string title, sub;
  const quiet::Row* row = nullptr;
  std::vector<std::pair<std::string, std::string>> facts;   // label, bold value
  std::string foot;
};

void sleepFace(Canvas& c, const SleepFace& f) {
  static const quiet::Row kNoRow;
  const quiet::Row& row = f.row ? *f.row : kNoRow;
  const int n = int(row.items.size()), maxW = kScreenW - 40;
  std::vector<std::pair<int, int>> lines;   // [first, last] fact index per line
  std::vector<int> lw;
  for (int i = 0, m = int(f.facts.size()); i < m;) {
    auto pw = [&](int k) { return pairW(c, f.facts[size_t(k)].first, f.facts[size_t(k)].second, 26); };
    int j = i, w = pw(i);
    while (j + 1 < m && w + kFaceStatGap + pw(j + 1) <= maxW) w += kFaceStatGap + pw(j + 1), ++j;
    lines.push_back({i, j}), lw.push_back(w);
    i = j + 1;
  }
  const int nl = int(lines.size());
  // flex column, gap 10: title 52, sub 34, row (margin 22, head 22, then gap 10 + 44 px per item) or facts (margin 22,
  // 31 px lines, gap 10), footer (margin 10, 22)
  const int h = 52 + 10 + 34 + (n ? 10 + 22 + 22 + n * (10 + 44) : 0) + (nl ? 10 + 22 + nl * 31 + (nl - 1) * 10 : 0) +
                (f.foot.empty() ? 0 : 10 + 10 + 22);
  int y = (kScreenH - h) / 2;
  c.textCenter(kScreenW / 2, baseline(y, B(52), 1.0), f.title, B(52));
  y += 52 + 10;
  c.textCenter(kScreenW / 2, baseline(y, B(28), 1.2), f.sub, B(28));
  y += 34;
  if (n) {
    y += 10 + 22;
    c.textCenter(kScreenW / 2, baseline(y, R(18), 1.2), row.head, R(18));
    y += 22;
  }
  for (const auto& it : row.items) {
    y += 10;
    const std::string rest = it.text.empty() ? std::string() : " " + it.text;
    const int iw = it.icon >= 0 ? 44 + 10 : 0, bw = c.textWidth(it.bold, B(26));
    const int w = std::min(maxW, iw + bw + (rest.empty() ? 0 : c.textWidth(rest, R(26))));
    int x = kScreenW / 2 - w / 2;
    if (it.icon >= 0) c.icon(Icon(int(Icon::WxSun44) + it.icon), x, y, Ink::Black);
    x += iw;
    const int bl = baseline(y + 6, B(26), 1.2);
    TextOpts o; o.maxW = maxW - iw;
    x += c.text(x, bl, it.bold, B(26), o);
    if (!rest.empty()) { o.maxW = std::max(0, w - iw - bw); if (o.maxW > 0) c.text(x, bl, rest, R(26), o); }
    y += 44;
  }
  if (nl) y += 10 + 22;
  for (int k = 0; k < nl; ++k) {
    int x = kScreenW / 2 - lw[size_t(k)] / 2, bl = baseline(y, B(26), 1.2);
    for (int i = lines[size_t(k)].first; i <= lines[size_t(k)].second; ++i)
      x += boldPair(c, x, bl, f.facts[size_t(i)].first, f.facts[size_t(i)].second, 26) + kFaceStatGap;
    y += 31 + (k + 1 < nl ? 10 : 0);
  }
  if (!f.foot.empty()) c.textCenter(kScreenW / 2, baseline(y + 10 + 10, R(18), 1.2), f.foot, R(18), C(Ink::Black));
}
}  // namespace

// Quiet face (eink-ha-os#295): "Back at 07:00", the date, the "Tomorrow" row (eink-ha-os#328) built when the face went up, "as of HH:MM"
// only when the data was stale.
void quietFace(Canvas& c, I& a) {
  SleepFace f;
  f.title = a.t(S::quietBack, quietBackAt(a.set.quiet, a.set.clock));
  f.sub = a.now.date;
  f.row = &a.snap.row;
  if (!a.snap.asOf.empty()) f.foot = a.t(S::asOf, a.snap.asOf);
  sleepFace(c, f);
}

// Nobody home face (eink-ha-os#331): "Nobody home", "Next update ~16:05", up to three facts (inside temperature, doors / windows,
// alarm; a fact without a source is dropped), no "Updated" (eink-ha-os#333). Doors and the alarm come from the entities the
// display watches (a door or alarm tile on some screen).
void emptyFace(Canvas& c, I& a) {
  std::vector<FactEntity> ents;
  for (auto& kv : a.store.all()) {
    const std::string& id = kv.first;
    if (id.rfind("binary_sensor.", 0) != 0 && id.rfind("alarm_control_panel.", 0) != 0) continue;
    auto dc = kv.second.attrs.find("device_class");
    ents.push_back({id, friendlyName(id, &kv.second), std::string(kv.second.state.c_str()),
                    dc == kv.second.attrs.end() ? std::string() : std::string(dc->second.c_str())});
  }
  const HouseFacts h = houseFacts(a.data.inside.ok, a.data.inside.v, std::move(ents));
  SleepFace f;
  if (h.hasInside) f.facts.push_back({a.t(S::inside), fmtNum(h.inside, "°C") + "°"});
  if (h.hasOpen) {
    if (h.open == 1) f.facts.push_back({h.firstOpen, a.t(S::factOpen)});
    else f.facts.push_back({a.t(S::factDoors), h.open ? a.t(S::factNOpen, std::to_string(h.open)) : std::string(a.t(S::factClosed))});
  }
  if (h.alarm != Alarm::None)
    f.facts.push_back({a.t(S::factAlarm), a.t(h.alarm == Alarm::Armed ? S::alarmArmed : h.alarm == Alarm::Triggered ? S::alarmTriggered : S::alarmOff)});
  f.title = a.t(S::emptyTitle);
  f.sub = a.t(S::emptyNext, emptyNextAt(a.now.h * 3600 + a.now.m * 60, a.set.quiet, a.set.clock));
  sleepFace(c, f);
}

// Glance sleep face (eink-ha-os#356): "Asleep · press to wake", the date, the "Today" row (values that stay true until the next
// timer wake), "as of HH:MM" only when the data was stale. Built at each render: a glance wake compares its signature.
void glanceFace(Canvas& c, I& a) {
  SleepFace f;
  f.title = a.t(S::sleepHead);
  f.sub = a.now.date;
  const quiet::Row row = quietRow(a, quiet::kTodayEnd);
  f.row = &row;
  const std::string at = staleAt(a);
  if (!at.empty()) f.foot = a.t(S::asOf, at);
  sleepFace(c, f);
}

void standbyFace(Canvas& c, I& a) {
  bool never = a.neverLinked();
  const HomeData& d = a.data;
  std::string solar = "—", batt = "—", price = "—", heat = "—";
  if (!never) {
    if (d.solar.ok) { auto k = kw(d.solar.v); solar = k.v + " " + k.u; }
    if (d.soc.ok) batt = jsNumber(jsRound(d.soc.v)) + "%";
    if (d.prices.size() >= 24 && a.now.known) price = locale::money(d.priceAt(a.now.h, a.now.m));
    if (!d.zones.empty()) heat = a.t(S::nRooms, std::to_string(d.heatingCount()));
  }
  std::string upd = "—";
  int64_t e = a.svc.status().haLastDataEpoch;
  if (e > 0) { time_t t = time_t(e); struct tm tm; localtime_r(&t, &tm); upd = pad2(tm.tm_hour) + ":" + pad2(tm.tm_min); }
  bigClockFace(c, a, kStandbyTop, {{a.t(S::solar), solar}, {a.t(S::battery), batt}, {a.t(S::price), price}, {a.t(S::heating), heat}},
               a.asleepAt.empty() ? a.t(S::standbyFoot, upd) : std::string(a.t(S::asleepFoot)), true);
}

void updatingFace(Canvas& c, I& a) {
  auto& st = a.svc.status();
  int pct = std::max(0, std::min(100, st.otaProgressPct / 10 * 10));
  int top = 90;
  c.icon(Icon::Download48, kScreenW / 2 - 24, top);
  c.textCenter(kScreenW / 2, top + 48 + 18 + 34, a.t(S::updatingTo), B(36));
  // eink-ha-os#215: the version on its own line; long git-describe names step down, then lose their middle.
  // eink-ha-os#237: an upload without a version leaves the line out (never a bare "v")
  if (!st.otaAvailableVersion.empty()) {
    FitValue ver = fitMiddle(a.t(S::updVersion, st.otaAvailableVersion), {28, 24, 20, 18}, kScreenW - 80,
                             [&c](const std::string& v, int z) { return c.textWidth(v, B(z)); });
    c.textCenter(kScreenW / 2, top + 48 + 18 + 43 + 34, ver.value, B(ver.size));
  }
  Rect bar = rc(kScreenW / 2 - 260, top + 48 + 18 + 43 + 43 + 18, 520, 26);
  c.frame(bar, 2, Ink::Black, 6);
  c.fill(rc(bar.x + 5, bar.y + 5, (bar.w - 10) * pct / 100, bar.h - 10), Ink::Black);
  std::string step = a.t(st.ota == OtaState::Installing ? (pct >= 100 ? S::updWriting : S::updChecking) : S::updDownloading);
  int sb = bar.y + bar.h + 18 + 18;
  c.text(bar.x, sb, step, B(18));
  TextOpts t; t.tabular = true;
  c.textRight(bar.x + bar.w, sb, std::to_string(pct) + "%", R(18), t);
  c.textCenter(kScreenW / 2, sb + 18 + 22, a.t(S::updKeepOn), R(16), C(Ink::Black));
}

// Factory reset? (hardware keys or a crash loop at boot, core/recovery.h): no touch targets, keys only.
void recoveryFace(Canvas& c, I& a) {
  const bool crash = a.recovery.crash;
  int y = crash ? 160 : 175;
  c.textCenter(kScreenW / 2, y, a.t(crash ? S::recCrashTitle : S::recTitle), B(36));
  y += 40;
  if (crash) { c.textCenter(kScreenW / 2, y, a.t(S::recCrashLine), R(18)); y += 28; }
  c.textCenter(kScreenW / 2, y, a.t(crash ? S::recErasesCrash : S::recErases), R(18));
  y += 50;
  c.textCenter(kScreenW / 2, y, a.t(S::recPress), B(24));
  c.textCenter(kScreenW / 2, y + 34, a.t(S::recAuto), R(16), C(Ink::Black));
}

Rect noHaCardRect(I& a, Rect area, const Screen& sc) {
  // auto height, centred (emulator: 460 px card, padding 22/24, title 24 + text 17 wrap)
  Canvas m(nullptr);
  int w = 460;
  int titleLines = m.paragraph(0, 0, w - 48 - 38, 28, a.t(S::needsHa, sc.title), B(24));
  int lines = m.paragraph(0, 0, w - 48, 24, a.t(noHaText(sc.id)), R(17));
  int h = 22 + titleLines * 28 + 10 + lines * 24 + 14 + 48 + 22;
  return rc(area.x + area.w / 2 - w / 2, area.y + area.h / 2 - h / 2, w, h);
}

void noHaCard(Canvas& c, I& a, Rect card, const Screen& sc) {
  std::string title = a.t(S::needsHa, sc.title);
  std::string text = a.t(noHaText(sc.id));
  Canvas m(nullptr);
  int titleLines = m.paragraph(0, 0, card.w - 48 - 38, 28, title, B(24));
  int lines = m.paragraph(0, 0, card.w - 48, 24, text, R(17));
  c.box(card, sleek() ? 20 : 14, Ink::Paper, sleek() ? 2 : 3, Ink::Black);
  int x = card.x + 24, y = card.y + 22;
  c.icon(Icon::Unlinked28, x, y + (titleLines * 28 - 28) / 2);
  c.paragraph(x + 38, y, card.w - 48 - 38, 28, title, B(24));
  y += titleLines * 28 + 10;
  c.paragraph(x, y, card.w - 48, 24, text, R(17));
  y += lines * 24 + 14;
  Rect b = rc(x, y, c.textWidth(a.t(S::linkHa), B(16)) + 36, 48);
  button(c, b, a.t(S::linkHa), B(16), true, [&a] { a.linkFromCard(); });
  c.text(b.x + b.w + 14, mid(b.y, 48, R(15)), a.t(S::linkHaTime), R(15), C(Ink::Black));
}

std::string qrBase(I& a) {
  auto& st = a.svc.status();
  return "http://" + (st.ip.empty() ? st.hostname : st.ip);
}

std::string hostOrIp(I& a) {
  auto& st = a.svc.status();
  return st.ip.empty() ? st.hostname : a.t(S::hostOr, st.hostname, st.ip);
}

void emptyScreen(Canvas& c, I& a, Rect r) {
  c.dashedFrame(r, 2, Ink::Black, sleek() ? 20 : 10, 2, 2);
  c.textCenter(r.x + r.w / 2, r.y + r.h / 2 - 4, a.t(S::emptyScreen), B(24));
  c.textCenter(r.x + r.w / 2, r.y + r.h / 2 + 26, a.t(S::addWidgetsAt, hostOrIp(a)) + ".", R(17), C(Ink::Black));
}

}  // namespace ui
}  // namespace x4
