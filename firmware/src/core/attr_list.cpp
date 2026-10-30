#include "core/attr_list.h"

#include <cmath>
#include "core/history.h"
#include "core/json.h"
#include "core/logic.h"

namespace x4 {
namespace alist {

namespace {
constexpr int64_t kMin = 60000, kHour = 3600000, kDay = 86400000;
int64_t floorDiv(int64_t a, int64_t b) { return a / b - ((a % b != 0) && ((a < 0) != (b < 0))); }
int64_t localDay(int64_t ms, int tz) { return floorDiv(ms + int64_t(tz) * 60000, kDay); }
bool isDigit(char c) { return c >= '0' && c <= '9'; }
bool fieldName(const std::string& v) {   // /^[A-Za-z0-9_]+$/
  if (v.empty()) return false;
  for (char c : v) if (!(isDigit(c) || c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) return false;
  return true;
}
std::string trim(const std::string& s) {
  const char* ws = " \t\n\r\f\v";
  size_t a = s.find_first_not_of(ws), b = s.find_last_not_of(ws);
  return a == std::string::npos ? std::string() : s.substr(a, b - a + 1);
}
bool dateOnly(const std::string& s) {   // /^\d{4}-\d{2}-\d{2}$/ after trim
  if (s.size() != 10 || s[4] != '-' || s[7] != '-') return false;
  for (size_t i : {0, 1, 2, 3, 5, 6, 8, 9}) if (!isDigit(s[i])) return false;
  return true;
}
bool endsWith(const std::string& s, const char* t) {
  const size_t n = std::char_traits<char>::length(t);
  return s.size() >= n && s.compare(s.size() - n, n, t) == 0;
}
std::string fieldText(const Json& item, const std::string& key) {
  const Json* v = item.get(key);
  if (!v) return {};
  if (v->isStr()) return trim(v->str);
  if (!v->isNum() || !std::isfinite(v->num)) return {};
  const std::string s = fmtNum(jsRound(v->num * 10) / 10, "", -1);
  return endsWith(key, "_km") ? s + " km" : endsWith(key, "_m") ? s + " m" : s;
}
bool has(const Json& item, const std::string& k) { const Json* v = item.get(k); return v && !v->isNull(); }
}  // namespace

Spec specOf(const Widget& w) {
  auto f = [&](const char* k, const char* d) { std::string v = w.field(k); return v.empty() ? std::string(d) : v; };
  auto fb = [&](const char* k, const char* d) { return w.field(k).empty() ? std::string(d) : std::string(); };
  Spec s;
  s.attribute = f("attribute", "sightings");
  s.title = f("title", "title");
  s.time = f("time", "ts");
  s.subtitle = listOf(f("subtitle", "subtitle"));
  s.fbTitle = fb("title", "species");
  s.fbTime = fb("time", "observed_at");
  s.fbSubtitle = listOf(fb("subtitle", "place distance_km"));
  return s;
}

std::string error(const std::map<std::string, std::string>& f) {
  for (const char* k : {"attribute", "title", "time"}) {
    auto it = f.find(k);
    if (it != f.end() && !fieldName(it->second)) return std::string("attrList: ") + k + " must be a field name (letters, digits, _)";
  }
  auto it = f.find("subtitle");
  if (it != f.end()) {
    std::vector<std::string> l = listOf(it->second);
    bool bad = l.empty();
    for (auto& x : l) bad |= !fieldName(x);
    if (bad) return "attrList: subtitle must be field names (letters, digits, _) split by spaces";
    if (int(l.size()) > kMaxSubtitle) return "attrList: at most " + std::to_string(kMaxSubtitle) + " subtitle fields";
  }
  return {};
}

Rows rowsFor(int cs, int rs) {
  const bool one = cs >= 3;
  return {rs > 1 ? (one ? 10 : 6) : one ? 4 : 2, one};
}

std::string ago(const std::string& raw, bool isNum, double num, int64_t now, int tz, Lang l) {
  const int64_t t = isNum ? hist::parseTimeNum(num) : hist::parseTime(raw.c_str(), raw.size(), tz);
  if (t == hist::kNoTime) return {};
  const int64_t days = localDay(now, tz) - localDay(t, tz);
  if (!isNum && dateOnly(trim(raw)))
    return days < 0 ? std::string() : days == 0 ? tr(l, S::listToday) : days == 1 ? tr(l, S::listYesterday) : tr(l, S::listDaysAgo, std::to_string(days));
  const int64_t d = now - t;
  if (d < -5 * kMin) return {};
  if (d < kMin) return tr(l, S::listNow);
  if (d < kHour) return tr(l, S::listMinAgo, std::to_string(d / kMin));
  if (d < kDay) return tr(l, S::listHoursAgo, std::to_string(d / kHour));
  return days <= 1 ? std::string(tr(l, S::listYesterday)) : tr(l, S::listDaysAgo, std::to_string(days));
}

View view(const char* value, const Spec& s, int64_t now, int tz, Lang l, int max) {
  View out;
  Json v;
  if (!value || !parseJson(value, v) || !v.isArr()) return out;
  for (const Json& item : v.arr) {
    if (!item.isObj()) continue;
    std::string title = fieldText(item, !s.fbTitle.empty() && !has(item, s.title) ? s.fbTitle : s.title);
    if (title.empty()) continue;
    if (int(out.rows.size()) >= max) { ++out.more; continue; }
    Row r;
    r.title = std::move(title);
    bool anySub = false;
    for (auto& k : s.subtitle) anySub |= has(item, k);
    for (auto& k : !s.fbSubtitle.empty() && !anySub ? s.fbSubtitle : s.subtitle) {
      std::string p = fieldText(item, k);
      if (!p.empty()) r.sub += (r.sub.empty() ? "" : " · ") + p;
    }
    const Json* t = item.get(!s.fbTime.empty() && !has(item, s.time) ? s.fbTime : s.time);
    if (t && (t->isStr() || t->isNum())) r.ago = ago(t->str, t->isNum(), t->num, now, tz, l);
    out.rows.push_back(std::move(r));
  }
  return out;
}

std::vector<std::pair<std::string, std::string>> attrKeys(const Config& c) {
  std::vector<std::pair<std::string, std::string>> out;
  auto add = [&](const std::string& e, const std::string& k) {
    for (auto& o : out) if (o.first == e && o.second == k) return;
    out.emplace_back(e, k);
  };
  for (auto& sc : c.screens)
    for (auto& w : sc.widgets) {
      if (w.type != "attrList" || w.field("entity").empty()) continue;
      add(w.field("entity"), specOf(w).attribute);
      add(w.field("entity"), "attribution");
    }
  return out;
}

}  // namespace alist
}  // namespace x4
