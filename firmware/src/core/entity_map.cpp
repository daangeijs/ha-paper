#include "core/entity_map.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <cstdio>
#include <initializer_list>

#include "core/json.h"

namespace x4 {

namespace {

const char* const kSolarPower = "sensor.solar_power";
const char* const kGridPower = "sensor.grid_power";
const char* const kBattPower = "sensor.battery_power";
const char* const kHomePower = "sensor.home_power";
const char* const kSoc = "sensor.home_battery_soc";
const char* const kPrices = "sensor.energy_prices";
const char* const kSolarToday = "sensor.solar_today";
const char* const kImportToday = "sensor.grid_import_today";
const char* const kExportToday = "sensor.grid_export_today";
const char* const kEnergyToday = "sensor.energy_today";
const char* const kUsageHourly = "sensor.energy_usage_hourly";
const char* const kSolarHourly = "sensor.solar_hourly";
const char* const kInside = "sensor.living_temperature";
const char* const kRoutePrefix = "sensor.x4_route_";

// Fixed logical ids. Routes are user tiles on their own entity (#145); sensor.x4_route_* overrides still map.
const std::vector<std::string>& fixedLogical() {
  static const std::vector<std::string> v = {kSolarPower, kGridPower, kBattPower, kHomePower, kSoc, kPrices,
                                             kSolarToday, kImportToday, kExportToday, kEnergyToday, kUsageHourly,
                                             kSolarHourly, kInside};
  return v;
}

bool isPowerId(const std::string& l) { return l == kSolarPower || l == kGridPower || l == kBattPower || l == kHomePower; }
bool isStatId(const std::string& l) {
  return l == kSolarToday || l == kImportToday || l == kExportToday || l == kEnergyToday || l == kUsageHourly || l == kSolarHourly;
}

bool parseNum(const std::string& s, double& v) {
  if (s.empty() || s == "unknown" || s == "unavailable") return false;
  char* end = nullptr;
  v = std::strtod(s.c_str(), &end);
  return end && *end == '\0' && std::isfinite(v);
}

std::string attrOf(const EntityValue& e, const char* k) {
  auto it = e.attrs.find(k);
  return it == e.attrs.end() ? std::string() : it->second.str();
}

std::string lower(std::string s) {
  for (auto& c : s) c = char(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

std::string numText(double v, int digits) {
  double p = std::pow(10.0, digits);
  double r = jsRound(v * p) / p;
  if (r == 0) r = 0;   // no "-0"
  return jsNumber(r);
}

std::string jsonArray(const std::vector<double>& v, int digits) {
  std::string s = "[";
  for (size_t i = 0; i < v.size(); ++i) { if (i) s += ","; s += numText(v[i], digits); }
  return s + "]";
}

const Json* firstKey(const Json& o, std::initializer_list<const char*> keys) {
  for (auto* k : keys) if (auto* j = o.get(k)) if (!j->isNull()) return j;
  return nullptr;
}

std::string strOf(const Json* j) { return j && j->isStr() ? j->str : std::string(); }

// Power source of an Energy dashboard entry (HA ≥ 2025.12): stat_rate | power[] | power_config.
bool powerFromPrefs(const Json& src, EntitySource& out, double haSign) {
  out = EntitySource{};
  out.why = "energy";
  if (auto s = strOf(src.get("stat_rate")); !s.empty()) { out.ha = s; out.sign = haSign; return true; }
  if (auto* p = src.get("power")) {
    if (p->isArr())
      for (auto& x : p->arr)
        if (auto s = strOf(x.get("stat_rate")); !s.empty()) { out.ha = s; out.sign = haSign; return true; }
    if (p->isStr() && !p->str.empty()) { out.ha = p->str; out.sign = haSign; return true; }
  }
  if (auto* pc = src.get("power_config"); pc && pc->isObj()) {
    if (auto s = strOf(pc->get("stat_rate")); !s.empty()) { out.ha = s; out.sign = haSign; return true; }
    if (auto s = strOf(pc->get("stat_rate_inverted")); !s.empty()) { out.ha = s; out.sign = -haSign; return true; }
    auto from = strOf(pc->get("stat_rate_from")), to = strOf(pc->get("stat_rate_to"));
    if (!from.empty()) { out.ha = from; out.minus = to; out.sign = haSign; return true; }
  }
  return false;
}

int score(const std::string& id, std::initializer_list<const char*> good, std::initializer_list<const char*> bad) {
  std::string l = lower(id);
  int s = 0;
  for (auto* g : good) if (l.find(g) != std::string::npos) s += 2;
  for (auto* b : bad) if (l.find(b) != std::string::npos) s -= 3;
  return s;
}

bool hasAny(const std::string& id, std::initializer_list<const char*> keys) {
  std::string l = lower(id);
  for (auto* k : keys) if (l.find(k) != std::string::npos) return true;
  return false;
}

// days since 1970-01-01 for a civil date (Howard Hinnant)
int64_t daysFromCivil(int64_t y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + static_cast<int64_t>(doe) - 719468;
}

struct LocalDay { int y, m, d, h, mi; };
LocalDay localOf(int64_t epoch) {
  time_t t = static_cast<time_t>(epoch);
  struct tm tm {};
  localtime_r(&t, &tm);
  return {tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min};
}

// Recorder timestamps: ms (float) since HA 2023.3, or ISO text.
int64_t epochOfStat(const Json* j) {
  if (!j) return -1;
  if (j->isNum()) return static_cast<int64_t>(j->num > 1e11 ? j->num / 1000 : j->num);
  if (j->isStr()) return parseIsoTime(j->str);
  return -1;
}

}  // namespace

// ------------------------------------------------------------------------------------------- time / prices

int64_t parseIsoTime(const std::string& s) {
  int y, mo, d, h = 0, mi = 0;
  double sec = 0;
  if (s.size() < 10 || std::sscanf(s.c_str(), "%4d-%2d-%2d", &y, &mo, &d) != 3) return -1;
  size_t p = 10;
  if (p < s.size() && (s[p] == 'T' || s[p] == ' ')) {
    int n = 0;
    if (std::sscanf(s.c_str() + p + 1, "%2d:%2d%n", &h, &mi, &n) < 2) return -1;
    p += 1 + n;
    if (p < s.size() && s[p] == ':') {
      char* end = nullptr;
      sec = std::strtod(s.c_str() + p + 1, &end);
      p = size_t(end - s.c_str());
    }
  }
  const int64_t civil = daysFromCivil(y, unsigned(mo), unsigned(d)) * 86400 + h * 3600 + mi * 60 + int64_t(sec);
  if (p >= s.size()) {   // no offset: local time
    struct tm tm {};
    tm.tm_year = y - 1900; tm.tm_mon = mo - 1; tm.tm_mday = d; tm.tm_hour = h; tm.tm_min = mi; tm.tm_sec = int(sec);
    tm.tm_isdst = -1;
    return static_cast<int64_t>(mktime(&tm));
  }
  if (s[p] == 'Z' || s[p] == 'z') return civil;
  if (s[p] == '+' || s[p] == '-') {
    int oh = 0, om = 0;
    if (std::sscanf(s.c_str() + p + 1, "%2d:%2d", &oh, &om) < 1 && std::sscanf(s.c_str() + p + 1, "%2d%2d", &oh, &om) < 1) return -1;
    const int64_t off = (oh * 3600 + om * 60) * (s[p] == '+' ? 1 : -1);
    return civil - off;
  }
  return -1;
}

// fill gaps from the previous slot (the first known one before it); n slots
static std::vector<double> filled(const double* sum, const int* cnt, int n) {
  std::vector<double> out;
  double prev = 0;
  for (int k = 0; k < n; ++k) if (cnt[k]) { prev = sum[k] / cnt[k]; break; }
  for (int k = 0; k < n; ++k) {
    double x = cnt[k] ? sum[k] / cnt[k] : prev;
    out.push_back(x);
    prev = x;
  }
  return out;
}

PriceSeries priceSeries(const EntityValue& v, int64_t nowEpoch) {
  PriceSeries ps;
  double scale = 1;
  std::string unit = lower(attrOf(v, "unit_of_measurement") + " " + attrOf(v, "unit"));
  if (unit.find("mwh") != std::string::npos) scale = 0.001;
  else if (unit.find("ct") != std::string::npos || unit.find("cent") != std::string::npos) scale = 0.01;
  if (attrOf(v, "price_in_cents") == "true") scale = 0.01;

  for (const char* key : {"raw_today", "today", "prices_today", "prices"}) {
    Json j;
    auto it = v.attrs.find(key);
    if (it == v.attrs.end() || !parseJson(it->second, j) || !j.isArr() || j.arr.empty()) continue;
    if (j.arr[0].isNum()) {   // plain series (Nord Pool `today`): 24 hourly or 96 quarter-hourly
      const size_t n = j.arr.size();
      if (n % 24 != 0) continue;
      const size_t per = n / 24;
      for (size_t hr = 0; hr < 24; ++hr) {
        double sum = 0;
        for (size_t k = 0; k < per; ++k) sum += j.arr[hr * per + k].numOr(0);
        ps.hourly.push_back(sum / double(per) * scale);
      }
      if (n == 96)
        for (size_t k = 0; k < 96; ++k) ps.quarters.push_back(j.arr[k].numOr(0) * scale);
      return ps;
    }
    if (!j.arr[0].isObj()) continue;
    double sum[24] = {0}, qsum[96] = {0};
    int cnt[24] = {0}, qcnt[96] = {0};
    bool subHour = false;
    int ty = 0, tm = 0, td = 0;
    if (nowEpoch > 0) { auto l = localOf(nowEpoch); ty = l.y; tm = l.m; td = l.d; }
    for (auto& o : j.arr) {
      const Json* t = firstKey(o, {"start", "startsAt", "starts_at", "from", "time", "start_time", "startTime", "datetime"});
      const Json* val = firstKey(o, {"value", "total", "price", "price_ct", "marketPrice", "electricity_price"});
      if (!t || !t->isStr() || !val) continue;
      double x;
      if (val->isNum()) x = val->num;
      else if (!(val->isStr() && parseNum(val->str, x))) continue;
      if (o.get("price_ct") == val) x *= 0.01;
      int64_t e = parseIsoTime(t->str);
      if (e < 0) continue;
      auto l = localOf(e);
      if (!ty) { ty = l.y; tm = l.m; td = l.d; }
      if (l.y != ty || l.m != tm || l.d != td) continue;
      sum[l.h] += x * scale;
      cnt[l.h]++;
      const int q = l.h * 4 + l.mi / 15;
      qsum[q] += x * scale;
      qcnt[q]++;
      subHour |= l.mi != 0;
    }
    int have = 0;
    for (int hr = 0; hr < 24; ++hr) have += cnt[hr] > 0;
    if (!have) continue;
    ps.hourly = filled(sum, cnt, 24);
    if (subHour) ps.quarters = filled(qsum, qcnt, 96);
    return ps;
  }
  return ps;
}

std::vector<double> hourlyPrices(const EntityValue& v, int64_t nowEpoch) { return priceSeries(v, nowEpoch).hourly; }

// ------------------------------------------------------------------------------------------- adapter

GridFlows gridFlows(const Json& s) {
  GridFlows g;
  if (!s.isObj()) return g;
  auto add = [](std::vector<std::string>& l, const std::string& m) {
    if (!m.empty() && std::find(l.begin(), l.end(), m) == l.end()) l.push_back(m);
  };
  if (auto* ff = s.get("flow_from"); ff && ff->isArr())
    for (auto& f : ff->arr) {
      if (!f.isObj()) continue;
      add(g.imports, strOf(f.get("stat_energy_from")));
      if (g.price.empty()) g.price = strOf(f.get("entity_energy_price"));
    }
  if (auto* ft = s.get("flow_to"); ft && ft->isArr())
    for (auto& f : ft->arr) {
      if (!f.isObj()) continue;
      add(g.exports, strOf(f.get("stat_energy_to")));
      if (g.priceExport.empty()) g.priceExport = strOf(f.get("entity_energy_price"));
    }
  add(g.imports, strOf(s.get("stat_energy_from")));
  add(g.exports, strOf(s.get("stat_energy_to")));
  if (g.price.empty()) g.price = strOf(s.get("entity_energy_price"));
  if (g.priceExport.empty()) g.priceExport = strOf(s.get("entity_energy_price_export"));
  return g;
}

bool EntityAdapter::isLogicalId(const std::string& id) {
  if (id.compare(0, std::strlen(kRoutePrefix), kRoutePrefix) == 0) return true;
  for (auto& l : fixedLogical()) if (l == id) return true;
  return false;
}

void EntityAdapter::setOverrides(const std::map<std::string, std::string>& o) {
  overrides_.clear();
  for (auto& kv : o)
    if (!kv.second.empty() && isLogicalId(kv.first)) overrides_[kv.first] = kv.second;
  resolve();
}

bool EntityAdapter::setEnergyPrefs(const std::string& text) {
  auto before = watchIds();
  energy_.clear();
  solarMeters_.clear(); importMeters_.clear(); exportMeters_.clear(); battOutMeters_.clear(); battInMeters_.clear();
  priceEntity_.clear();
  hasBattery_ = hasSolar_ = hasGrid_ = false;
  Json j;
  if (parseJson(text, j)) {
    if (auto* srcs = j.get("energy_sources"); srcs && srcs->isArr()) {
      for (auto& s : srcs->arr) {
        std::string type = strOf(s.get("type"));
        EntitySource p;
        if (type == "solar") {
          hasSolar_ = true;
          if (auto m = strOf(s.get("stat_energy_from")); !m.empty()) solarMeters_.push_back(m);
          if (!energy_.count(kSolarPower) && powerFromPrefs(s, p, 1)) energy_[kSolarPower] = p;
        } else if (type == "battery") {
          hasBattery_ = true;
          if (auto m = strOf(s.get("stat_energy_from")); !m.empty()) battOutMeters_.push_back(m);
          if (auto m = strOf(s.get("stat_energy_to")); !m.empty()) battInMeters_.push_back(m);
          // HA: + = discharging (power into the home); UI: + = charging
          if (!energy_.count(kBattPower) && powerFromPrefs(s, p, -1)) energy_[kBattPower] = p;
        } else if (type == "grid") {
          hasGrid_ = true;
          GridFlows g = gridFlows(s);
          importMeters_.insert(importMeters_.end(), g.imports.begin(), g.imports.end());
          exportMeters_.insert(exportMeters_.end(), g.exports.begin(), g.exports.end());
          if (priceEntity_.empty()) priceEntity_ = g.price;
          if (!energy_.count(kGridPower) && powerFromPrefs(s, p, 1)) energy_[kGridPower] = p;
        }
      }
    }
  }
  if (!priceEntity_.empty()) energy_[kPrices] = EntitySource{priceEntity_, "", 1, "energy"};
  resolve();
  return watchIds() != before;
}

std::string EntityAdapter::deviceDiscoveryTemplate() const {
  std::vector<std::string> meters;
  auto add = [&](const std::vector<std::string>& v) { for (auto& m : v) if (std::find(meters.begin(), meters.end(), m) == meters.end()) meters.push_back(m); };
  add(solarMeters_); add(importMeters_); add(exportMeters_); add(battOutMeters_); add(battInMeters_);
  if (meters.empty()) return {};
  std::string list;
  for (auto& m : meters) { if (!list.empty()) list += ","; list += jsonQuote(m); }
  // [[meter, [[entity, device_class, unit], …]], …] — lists only (no dict mutation in HA's sandboxed Jinja)
  return "{% set ns = namespace(o=[]) %}{% for m in [" + list +
         "] %}{% set d = device_id(m) %}{% set e2 = namespace(l=[]) %}{% if d %}{% for e in device_entities(d) %}"
         "{% set dc = state_attr(e, 'device_class') %}{% if dc in ['power', 'battery'] %}"
         "{% set e2.l = e2.l + [[e, dc, state_attr(e, 'unit_of_measurement') or '']] %}{% endif %}{% endfor %}{% endif %}"
         "{% set ns.o = ns.o + [[m, e2.l]] %}{% endfor %}{{ ns.o | tojson }}";
}

bool EntityAdapter::setDeviceDiscovery(const std::string& text) {
  Json j;
  if (!parseJson(text, j)) return false;
  // meter → candidates
  std::map<std::string, std::vector<std::pair<std::string, std::string>>> byMeter;   // (entity, device_class)
  auto addList = [&](const std::string& meter, const Json& l) {
    if (!l.isArr()) return;
    for (auto& e : l.arr)
      if (e.isArr() && e.arr.size() >= 2 && e.arr[0].isStr() && e.arr[1].isStr()) {
        std::string unit = e.arr.size() > 2 ? e.arr[2].strOr("") : "";
        if (e.arr[1].str == "battery" && unit != "%") continue;
        byMeter[meter].push_back({e.arr[0].str, e.arr[1].str});
      }
  };
  if (j.isArr()) {
    for (auto& p : j.arr)
      if (p.isArr() && p.arr.size() == 2 && p.arr[0].isStr()) addList(p.arr[0].str, p.arr[1]);
  } else if (j.isObj()) {
    for (auto& kv : j.obj) addList(kv.first, kv.second);
  } else {
    return false;
  }
  auto before = watchIds();
  auto candidates = [&](const std::vector<std::string>& meters, const char* dc) {
    std::vector<std::string> out;
    for (auto& m : meters)
      for (auto& c : byMeter[m])
        if (c.second == dc && std::find(out.begin(), out.end(), c.first) == out.end()) out.push_back(c.first);
    return out;
  };
  auto best = [](const std::vector<std::string>& c, std::initializer_list<const char*> good, std::initializer_list<const char*> bad) {
    std::string b;
    int bs = -1000;
    for (auto& id : c) {
      int s = score(id, good, bad);
      if (s > bs) { bs = s; b = id; }
    }
    return bs < 0 ? std::string() : b;
  };
  if (!energy_.count(kSolarPower)) {
    auto id = best(candidates(solarMeters_, "power"), {"solar", "pv", "production", "yield", "generation"}, {"battery", "batt", "grid", "import", "export"});
    if (!id.empty()) energy_[kSolarPower] = EntitySource{id, "", 1, "device"};
  }
  if (!energy_.count(kBattPower)) {
    auto id = best(candidates(battOutMeters_.empty() ? battInMeters_ : battOutMeters_, "power"), {"battery", "batt"}, {"pv", "solar", "grid"});
    if (!id.empty()) energy_[kBattPower] = EntitySource{id, "", -1, "device"};
  }
  if (!energy_.count(kSoc)) {
    auto c = candidates(battOutMeters_.empty() ? battInMeters_ : battOutMeters_, "battery");
    if (!c.empty()) energy_[kSoc] = EntitySource{best(c, {"soc", "level", "state_of_charge", "battery"}, {}), "", 1, "device"};
    if (energy_.count(kSoc) && energy_[kSoc].ha.empty()) energy_[kSoc].ha = c.front();
  }
  if (!energy_.count(kGridPower)) {
    std::vector<std::string> meters = importMeters_;
    meters.insert(meters.end(), exportMeters_.begin(), exportMeters_.end());
    auto c = candidates(meters, "power");
    // P1 / DSMR meters: "…power_consumption" (from grid) and "…power_production" (to grid), no net sensor
    std::string imp, exp, net;
    for (auto& id : c) {
      if (hasAny(id, {"phase", "_l1", "_l2", "_l3"})) continue;
      if (imp.empty() && hasAny(id, {"consum", "import", "deliver", "afname"})) imp = id;
      else if (exp.empty() && hasAny(id, {"produc", "export", "return", "teruglever"})) exp = id;
      else if (net.empty()) net = id;
    }
    if (!net.empty() && score(net, {"grid", "net", "power"}, {"solar", "pv", "battery"}) >= 0 && (imp.empty() || exp.empty()))
      energy_[kGridPower] = EntitySource{net, "", 1, "device"};
    else if (!imp.empty() && !exp.empty()) energy_[kGridPower] = EntitySource{imp, exp, 1, "device"};
    else if (!imp.empty()) energy_[kGridPower] = EntitySource{imp, "", 1, "device"};
  }
  resolve();
  return watchIds() != before;
}

std::vector<std::string> EntityAdapter::statisticIds() const {
  std::vector<std::string> v;
  for (auto* l : {&solarMeters_, &importMeters_, &exportMeters_, &battOutMeters_, &battInMeters_})
    for (auto& m : *l) if (std::find(v.begin(), v.end(), m) == v.end()) v.push_back(m);
  return v;
}

void EntityAdapter::setHourlyStatistics(const std::string& text, EntityUpdates& out) {
  Json j;
  if (!parseJson(text, j) || !j.isObj()) return;
  std::map<std::string, std::vector<double>> hours;   // stat id → 24 × kWh
  int ty = 0, tm = 0, td = 0;
  if (now_ > 0) { auto l = localOf(now_); ty = l.y; tm = l.m; td = l.d; }
  for (auto& kv : j.obj) {
    if (!kv.second.isArr()) continue;
    std::vector<double> h(24, 0.0);
    for (auto& row : kv.second.arr) {
      int64_t e = epochOfStat(row.get("start"));
      const Json* c = row.get("change");
      if (e < 0 || !c || !c->isNum()) continue;
      auto l = localOf(e);
      if (ty && (l.y != ty || l.m != tm || l.d != td)) continue;
      h[l.h] += c->num;
    }
    hours[kv.first] = h;
  }
  auto sumOf = [&](const std::vector<std::string>& meters, bool& any) {
    std::vector<double> h(24, 0.0);
    for (auto& m : meters) {
      auto it = hours.find(m);
      if (it == hours.end()) continue;
      any = true;
      for (int i = 0; i < 24; ++i) h[i] += it->second[i];
    }
    return h;
  };
  bool sAny = false, iAny = false, eAny = false, boAny = false, biAny = false;
  auto solar = sumOf(solarMeters_, sAny), imp = sumOf(importMeters_, iAny), exp = sumOf(exportMeters_, eAny);
  auto bout = sumOf(battOutMeters_, boAny), bin = sumOf(battInMeters_, biAny);
  auto total = [](const std::vector<double>& h) { double s = 0; for (double x : h) s += x; return s; };
  auto put = [&](const char* id, double kwh) {
    if (overrides_.count(id)) return;
    EntityValue v;
    v.state = numText(kwh, 2);
    v.attrs["unit_of_measurement"] = "kWh";
    v.updatedEpoch = now_;
    statsOwned_.insert(id);
    out.emplace_back(id, v);
  };
  auto series = [&](const char* id, const std::vector<double>& h) {
    if (overrides_.count(id)) return;
    EntityValue v;
    v.state = numText(total(h), 2);
    v.attrs["today"] = jsonArray(h, 3);
    v.updatedEpoch = now_;
    statsOwned_.insert(id);
    out.emplace_back(id, v);
  };
  if (sAny) { put(kSolarToday, total(solar)); series(kSolarHourly, solar); }
  if (iAny) put(kImportToday, total(imp));
  if (eAny) put(kExportToday, total(exp));
  if (sAny || iAny) {
    std::vector<double> use(24, 0.0);
    for (int i = 0; i < 24; ++i) use[i] = std::max(0.0, solar[i] + imp[i] - exp[i] + bout[i] - bin[i]);
    put(kEnergyToday, total(use));
    series(kUsageHourly, use);
  }
}

void EntityAdapter::resolve() {
  resolved_.clear();
  for (auto& l : fixedLogical()) {
    EntitySource s;
    if (auto it = overrides_.find(l); it != overrides_.end()) {
      s.ha = it->second;
      s.why = "override";
      if (!s.ha.empty() && s.ha[0] == '-') { s.sign = -1; s.ha.erase(0, 1); }
    } else if (auto e = energy_.find(l); e != energy_.end()) {
      s = e->second;
    } else {
      s.ha = l;
      s.why = "identity";
    }
    resolved_[l] = s;
  }
  for (auto& kv : overrides_)   // sensor.x4_route_* overrides (older settings) still map
    if (!resolved_.count(kv.first)) {
      EntitySource s{kv.second, "", 1, "override"};
      if (!s.ha.empty() && s.ha[0] == '-') { s.sign = -1; s.ha.erase(0, 1); }
      resolved_[kv.first] = s;
    }
}

std::set<std::string> EntityAdapter::watchIds() const {
  std::set<std::string> ids;
  if (resolved_.empty()) {
    for (auto& l : fixedLogical()) ids.insert(l);
    return ids;
  }
  for (auto& kv : resolved_) {
    if (isStatId(kv.first) && statsOwned_.count(kv.first)) continue;
    if (kv.first == kHomePower && std::string(kv.second.why) == "identity" && (hasSolar_ || hasGrid_)) {
      ids.insert(kv.second.ha);   // still watch an HA sensor.home_power (it wins if present)
      continue;
    }
    if (!kv.second.ha.empty()) ids.insert(kv.second.ha);
    if (!kv.second.minus.empty()) ids.insert(kv.second.minus);
  }
  return ids;
}

std::map<std::string, EntitySource> EntityAdapter::sources() const {
  std::map<std::string, EntitySource> m;
  for (auto& kv : resolved_)
    if (std::string(kv.second.why) != "identity" || raw_.count(kv.second.ha)) m[kv.first] = kv.second;
  return m;
}

bool EntityAdapter::sourceOf(const std::string& logical, EntitySource& s) const {
  auto it = resolved_.find(logical);
  if (it == resolved_.end()) return false;
  s = it->second;
  return true;
}

bool EntityAdapter::numberOf(const std::string& haId, double& w, bool power) const {
  auto it = raw_.find(haId);
  if (it == raw_.end() || !parseNum(it->second.state, w)) return false;
  std::string u = attrOf(it->second, "unit_of_measurement");
  if (power) {
    if (u == "kW") w *= 1000;
    else if (u == "MW") w *= 1e6;
  } else {
    if (u == "Wh") w /= 1000;
    else if (u == "MWh") w *= 1000;
  }
  return true;
}

void EntityAdapter::emitLogical(const std::string& logical, EntityUpdates& out) {
  if (resolved_.empty()) resolve();
  EntitySource s;
  if (!sourceOf(logical, s)) return;
  if (isStatId(logical) && statsOwned_.count(logical) && std::string(s.why) != "override") return;
  auto it = raw_.find(s.ha);
  if (it == raw_.end()) return;
  const EntityValue& src = it->second;
  EntityValue v;
  v.updatedEpoch = src.updatedEpoch;
  if (auto fn = src.attrs.find("friendly_name"); fn != src.attrs.end()) v.attrs["friendly_name"] = fn->second;
  if (isPowerId(logical)) {
    double w;
    if (!numberOf(s.ha, w, true)) { v.state = src.state; out.emplace_back(logical, v); return; }   // unknown → "—"
    if (!s.minus.empty()) {
      double m;
      if (!numberOf(s.minus, m, true)) return;
      w -= m;
      if (auto m2 = raw_.find(s.minus); m2 != raw_.end()) v.updatedEpoch = std::max(v.updatedEpoch, m2->second.updatedEpoch);
    }
    v.state = numText(w * s.sign, 0);
    v.attrs["unit_of_measurement"] = "W";
    if (s.minus.empty() && attrOf(src, "unit_of_measurement") == "W") {   // precision of a W source still holds
      EntityValue p = withPrecision(s.ha, src);
      if (auto dp = p.attrs.find("display_precision"); dp != p.attrs.end()) v.attrs["display_precision"] = dp->second;
    }
  } else if (logical == kPrices) {
    v = src;
    auto p = priceSeries(src, now_);
    if (p.hourly.size() == 24) v.attrs["today"] = jsonArray(p.hourly, 4);
    else v.attrs.erase("today");
    if (p.quarters.size() == 96) v.attrs["quarters"] = jsonArray(p.quarters, 4);   // "now" = this quarter (#151)
    else v.attrs.erase("quarters");
  } else if (s.sign < 0) {
    v = withPrecision(s.ha, src);
    double x;
    if (parseNum(src.state, x)) v.state = numText(-x, 3);
  } else {
    v = withPrecision(s.ha, src);
  }
  out.emplace_back(logical, v);
}

void EntityAdapter::emitDerived(EntityUpdates& out) {
  EntitySource hs;
  if (sourceOf(kHomePower, hs) && std::string(hs.why) != "identity") return;   // override wins
  if (raw_.count(kHomePower)) return;                                         // HA has its own sensor.home_power
  if (!hasSolar_ && !hasGrid_) return;
  // home = solar + grid import + battery discharge (logical battery: + = charging). Every source the Energy
  // dashboard has must be known, otherwise the sum would be wrong → no value ("—").
  double total = 0;
  int64_t t = 0;
  const bool roles[3] = {hasSolar_, hasGrid_, hasBattery_};
  const char* ids[3] = {kSolarPower, kGridPower, kBattPower};
  for (int k = 0; k < 3; ++k) {
    if (!roles[k]) continue;
    EntityUpdates tmp;
    emitLogical(ids[k], tmp);
    double w;
    if (tmp.empty() || !parseNum(tmp.back().second.state, w)) return;
    total += k == 2 ? -w : w;
    t = std::max(t, tmp.back().second.updatedEpoch);
  }
  EntityValue v;
  v.state = numText(std::max(0.0, total), 0);
  v.attrs["unit_of_measurement"] = "W";
  v.updatedEpoch = t;
  out.emplace_back(kHomePower, v);
}

void EntityAdapter::ingest(const std::string& haId, const EntityValue& v, EntityUpdates& out) {
  if (resolved_.empty()) resolve();
  raw_[haId] = v;
  bool used = false, power = false;
  for (auto& kv : resolved_) {
    if (kv.second.ha == haId || kv.second.minus == haId) {
      used = true;
      emitLogical(kv.first, out);
      power |= isPowerId(kv.first);
    }
  }
  if (power && (hasSolar_ || hasGrid_)) emitDerived(out);
  // pass through everything that is not a logical id and not a mere sensor source (lights, climate, x4.*, …); an
  // unmapped sensor.x4_route_* is an HA sensor of that name (a route tile's entity, #145)
  if ((!isLogicalId(haId) || !resolved_.count(haId)) && (keep_.count(haId) || !(used && haId.compare(0, 7, "sensor.") == 0)))
    out.emplace_back(haId, withPrecision(haId, v));
}

EntityValue EntityAdapter::withPrecision(const std::string& haId, const EntityValue& v) const {
  auto it = precision_.find(haId);
  if (it == precision_.end() || v.attrs.count("display_precision")) return v;
  EntityValue c = v;
  c.attrs["display_precision"] = std::to_string(it->second);
  return c;
}

void EntityAdapter::setPrecision(const std::string& haId, int dp, EntityUpdates& out) {
  auto it = precision_.find(haId);
  if (dp < 0) { if (it == precision_.end()) return; precision_.erase(it); }
  else if (it != precision_.end() && it->second == dp) return;
  else precision_[haId] = dp;
  auto r = raw_.find(haId);
  if (r == raw_.end()) return;
  EntityValue v = r->second;   // ingest() writes raw_[haId]
  ingest(haId, v, out);
}

void EntityAdapter::remapAll(EntityUpdates& out) {
  resolve();
  for (auto& kv : resolved_) emitLogical(kv.first, out);
  emitDerived(out);
}

}  // namespace x4
