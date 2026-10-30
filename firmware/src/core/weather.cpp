// Port of emulator src/core/weather.ts (eink-ha-os#318).
#include "core/weather.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "core/glance.h"
#include "core/history.h"
#include "core/logic.h"

namespace x4 {
namespace wx {

namespace {
constexpr int64_t kMinMs = 60000;
struct Cond { const char* name; Icon icon; S text; };
const Cond kConds[] = {
    {"sunny", Icon::Sun, S::wxSunny}, {"clear-night", Icon::Moon, S::wxClearNight}, {"partlycloudy", Icon::Partly, S::wxPartlyCloudy},
    {"cloudy", Icon::Cloud, S::wxCloudy}, {"fog", Icon::Fog, S::wxFog}, {"rainy", Icon::Rain, S::wxRainy}, {"pouring", Icon::Pour, S::wxPouring},
    {"snowy", Icon::Snow, S::wxSnowy}, {"snowy-rainy", Icon::Sleet, S::wxSnowyRainy}, {"hail", Icon::Sleet, S::wxHail},
    {"lightning", Icon::Thunder, S::wxLightning}, {"lightning-rainy", Icon::Thunder, S::wxLightningRainy}, {"windy", Icon::Wind, S::wxWindy},
    {"windy-variant", Icon::Wind, S::wxWindyVariant}, {"exceptional", Icon::Alert, S::wxExceptional},
};
const Cond* condOf(const char* s, size_t n) {
  for (auto& c : kConds) if (std::strlen(c.name) == n && !std::memcmp(c.name, s, n)) return &c;
  return nullptr;
}
int64_t localDay(int64_t t, int tz) {
  const int64_t x = t + tz * kMinMs;
  return x >= 0 ? x / kDayMs : -((-x + kDayMs - 1) / kDayMs);
}
double jsRound(double v) { return std::floor(v + 0.5); }   // Math.round
// r2 in weather.ts: clamp, × 100 rounded
int r100(double v, double lo, double hi) { return int(jsRound(std::max(lo, std::min(hi, v)) * 100)); }
std::string deg(double v) { return hist::has(v) ? fmtNum(jsRound(v), "", 0) + "°" : "—"; }
double attrNum(const EntityValue& raw, const char* k) {
  auto it = raw.attrs.find(k);
  return it == raw.attrs.end() ? hist::kNone : hist::numText(it->second.data(), it->second.size(), true);
}
const PStr* attr(const EntityValue& raw, const char* k) {
  auto it = raw.attrs.find(k);
  return it == raw.attrs.end() ? nullptr : &it->second;
}
bool wet(const Entry& e) {
  if (e.mm != kNoMm) return e.mm > 0;
  const Icon i = Icon(e.icon);
  return i == Icon::Rain || i == Icon::Pour || i == Icon::Snow || i == Icon::Sleet || i == Icon::Thunder;
}
}  // namespace

const char* iconName(Icon i) {
  static const char* const N[] = {"sun", "moon", "partly", "cloud", "fog", "rain", "pour", "snow", "sleet", "thunder", "wind", "alert"};
  return int(i) < int(Icon::Count) ? N[int(i)] : "cloud";
}
Icon iconOf(const std::string& c) {
  const Cond* k = condOf(c.data(), c.size());
  return k ? k->icon : Icon::Cloud;
}
std::string condText(const std::string& c, Lang l) {
  const Cond* k = condOf(c.data(), c.size());
  return k ? tr(l, k->text) : c;
}
double tempOf(int16_t v) { return v == kNoT ? hist::kNone : v / 100.0; }
double mmOf(uint16_t v) { return v == kNoMm ? hist::kNone : v / 100.0; }
std::string degText(double v) { return deg(v); }
bool isWet(const Entry& e) { return wet(e); }

// ---- entries ----
void EntryParser::begin(const char* const* path, int nPath, bool daily, int64_t now, int tz, Entry* out, uint8_t* n) {
  out_ = out; n_ = n; daily_ = daily; now_ = now; tz_ = tz;
  *n_ = 0;
  sc_.begin(path, nPath, "", "", 0, 0, tz, nullptr);
  sc_.fields(this);
  clearRow();
}

void EntryParser::clearRow() {
  t_ = hist::kNoTime;
  temp_ = low_ = mm_ = hist::kNone;
  icon_ = Icon::Cloud;
}

void EntryParser::rowField(const char* key, const char* v, size_t n, bool str) {
  if (!std::strcmp(key, "datetime")) {
    const double x = str ? hist::kNone : hist::numText(v, n, false);
    t_ = str ? hist::parseTime(v, n, tz_) : hist::has(x) ? hist::parseTimeNum(x) : hist::kNoTime;
  } else if (!std::strcmp(key, "condition")) {
    const Cond* c = str ? condOf(v, n) : nullptr;
    icon_ = c ? c->icon : Icon::Cloud;
  } else if (!std::strcmp(key, "temperature")) temp_ = hist::numText(v, n, str);
  else if (!std::strcmp(key, "templow")) low_ = hist::numText(v, n, str);
  else if (!std::strcmp(key, "precipitation")) mm_ = hist::numText(v, n, str);
}

void EntryParser::rowEnd() {
  const int max = daily_ ? kDaily : kHourly;
  if (out_ && t_ != hist::kNoTime && *n_ < max &&
      !(daily_ ? localDay(t_, tz_) < localDay(now_, tz_) : t_ + kHourMs <= now_) && t_ / 1000 <= int64_t(UINT32_MAX)) {
    Entry& e = out_[(*n_)++];
    e.tS = uint32_t(t_ / 1000);
    e.icon = uint8_t(icon_);
    e.pad = 0;
    e.temp = hist::has(temp_) ? int16_t(r100(temp_, -327, 327)) : kNoT;
    e.low = hist::has(low_) ? int16_t(r100(low_, -327, 327)) : kNoT;
    e.mm = hist::has(mm_) ? uint16_t(r100(mm_, 0, 655)) : kNoMm;
  }
  clearRow();
}

void parseList(EntryParser& p, const std::string& json, bool daily, int64_t now, int tz, Entry* out, uint8_t& n) {
  p.begin(nullptr, 0, daily, now, tz, out, &n);
  p.feed(json.data(), json.size());
  if (!p.complete()) n = 0;   // JSON.parse fails: no entries
}

// ---- view ----
std::string windText(const EntityValue& raw, Lang l) {
  const double v = attrNum(raw, "wind_speed");
  if (!hist::has(v)) return "—";
  const PStr* u = attr(raw, "wind_speed_unit");
  const std::string unit = u ? std::string(*u) : std::string();
  const std::string n = fmtNum(jsRound(v), "", 0);
  std::string s = unit == "Beaufort" ? tr(l, S::wxBft, n) : n + (unit.empty() ? "" : " " + unit);
  const double b = attrNum(raw, "wind_bearing");
  if (hist::has(b)) {
    const double d = std::fmod(std::fmod(b, 360) + 360, 360);
    const int k = int(jsRound(d / 45)) % 8;
    const char* c = tr(l, S::wxCompass);
    for (int i = 0; i < k && c; ++i) { c = std::strchr(c, ' '); if (c) ++c; }
    if (c) s += " " + std::string(c, std::strcspn(c, " "));
  } else if (const PStr* t = attr(raw, "wind_bearing")) {
    bool ok = !t->empty() && t->size() <= 3;
    for (char ch : *t) ok = ok && ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z'));
    if (ok) s += " " + std::string(*t);
  }
  return s;
}

void view(const EntityValue* raw, const Forecast* fc, int64_t now, int tz, Lang l, View& o) {
  o = View();
  o.gap = entityGap(raw);
  const bool none = o.gap != EntityGap::None || !raw;
  const std::string st = raw ? std::string(raw->state) : std::string();
  o.icon = raw ? iconOf(st) : Icon::Cloud;
  o.temp = none ? "—" : deg(attrNum(*raw, "temperature"));
  o.cond = none ? "" : condText(st, l);
  const double fv = raw ? attrNum(*raw, "apparent_temperature") : hist::kNone;
  o.feels = o.gap != EntityGap::None || !hist::has(fv) ? "" : tr(l, S::wxFeels, deg(fv));
  o.wind = o.gap != EntityGap::None || !raw ? "—" : windText(*raw, l);
  const bool daily = fc && fc->hasDaily, hourly = fc && fc->hasHourly;
  o.forecast = daily;
  const int64_t day0 = localDay(now, tz);
  const Entry* today = nullptr;
  if (daily)
    for (int i = 0; i < fc->nDaily && !today; ++i) if (localDay(int64_t(fc->daily[i].tS) * 1000, tz) == day0) today = &fc->daily[i];
  o.high = deg(today ? tempOf(today->temp) : hist::kNone);
  o.low = deg(today ? tempOf(today->low) : hist::kNone);
  // rain from (wxRain)
  if (!hourly) o.rain = "—";
  else {
    o.rain = tr(l, S::wxRainNone);
    for (int i = 0; i < fc->nHourly; ++i) {
      const Entry& e = fc->hourly[i];
      const int64_t t = int64_t(e.tS) * 1000;
      if (t + kHourMs <= now || t >= now + kRainAheadMs || !wet(e)) continue;
      o.rain = t <= now ? std::string(tr(l, S::wxRainNow)) : tr(l, S::wxRainFrom, hhmm(int(((t + tz * kMinMs) / kMinMs) % 1440)));
      break;
    }
  }
  if (!daily) return;
  const PStr* pu = raw ? attr(*raw, "precipitation_unit") : nullptr;
  const std::string unit = pu && !pu->empty() ? std::string(*pu) : std::string("mm");
  const Entry* next[kDays];
  for (int i = 0; i < fc->nDaily && o.nDays < kDays; ++i)
    if (localDay(int64_t(fc->daily[i].tS) * 1000, tz) > day0) next[o.nDays++] = &fc->daily[i];
  double scale = unit == "in" ? 0.4 : 10;
  for (int i = 0; i < o.nDays; ++i) if (next[i]->mm != kNoMm) scale = std::max(scale, mmOf(next[i]->mm));
  for (int i = 0; i < o.nDays; ++i) {
    const Entry& e = *next[i];
    Day& d = o.days[i];
    const int64_t ld = localDay(int64_t(e.tS) * 1000, tz);
    d.name = tr(l, S(int(S::wd0) + int(((ld % 7) + 11) % 7)));   // 1970-01-01 was a Thursday (wd4)
    d.icon = Icon(e.icon);
    d.hi = deg(tempOf(e.temp));
    d.lo = deg(tempOf(e.low));
    const double mm = mmOf(e.mm);
    d.mm = !hist::has(mm) ? "" : mm < 0.05 ? std::string(tr(l, S::wxDry)) : fmtNum(mm < 1 ? mm : jsRound(mm), "", mm < 1 ? 1 : 0) + " " + unit;
    d.bar = jsRound((hist::has(mm) ? mm : 0) / scale * 1000) / 1000;
  }
}

// ---- fetch plan ----
void Fetcher::setEntities(const std::vector<std::string>& ids) {
  std::vector<Slot, PsramAlloc<Slot>> next;
  for (auto& id : ids) {
    if (int(next.size()) >= kMaxTiles) break;
    bool dup = false;
    for (auto& s : next) dup = dup || s.entity == PStr(id);
    if (dup) continue;
    auto it = std::find_if(slots_.begin(), slots_.end(), [&](const Slot& s) { return s.entity == PStr(id); });
    if (it != slots_.end()) next.push_back(*it);
    else { next.emplace_back(); next.back().entity = PStr(id); }
  }
  if (reqSlot_ >= 0 && (reqSlot_ >= int(next.size()) || !(next[size_t(reqSlot_)].entity == slots_[size_t(reqSlot_)].entity))) reqId_ = 0;
  slots_.swap(next);
}

void Fetcher::reset() { reqId_ = 0; }

bool Fetcher::next(int64_t now, int tz, uint32_t id, std::string& json) {
  if (reqId_) return false;
  auto due = [&](int64_t at, int64_t ask) { return (at == 0 || now - at >= kRefreshMs) && (ask == 0 || now - ask >= kRetryMs); };
  for (size_t i = 0; i < slots_.size(); ++i) {
    Slot& s = slots_[i];
    const bool d = due(s.fc.dailyAt, s.dailyAsk);
    if (!d && !due(s.fc.hourlyAt, s.hourlyAsk)) continue;
    (d ? s.dailyAsk : s.hourlyAsk) = now;
    json = "{\"id\":" + std::to_string(id) +
           ",\"type\":\"call_service\",\"domain\":\"weather\",\"service\":\"get_forecasts\",\"service_data\":{\"type\":\"" +
           (d ? "daily" : "hourly") + "\"},\"target\":{\"entity_id\":\"" + std::string(s.entity) + "\"},\"return_response\":true}";
    reqId_ = id; reqAt_ = now; reqSlot_ = int(i); reqDaily_ = d; tz_ = tz;
    return true;
  }
  return false;
}

void Fetcher::begin() {
  const std::string e = reqSlot_ >= 0 && reqSlot_ < int(slots_.size()) ? std::string(slots_[size_t(reqSlot_)].entity) : std::string();
  const char* path[] = {"result", "response", e.c_str(), "forecast"};
  parser_.begin(path, 4, reqDaily_, reqAt_, tz_, incoming_, &nIncoming_);
}

void Fetcher::end(int64_t now) {
  const bool ok = parser_.success() && parser_.complete();
  if (reqSlot_ >= 0 && reqSlot_ < int(slots_.size()) && ok) {
    Slot& s = slots_[size_t(reqSlot_)];
    if (reqDaily_) { std::copy(incoming_, incoming_ + nIncoming_, s.fc.daily); s.fc.nDaily = nIncoming_; s.fc.hasDaily = 1; s.fc.dailyAt = now; }
    else { std::copy(incoming_, incoming_ + nIncoming_, s.fc.hourly); s.fc.nHourly = nIncoming_; s.fc.hasHourly = 1; s.fc.hourlyAt = now; }
    s.dirty = true;
  }
  reqId_ = 0;
}

void Fetcher::restore(const std::string& entity, const Forecast& fc) {
  for (auto& s : slots_)
    if (s.entity == PStr(entity) && !s.fc.dailyAt && !s.fc.hourlyAt) { s.fc = fc; s.dirty = true; }
}

// ---- RTC ----
namespace {
constexpr uint32_t kMagic = 0x57583138;   // "WX18"
uint32_t sumOf(const Rtc& r) { return glance::fnv1a(r.slot, sizeof r.slot); }
}  // namespace
void seal(Rtc& r) { r.magic = kMagic; r.sum = sumOf(r); }
bool valid(const Rtc& r) { return r.magic == kMagic && r.sum == sumOf(r); }

void save(Rtc& r, const Fetcher& f) {
  std::memset(static_cast<void*>(r.slot), 0, sizeof r.slot);
  for (int i = 0; i < f.size() && i < kMaxTiles; ++i) {
    r.slot[i].entityHash = glance::fnv1a(f.entity(i));
    r.slot[i].fc = f.forecast(i);
  }
  seal(r);
}

void load(const Rtc& r, Fetcher& f) {
  if (!valid(r)) return;
  for (int i = 0; i < f.size(); ++i)
    for (auto& s : r.slot)
      if (s.entityHash && s.entityHash == glance::fnv1a(f.entity(i))) f.restore(f.entity(i), s.fc);
}

}  // namespace wx
}  // namespace x4
