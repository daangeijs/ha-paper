#include "core/empty_house.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>

#include "core/logic.h"

namespace x4 {

namespace {
const char* const kDomains[] = {"zone", "binary_sensor", "input_boolean", "group"};
const char* const kOpenClasses[] = {"door", "window", "opening", "garage_door"};

std::string domainOfId(const std::string& id) {
  size_t d = id.find('.');
  return d == std::string::npos ? std::string() : id.substr(0, d);
}
bool presenceDomain(const std::string& d) {
  for (auto* k : kDomains) if (d == k) return true;
  return false;
}
bool openClass(const std::string& c) {
  for (auto* k : kOpenClasses) if (c == k) return true;
  return false;
}
}  // namespace

bool isOpeningClass(const char* c) { return c && openClass(c); }

bool validEmptySource(const std::string& v) {
  if (v.empty()) return true;
  size_t dot = v.find('.');
  if (dot == std::string::npos || dot == 0 || dot + 1 >= v.size() || v.find('.', dot + 1) != std::string::npos) return false;
  for (char c : v)
    if (!(c == '.' || c == '_' || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return false;
  return presenceDomain(v.substr(0, dot));
}

bool houseEmpty(const std::string& entity, const char* state) {
  if (entity.empty() || !state) return false;
  const std::string d = domainOfId(entity);
  if (d == "zone") {
    if (!*state) return false;
    for (const char* p = state; *p; ++p) if (*p < '0' || *p > '9') return false;
    return std::strspn(state, "0") == std::strlen(state);
  }
  return presenceDomain(d) && std::strcmp(state, "off") == 0;
}

int64_t emptyWaitS(int32_t localSec, const std::string& quiet) {
  if (nightEndHour(quiet) < 0) return kEmptyWaitS;
  const int start = std::atoi(quiet.c_str());
  int64_t toStart = ((int64_t(start) * 3600 - localSec) % 86400 + 86400) % 86400;
  return std::min<int64_t>(kEmptyWaitS, toStart ? toStart : 86400);
}

std::string emptyNextAt(int32_t localSec, const std::string& quiet, const std::string& clock) {
  const int64_t t = (int64_t(localSec) + emptyWaitS(localSec, quiet)) % 86400;
  const int h = int(t / 3600), m = int(t % 3600 / 60);
  return (clock == "12" ? std::to_string(h % 12 ? h % 12 : 12) : pad2(h)) + ":" + pad2(m);
}

Alarm alarmOf(const std::string& s) {
  if (s == "disarmed") return Alarm::Disarmed;
  if (s == "triggered") return Alarm::Triggered;
  return s.rfind("armed_", 0) == 0 || s == "arming" || s == "pending" ? Alarm::Armed : Alarm::None;
}

HouseFacts houseFacts(bool hasInside, double inside, std::vector<FactEntity> ents) {
  std::sort(ents.begin(), ents.end(), [](const FactEntity& a, const FactEntity& b) { return a.id < b.id; });
  HouseFacts f;
  f.hasInside = hasInside && std::isfinite(inside);
  f.inside = f.hasInside ? inside : 0;
  bool panel = false;
  for (auto& e : ents) {
    const std::string d = domainOfId(e.id);
    if (d == "binary_sensor" && openClass(e.deviceClass) && (e.state == "on" || e.state == "off")) {
      f.hasOpen = true;
      if (e.state == "on" && f.open++ == 0) f.firstOpen = e.name;
    } else if (d == "alarm_control_panel" && !panel) {
      panel = true;
      f.alarm = alarmOf(e.state);
    }
  }
  return f;
}

}  // namespace x4
