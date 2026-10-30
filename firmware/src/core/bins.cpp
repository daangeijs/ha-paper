#include "core/bins.h"

#include <algorithm>
#include <cstdlib>
#include "core/config.h"
#include "core/history.h"
#include "core/home.h"
#include "core/json.h"

namespace x4 {
namespace bins {

namespace {
constexpr int64_t kDay = 86400000;

int64_t floorDiv(int64_t a, int64_t b) { return a / b - ((a % b != 0) && ((a < 0) != (b < 0))); }
int64_t localDay(int64_t ms, int tz) { return floorDiv(ms + int64_t(tz) * 60000, kDay); }

int64_t civilDay(int64_t y, int m, int d) {   // H. Hinnant days_from_civil
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400, yoe = y - era * 400;
  const int64_t doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1, doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468;
}
int mdayOf(int64_t z) {   // H. Hinnant civil_from_days, day of month only
  z += 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097, doe = z - era * 146097;
  const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365, doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const int64_t mp = (5 * doy + 2) / 153;
  return int(doy - (153 * mp + 2) / 5 + 1);
}
int wdayOf(int64_t z) { return int(((z % 7) + 11) % 7); }   // 1970-01-01 = Thursday (4)

bool digits(const std::string& s, size_t from, size_t n) {
  for (size_t i = from; i < from + n; ++i) if (i >= s.size() || s[i] < '0' || s[i] > '9') return false;
  return true;
}
std::string trim(const std::string& s) {
  size_t a = s.find_first_not_of(" \t\n\r"), b = s.find_last_not_of(" \t\n\r");
  return a == std::string::npos ? std::string() : s.substr(a, b - a + 1);
}

// A date: ISO (core/history parseTime, no offset = local) or "29-10-2026" -> local day number; false when not a date.
bool dayOfText(const std::string& raw, int tz, int64_t& out) {
  std::string s = trim(raw);
  if (s.size() == 10 && s[2] == '-' && s[5] == '-' && digits(s, 0, 2) && digits(s, 3, 2) && digits(s, 6, 4)) {
    int d = std::atoi(s.substr(0, 2).c_str()), mo = std::atoi(s.substr(3, 2).c_str());
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    out = civilDay(std::atoi(s.substr(6, 4).c_str()), mo, d);   // Date.UTC rolls 31 Nov over into December
    return true;
  }
  int64_t t = hist::parseTime(raw.c_str(), raw.size(), tz);
  if (t == hist::kNoTime) return false;
  out = localDay(t, tz);
  return true;
}
// /^\d+$/ after trim (JS Number of the text)
bool intOf(const std::string& raw, int64_t& out) {
  std::string s = trim(raw);
  if (s.empty() || s.size() > 9 || !digits(s, 0, s.size())) return false;
  out = std::atoll(s.c_str());
  return true;
}
const char* attrOf(const EntityValue* v, const char* k) {
  auto it = v->attrs.find(k);
  return it == v->attrs.end() ? nullptr : it->second.c_str();
}
}  // namespace

int days(const std::string& state, const char* daysTo, const char* upcoming, int64_t nowMs, int tz) {
  if (state == "unavailable" || state == "unknown") return kUnknown;
  const int64_t today = localDay(nowMs, tz);
  int64_t d;
  if (dayOfText(state, tz, d) && d >= today) return int(d - today);
  if (intOf(state, d) && today + d >= today) return int(d);
  if (daysTo && intOf(daysTo, d)) return int(d);
  Json j;
  if (upcoming && parseJson(upcoming, j) && j.isArr())
    for (auto& e : j.arr) {
      const Json* s = e.isObj() ? e.get("date") : &e;
      if (s && s->isStr() && dayOfText(s->str, tz, d) && d >= today) return int(d - today);
    }
  return kUnknown;
}

int days(const EntityValue* v, int64_t nowMs, int tz) {
  if (!v) return kUnknown;
  return days(std::string(v->state.c_str()), attrOf(v, "daysTo"), attrOf(v, "upcoming"), nowMs, tz);
}

View view(const std::vector<In>& bins, int64_t nowMs, int tz, int tonightHour, Lang lang) {
  View out;
  const int64_t today = localDay(nowMs, tz);
  const int64_t minute = (((nowMs + int64_t(tz) * 60000) % kDay + kDay) % kDay) / 60000;
  static const S kDayName[7] = {S::day0, S::day1, S::day2, S::day3, S::day4, S::day5, S::day6};
  static const S kShort[7] = {S::dayShort0, S::dayShort1, S::dayShort2, S::dayShort3, S::dayShort4, S::dayShort5, S::dayShort6};
  for (auto& b : bins) {
    int n = days(b.v, nowMs, tz);
    if (n == kUnknown) continue;
    Row r;
    r.label = b.label;
    r.days = n;
    r.when = n == 0 ? tr(lang, S::binToday) : n == 1 ? tr(lang, S::binTomorrow) : tr(lang, S::binInDays, std::to_string(n));
    const int64_t z = today + n;
    const std::string md = std::to_string(mdayOf(z));
    r.date = std::string(tr(lang, kDayName[wdayOf(z)])) + " " + md;
    r.shortDate = std::string(tr(lang, kShort[wdayOf(z)])) + " " + md;
    out.rows.push_back(std::move(r));
  }
  std::stable_sort(out.rows.begin(), out.rows.end(), [](const Row& a, const Row& b) { return a.days < b.days; });
  if (out.rows.empty()) return out;
  const Row& first = out.rows[0];
  size_t same = 0;
  for (auto& r : out.rows) {
    if (r.days != first.days) break;
    out.head += (same++ ? " + " : "") + r.label;
  }
  out.restFrom = same;
  out.tonight = first.days == 1 && minute >= int64_t(tonightHour) * 60;
  out.big = first.when;
  out.line = out.tonight ? tr(lang, S::binLineTonight, first.date) : tr(lang, S::binLine, first.when, first.date);
  out.foot = out.tonight ? tr(lang, S::binPutOut) : first.date;
  out.pill = out.tonight ? tr(lang, S::binTonight) : first.days == 0 ? tr(lang, S::binToday) : "";
  return out;
}

std::vector<In> inputs(const std::string& entities, const std::string& labels, const EntityStore& store) {
  std::vector<In> out;
  auto pairs = labelPairs(labels);
  for (auto& id : listOf(entities)) {
    const EntityValue* v = store.get(id);
    std::string lab;
    for (auto& p : pairs) if (p.first == id && !p.second.empty()) { lab = p.second; break; }
    if (lab.empty()) lab = friendlyName(id, v);
    out.push_back({lab, v});
  }
  return out;
}

int tonightHour(const std::string& f) {
  int64_t h;
  return intOf(f, h) && h <= 23 ? int(h) : kTonightDefault;
}

}  // namespace bins
}  // namespace x4
