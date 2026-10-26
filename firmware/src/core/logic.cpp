#include "core/logic.h"
#include "core/json.h"
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <utility>

namespace x4 {

std::string pad2(int n) { std::string s = std::to_string(n); return s.size() < 2 ? "0" + s : s; }

std::string hhmm(int t) {
  int m = ((t % 1440) + 1440) % 1440;
  return pad2(m / 60) + ":" + pad2(((t % 60) + 60) % 60);
}

static NumFmt gNumFmt = NumFmt::Point;
void setNumFormat(NumFmt f) { gNumFmt = f; }
NumFmt numFormat() { return gNumFmt; }

NumFmt numFormatOf(const std::string& ha, bool dutch) {
  if (ha == "comma_decimal") return NumFmt::CommaDecimal;
  if (ha == "decimal_comma") return NumFmt::DecimalComma;
  if (ha == "space_comma") return NumFmt::SpaceComma;
  if (ha == "none") return NumFmt::Point;
  return dutch ? NumFmt::Comma : NumFmt::Point;
}

std::string localNum(const std::string& s, NumFmt f) {
  if (f == NumFmt::Point) return s;
  size_t dot = s.find('.');
  std::string in = s.substr(0, dot), frac = dot == std::string::npos ? "" : s.substr(dot + 1);
  if (f != NumFmt::Comma) {
    size_t sign = !in.empty() && (in[0] == '-' || in[0] == '+') ? 1 : 0;
    if (in.find_first_not_of("0123456789", sign) == std::string::npos) {
      const char g = f == NumFmt::CommaDecimal ? ',' : f == NumFmt::DecimalComma ? '.' : ' ';
      for (size_t i = in.size(); i > sign + 3; i -= 3) in.insert(i - 3, 1, g);
    }
  }
  if (dot == std::string::npos) return in;
  return in + (f == NumFmt::CommaDecimal ? "." : ",") + frac;
}

std::string fmtNum(double v, const std::string& unit, int dp) {
  static const std::pair<const char*, int> kUnitDp[] = {{"W", 0}, {"kW", 2}, {"kWh", 1}, {"%", 0},
                                                        {"°C", 1}, {"°F", 1}, {"V", 1}, {"A", 1}};
  int d = -1;
  if (dp >= 0) d = std::min(dp, 10);
  else for (auto& u : kUnitDp) if (unit == u.first) { d = u.second; break; }
  std::string s = toFixed(v, d < 0 ? 2 : d);
  if (d < 0 && s.find('.') != std::string::npos) {   // other units: trim trailing zeros
    s.erase(s.find_last_not_of('0') + 1);
    if (s.back() == '.') s.pop_back();
  }
  if (s[0] == '-' && s.find_first_not_of("-0.") == std::string::npos) s.erase(0, 1);   // "-0", "-0.0" → zero
  return localNum(s, gNumFmt);
}

std::string fmtValue(const std::string& state, const std::string& unit, int dp) {
  // plain decimal only: [+-] digits [. digits] [e[+-]digits] (no spaces, hex, inf, nan; same as the emulator's NUM)
  size_t i = 0, n = state.size();
  auto digits = [&]() { size_t s = i; while (i < n && state[i] >= '0' && state[i] <= '9') ++i; return i - s; };
  if (i < n && (state[i] == '+' || state[i] == '-')) ++i;
  size_t m = digits();
  if (i < n && state[i] == '.') { ++i; m += digits(); }
  if (m == 0) return state;
  if (i < n && (state[i] == 'e' || state[i] == 'E')) {
    ++i;
    if (i < n && (state[i] == '+' || state[i] == '-')) ++i;
    if (digits() == 0) return state;
  }
  if (i != n) return state;
  double v = std::strtod(state.c_str(), nullptr);
  return std::isfinite(v) ? fmtNum(v, unit, dp) : state;
}

ValueUnit kw(double w, int dp) {
  double a = std::fabs(w);
  if (a >= 1000) return {fmtNum(a / 1000, "kW"), "kW"};
  return {fmtNum(a, "W", dp), "W"};
}

std::string fmtFixed(double v, int d) { return toFixed(v, d); }

namespace {
void popCodepoint(std::string& s) {
  if (s.empty()) return;
  size_t i = s.size() - 1;
  while (i > 0 && (uint8_t(s[i]) & 0xC0) == 0x80) --i;
  s.erase(i);
  while (!s.empty() && s.back() == ' ') s.pop_back();
}
}  // namespace

std::string fitKeepTail(const std::string& s, int maxW, const std::function<int(const std::string&)>& width) {
  if (maxW <= 0 || width(s) <= maxW) return s;
  const size_t sp = s.find_last_of(' ');
  if (sp != std::string::npos && sp > 0 && sp + 1 < s.size()) {
    const std::string tail = "… " + s.substr(sp + 1);   // "… attic" (the ellipsis is a UI glyph, not text)
    std::string head = s.substr(0, sp);
    for (popCodepoint(head); !head.empty(); popCodepoint(head))
      if (width(head + tail) <= maxW) return head + tail;
  }
  std::string acc = s;
  for (popCodepoint(acc); !acc.empty(); popCodepoint(acc))
    if (width(acc + "…") <= maxW) return acc + "…";
  return "…";
}

std::string fewerDecimals(const std::string& shown) {
  const NumFmt f = gNumFmt;
  const char dec = f == NumFmt::Point || f == NumFmt::CommaDecimal ? '.' : ',';
  const char grp = f == NumFmt::CommaDecimal ? ',' : f == NumFmt::DecimalComma ? '.' : f == NumFmt::SpaceComma ? ' ' : 0;
  std::string plain;
  size_t frac = std::string::npos;
  for (size_t i = 0; i < shown.size(); ++i) {
    char ch = shown[i];
    if (grp && ch == grp) continue;
    if (ch == dec && frac == std::string::npos) { frac = plain.size(); plain += '.'; continue; }
    if (!(ch >= '0' && ch <= '9') && !(i == 0 && ch == '-')) return shown;   // not a plain number
    plain += ch;
  }
  if (frac == std::string::npos || frac + 1 >= plain.size() || frac == 0 || (frac == 1 && plain[0] == '-')) return shown;
  std::string s = toFixed(std::strtod(plain.c_str(), nullptr), int(plain.size() - frac - 2));
  if (s[0] == '-' && s.find_first_not_of("-0.") == std::string::npos) s.erase(0, 1);
  return localNum(s, f);
}

static int sigDigits(const std::string& s) {
  int n = 0;
  for (char ch : s) if (ch >= '0' && ch <= '9' && (n || ch != '0')) ++n;
  return n;
}

FitValue fitValue(const std::string& value, const std::vector<int>& sizes, int maxW, const std::function<int(const std::string&, int)>& width) {
  for (int floor : {3, 2})
    for (int size : sizes) {
      std::string v = value;
      for (std::string f = fewerDecimals(v); width(v, size) > maxW && f != v && sigDigits(f) >= floor; f = fewerDecimals(v)) v = f;
      if (width(v, size) <= maxW) return {v, size};
    }
  const int size = sizes.empty() ? 0 : sizes.back();
  std::string v = value;
  for (std::string f = fewerDecimals(v); width(v, size) > maxW && f != v; f = fewerDecimals(v)) v = f;
  return {v, size};
}

FitValue fitMiddle(const std::string& text, const std::vector<int>& sizes, int maxW, const std::function<int(const std::string&, int)>& width) {
  for (int size : sizes) if (width(text, size) <= maxW) return {text, size};
  const int size = sizes.empty() ? 0 : sizes.back();
  std::vector<size_t> at;   // byte offset of each codepoint
  for (size_t i = 0; i < text.size(); ++i) if ((static_cast<unsigned char>(text[i]) & 0xC0) != 0x80) at.push_back(i);
  const size_t n = at.size();
  for (size_t k = n ? n - 1 : 0; k > 0; --k) {
    const size_t head = (k + 1) / 2, tail = k / 2;
    std::string v = text.substr(0, head < n ? at[head] : text.size()) + "…" + (tail ? text.substr(at[n - tail]) : std::string());
    if (width(v, size) <= maxW) return {v, size};
  }
  return {"…", size};
}

bool powerMoved(double shown, double now) {
  if ((std::fabs(shown) >= 1000) != (std::fabs(now) >= 1000)) return true;
  double d = std::fabs(now - shown);
  return d >= 50 && d * 20 >= std::fabs(shown);
}

double PowerHold::hold(const std::string& key, double w) {
  auto it = shown_.find(key);
  if (it == shown_.end()) return shown_[key] = w;
  if (powerMoved(it->second, w)) it->second = w;
  return it->second;
}

static const SevDef kSev[4] = {{1, "On time", "Clear", "#1E8E3E"}, {2, "Minor", "Busy", "#F2B705"},
                               {3, "Delayed", "Slow", "#EF6C00"}, {4, "Disrupted", "Jammed", "#D32F2F"}};
const double kCarFactor[4] = {1, 1.15, 1.4, 1.75};

const SevDef& sevDef(int level) { return kSev[std::max(1, std::min(4, level)) - 1]; }

int sevOf(double delay, bool cancelled) {
  if (cancelled || delay > 15) return 4;
  if (delay >= 5) return 3;
  if (delay >= 2) return 2;
  return 1;
}

int routeLevel(const std::vector<DepartureSev>& deps) {
  int l = 1;
  for (size_t i = 0; i < deps.size() && i < 2; ++i) l = std::max(l, sevOf(deps[i].delay, deps[i].cancelled));
  return l;
}

int carLevel(double eta, double typical) {
  if (typical <= 0) return 1;
  double r = eta / typical;
  return r >= kCarFactor[3] ? 4 : r >= kCarFactor[2] ? 3 : r >= kCarFactor[1] ? 2 : 1;
}

int carEta(double typical, int level) { return int(jsRound(typical * kCarFactor[std::max(1, std::min(4, level)) - 1])); }

Rect gridSpan(const GridMetrics& g, int col, int row, int cs, int rs) {
  double cw = (kScreenW - 2 * g.side - 3 * g.gap) / 4.0, ch = (kScreenH - g.top - g.bottom - g.gap) / 2.0;
  auto cx = [&](int k) { return k >= 4 ? kScreenW - g.side + g.gap : g.side + int(std::lround(k * (cw + g.gap))); };
  auto cy = [&](int k) { return k >= 2 ? kScreenH - g.bottom + g.gap : g.top + int(std::lround(k * (ch + g.gap))); };
  int x = cx(col), y = cy(row);
  return Rect{int16_t(x), int16_t(y), int16_t(cx(col + cs) - g.gap - x), int16_t(cy(row + rs) - g.gap - y)};
}

std::vector<GridRect> gridRects(const Screen& s, const GridMetrics& gm) {
  int occ[2][4] = {{0}};
  int cr = 0, cc = 0;
  std::vector<GridRect> out;
  for (auto& w : s.widgets) {
    int cs = std::min(4, w.cs ? w.cs : 1), rs = std::min(2, w.rs ? w.rs : 1);
    GridRect g{false, {0, 0, 0, 0}};
    for (int r = cr; r <= 2 - rs && !g.ok; ++r) {
      for (int c = (r == cr ? cc : 0); c <= 4 - cs && !g.ok; ++c) {
        bool ok = true;
        for (int y = r; y < r + rs; ++y) for (int x = c; x < c + cs; ++x) if (occ[y][x]) ok = false;
        if (ok) {
          for (int y = r; y < r + rs; ++y) for (int x = c; x < c + cs; ++x) occ[y][x] = 1;
          cr = r; cc = c + cs;
          g.ok = true;
          g.r = gridSpan(gm, c, r, cs, rs);
        }
      }
    }
    out.push_back(g);
  }
  return out;
}

std::vector<LightPage> layoutLights(const std::vector<LightGroup>& groups) {
  std::vector<LightCell> items;
  for (auto& g : groups) {
    if (g.ids.empty()) continue;
    items.push_back({LightCell::Header, g.area, "", false});
    for (auto& id : g.ids) items.push_back({LightCell::Light, g.area, id, false});
  }
  std::vector<std::vector<LightCell>> cols;
  std::vector<LightCell> col;
  auto close = [&]() { while (int(col.size()) < kPerCol) col.push_back(LightCell{}); cols.push_back(col); col.clear(); };
  for (auto& it : items) {
    if (int(col.size()) == kPerCol) close();
    if (it.kind == LightCell::Header && int(col.size()) == kPerCol - 1) close();
    if (col.empty() && it.kind == LightCell::Light) col.push_back({LightCell::Header, it.area, "", true});
    col.push_back(it);
  }
  if (!col.empty()) close();
  std::vector<LightPage> pages;
  for (size_t i = 0; i < cols.size(); i += 2) {
    LightPage p = cols[i];
    if (i + 1 < cols.size()) p.insert(p.end(), cols[i + 1].begin(), cols[i + 1].end());
    else p.resize(kPerPage);
    pages.push_back(p);
  }
  return pages;
}

int zonePages(int n) { return std::max(1, (n + kPerPage - 1) / kPerPage); }

int subPages(const Screen& s, const PagingInfo& p) {
  int n = 1;
  if (p.pages) for (auto& w : s.widgets) n = std::max(n, p.pages(w));
  return n;
}

static std::string appOf(const Screen& s) { return s.app.empty() ? "home" : s.app; }

std::vector<PageRef> flatPages(const Config& c, int idx, const PagingInfo& p) {
  std::vector<PageRef> out;
  if (c.screens.empty()) return out;
  idx = std::max(0, std::min(int(c.screens.size()) - 1, idx));
  std::string app = appOf(c.screens[idx]);
  for (int i = 0; i < int(c.screens.size()); ++i) {
    if (appOf(c.screens[i]) != app) continue;
    int n = subPages(c.screens[i], p);
    for (int k = 0; k < n; ++k) out.push_back({i, k});
  }
  return out;
}

int firstScreenOfApp(const Config& c, const std::string& app) {
  for (int i = 0; i < int(c.screens.size()); ++i) if (appOf(c.screens[i]) == app) return i;
  return -1;
}

PageRef navTarget(const Config& c, int idx, int sub, int dir, const PagingInfo& p) {
  auto f = flatPages(c, idx, p);
  if (f.empty()) return {idx, 0};
  int cur = std::min(sub, subPages(c.screens[idx], p) - 1);
  int pos = 0;
  for (int i = 0; i < int(f.size()); ++i) if (f[i].screen == idx && f[i].sub == cur) { pos = i; break; }
  int n = int(f.size());
  return f[((pos + dir) % n + n) % n];
}

std::vector<std::string> changedRegions(const RegionMap& a, const RegionMap& b) {
  std::vector<std::string> keys;
  for (auto& kv : b) {
    auto it = a.find(kv.first);
    if (it == a.end() || it->second.sig != kv.second.sig) { keys.push_back(kv.first); continue; }
    const Rect &x = it->second.rect, &y = kv.second.rect;
    if (x.x != y.x || x.y != y.y || x.w != y.w || x.h != y.h) keys.push_back(kv.first);
  }
  return keys;
}

std::vector<std::string> removedRegions(const RegionMap& a, const RegionMap& b) {
  std::vector<std::string> keys;
  for (auto& kv : a) if (!b.count(kv.first)) keys.push_back(kv.first);
  return keys;
}

bool sameLayout(const RegionMap& a, const RegionMap& b) {
  if (a.size() != b.size()) return false;
  for (auto ia = a.begin(), ib = b.begin(); ia != a.end(); ++ia, ++ib) {
    if (ia->first != ib->first) return false;
    const Rect &x = ia->second.rect, &y = ib->second.rect;
    if (x.x != y.x || x.y != y.y || x.w != y.w || x.h != y.h) return false;
  }
  return true;
}

Rect unionRect(const RegionMap& m, const std::vector<std::string>& keys) {
  int x0 = 1 << 30, y0 = 1 << 30, x1 = -1, y1 = -1;
  for (auto& k : keys) {
    auto it = m.find(k); if (it == m.end()) continue;
    const Rect& r = it->second.rect;
    x0 = std::min<int>(x0, r.x); y0 = std::min<int>(y0, r.y);
    x1 = std::max<int>(x1, r.x + r.w); y1 = std::max<int>(y1, r.y + r.h);
  }
  if (x1 < 0) return Rect{0, 0, 0, 0};
  return Rect{int16_t(x0), int16_t(y0), int16_t(x1 - x0), int16_t(y1 - y0)};
}

int64_t nextCleanMin(int64_t lastFullMin, int everyMin) {
  int64_t t = lastFullMin + everyMin;   // ceil to the next :00/:30 (epoch minutes are >= 0 here)
  return (t + kCleanSlotMin - 1) / kCleanSlotMin * kCleanSlotMin;
}

bool cleanDue(int sinceFull, int64_t lastFullMin, int64_t nowMin, int everyMin, bool night) {
  return !night && sinceFull > 0 && nowMin >= nextCleanMin(lastFullMin, everyMin);
}

RefreshPolicy::Kind RefreshPolicy::requestPartial(bool clockKnown) {
  int since = sinceFull_ + 1;
  if (!clockKnown && since >= kCleanCap) { sinceFull_ = 0; return Kind::Clean; }
  sinceFull_ = since;
  return Kind::Partial;
}

RefreshPolicy::Kind RefreshPolicy::requestNav(bool clockKnown) {
  int nav = navSinceClean_ + 1, since = sinceFull_ + 1;
  if (nav >= kNavClean || (!clockKnown && since >= kCleanCap)) return Kind::Clean;   // the caller's clean resets both
  navSinceClean_ = nav;
  sinceFull_ = since;
  return Kind::Fast;
}

bool RefreshPolicy::cleanDue(int64_t nowMin, bool night) {
  if (nowMin < 0) return false;
  if (lastFullMin_ < 0 || nowMin < lastFullMin_) { lastFullMin_ = nowMin; return false; }
  return ::x4::cleanDue(sinceFull_, lastFullMin_, nowMin, everyMin_, night);
}

static bool parseWindow(const std::string& v, int& a, int& b) {
  if (v == "off" || v.empty()) return false;
  auto d = v.find('-');
  if (d == std::string::npos) return false;
  a = std::atoi(v.substr(0, d).c_str()); b = std::atoi(v.substr(d + 1).c_str());
  return true;
}

bool isNightHour(int h, const std::string& v) {
  int a, b;
  if (!parseWindow(v, a, b)) return false;
  return a > b ? (h >= a || h < b) : (h >= a && h < b);
}

int nightEndHour(const std::string& v) { int a, b; return parseWindow(v, a, b) ? b : -1; }

int idleMinutes(const std::string& s) {
  if (s.empty() || s == "never" || s == "off") return 0;
  return std::max(0, std::atoi(s.c_str()));
}

IdleDecision idleCheck(uint32_t idleMs, int standbyMin, int returnHomeMin, bool alreadyHomed, bool awayFromHome) {
  IdleDecision d;
  double idleMin = idleMs / 60000.0;
  if (standbyMin && idleMin >= standbyMin) { d.standby = true; return d; }
  if (returnHomeMin && idleMin >= returnHomeMin && !alreadyHomed && awayFromHome) d.goHome = true;
  return d;
}

bool ambientDue(uint32_t idleMs, bool menuOpen, bool setup) { return !menuOpen && !setup && idleMs >= kAmbientMs; }

Chrome chromeFor(bool ambient, int batteryPct, bool clockTile) {
  Chrome c;
  if (!ambient) return c;
  c.app = c.pager = false;
  c.battery = batteryPct < kBattLow;
  c.clock = !clockTile;
  return c;
}

bool nightStale(int64_t nowSec, int64_t lastDataSec) { return lastDataSec > 0 && nowSec > 0 && nowSec - lastDataSec > kStaleSec; }

bool validLightTimeout(int sec) {
  for (int t : kLightTimeouts) if (t == sec) return true;
  return false;
}
bool lightTimedOut(uint32_t idleMs, int timeoutSec) { return timeoutSec > 0 && idleMs >= uint32_t(timeoutSec) * 1000u; }
int frontlightPct(int brightness, bool standby, bool night, bool lightOut) { return standby || night || lightOut ? 0 : brightness; }
bool lightWakeConsumes(int brightness, bool standby, bool night, bool lightOut, bool power) {
  return lightOut && brightness > 0 && !standby && !night && !power;
}

int swipeNav(int dx, int dy, uint32_t dt) {
  if (std::abs(dx) > 60 && std::abs(dx) > std::abs(dy) * 1.5 && dt < 800) return dx < 0 ? 1 : -1;
  return 0;
}

std::vector<std::string> Debouncer::fire(uint32_t now) {
  std::vector<std::string> out;
  for (auto it = due_.begin(); it != due_.end();) {
    if (int32_t(now - it->second) >= 0) { out.push_back(it->first); it = due_.erase(it); }
    else ++it;
  }
  return out;
}

}  // namespace x4
