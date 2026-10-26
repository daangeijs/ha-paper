#include "core/power_trail.h"

#include <cstring>

namespace x4::powertrail {

std::string sleepMarker(const char* reason) { return std::string("sleep ") + (reason && *reason ? reason : "?"); }

Verdict verdict(const std::string& marker, const char* reset) {
  if (!reset || strcmp(reset, "POWERON") != 0) return Verdict::None;
  if (marker.rfind("sleep ", 0) == 0) return Verdict::LostAsleep;
  if (marker == kAwake) return Verdict::LostAwake;
  return Verdict::None;   // first boot with this firmware: no marker yet
}

const char* verdictName(Verdict v) {
  return v == Verdict::LostAsleep ? "lost-asleep" : v == Verdict::LostAwake ? "lost-awake" : "none";
}

std::string awakeWrite(const std::string& marker) { return marker == kAwake ? "" : kAwake; }

std::string sleepWrite(const std::string& marker, const char* reason) {
  std::string m = sleepMarker(reason);
  return m == marker ? "" : m;
}

}  // namespace x4::powertrail
