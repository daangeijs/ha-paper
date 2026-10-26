#include "core/power_trail.h"

#include <cstring>

namespace x4::powertrail {

std::string sleepMarker(const char* reason) { return std::string("sleep ") + (reason && *reason ? reason : "?"); }

std::string keyLine(uint32_t ms, int mv, bool usb) {
  return "key " + std::to_string(ms) + " " + std::to_string(mv) + " " + (usb ? "1" : "0");
}
std::string standbyLine(uint32_t ms) { return "standby drawn " + std::to_string(ms); }
std::string keyUpLine(uint32_t heldMs) { return "keyup " + std::to_string(heldMs); }

std::vector<std::string> lastLines(const std::string& trail, size_t n) {
  std::vector<std::string> all;
  size_t i = 0;
  while (i < trail.size()) {
    size_t e = trail.find('\n', i);
    if (e == std::string::npos) e = trail.size();
    if (e > i) all.push_back(trail.substr(i, e - i));
    i = e + 1;
  }
  if (all.size() > n) all.erase(all.begin(), all.end() - n);
  return all;
}

std::string lastLine(const std::string& trail) {
  auto l = lastLines(trail, 1);
  return l.empty() ? std::string() : l[0];
}

std::string append(const std::string& trail, const std::string& line) {
  std::string out;
  for (auto& l : lastLines(trail, kMaxLines - 1)) out += l + "\n";
  return out + line + "\n";
}

static bool starts(const std::string& s, const char* p) { return s.rfind(p, 0) == 0; }

Verdict verdict(const std::string& trail, const char* reset) {
  if (!reset || strcmp(reset, "POWERON") != 0) return Verdict::None;
  const std::string m = lastLine(trail);
  if (starts(m, "sleep ")) return Verdict::LostAsleep;
  if (m == kAwake || starts(m, "key ") || starts(m, "keyup ") || starts(m, "standby drawn ")) return Verdict::LostAwake;
  return Verdict::None;   // first boot with this firmware: no marker yet
}

const char* verdictName(Verdict v) {
  return v == Verdict::LostAsleep ? "lost-asleep" : v == Verdict::LostAwake ? "lost-awake" : "none";
}

std::string awakeWrite(const std::string& trail) { return lastLine(trail) == kAwake ? "" : append(trail, kAwake); }

std::string sleepWrite(const std::string& trail, const char* reason) {
  std::string m = sleepMarker(reason);
  return m == lastLine(trail) ? "" : append(trail, m);
}

}  // namespace x4::powertrail
