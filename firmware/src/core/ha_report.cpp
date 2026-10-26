#include "core/ha_report.h"

#include <cctype>
#include <cstdio>
#include <cstdlib>

#include "core/json.h"
#include "core/power.h"

namespace x4::ha_report {

namespace {

constexpr int64_t kSaneEpoch = 1700000000;

// "2025-10-16T07:33:20+00:00" (UTC; days → civil date, H. Hinnant's algorithm: no gmtime needed)
std::string iso(int64_t epoch) {
  int64_t days = epoch / 86400, secs = epoch % 86400;
  days += 719468;
  const int64_t era = days / 146097, doe = days - era * 146097;
  const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100), mp = (5 * doy + 2) / 153;
  const int d = int(doy - (153 * mp + 2) / 5 + 1), m = int(mp < 10 ? mp + 3 : mp - 9);
  const int y = int(yoe + era * 400 + (m <= 2));
  char b[32];
  snprintf(b, sizeof b, "%04d-%02d-%02dT%02d:%02d:%02d+00:00", y, m, d, int(secs / 3600), int(secs / 60 % 60), int(secs % 60));
  return b;
}

}  // namespace

std::string slug(const std::string& hostname) {
  std::string h = hostname;
  if (h.size() > 6 && h.compare(h.size() - 6, 6, ".local") == 0) h.resize(h.size() - 6);
  std::string out;
  bool sep = false;
  for (char c : h) {
    c = char(tolower(static_cast<unsigned char>(c)));
    if (isalnum(static_cast<unsigned char>(c))) {
      if (sep && !out.empty()) out += '_';
      sep = false;
      out += c;
    } else {
      sep = true;
    }
  }
  return out;
}

std::vector<State> states(const Health& h) {
  const std::string id = slug(h.hostname);
  std::vector<State> out;
  // extra: further attribute members, already JSON ("\"k\":\"v\",…") or empty
  auto add = [&](const char* domain, const char* key, const char* label, const std::string& state, const std::string& extra = "") {
    out.push_back({std::string(domain) + "." + id + "_" + key, state,
                   "{\"friendly_name\":" + jsonQuote(h.name + " " + label) + (extra.empty() ? "" : "," + extra) + "}"});
  };
  add("sensor", "battery", "battery", std::to_string(h.battery),
      "\"unit_of_measurement\":\"%\",\"device_class\":\"battery\",\"state_class\":\"measurement\"");
  add("binary_sensor", "charging", "charging", h.charging ? "on" : "off",
      std::string("\"device_class\":\"battery_charging\",\"source\":\"") + powerSource(h.charging, h.usb) + "\"");
  if (h.hasRssi)
    add("sensor", "wifi_signal", "Wi-Fi signal", std::to_string(h.rssi),
        "\"unit_of_measurement\":\"dBm\",\"device_class\":\"signal_strength\",\"state_class\":\"measurement\"");
  if (h.lastFullEpoch >= kSaneEpoch) add("sensor", "last_full_refresh", "last full refresh", iso(h.lastFullEpoch), "\"device_class\":\"timestamp\"");
  if (h.bootEpoch >= kSaneEpoch) add("sensor", "last_boot", "last boot", iso(h.bootEpoch), "\"device_class\":\"timestamp\"");
  add("sensor", "firmware", "firmware", h.firmware);
  add("sensor", "reset_reason", "reset reason", h.resetReason);
  return out;
}

std::string body(const State& s) { return "{\"state\":" + jsonQuote(s.state) + ",\"attributes\":" + s.attributes + "}"; }

bool due(const Last* last, bool force, uint32_t nowMs, int battery, bool charging) {
  if (!last) return true;
  const uint32_t elapsed = nowMs - last->atMs;   // unsigned: survives the millis() wrap
  if (elapsed < (last->retry ? kRetryMs : kMinGapMs)) return false;
  return force || elapsed >= kEveryMs || abs(battery - last->battery) >= 1 || charging != last->charging;
}

}  // namespace x4::ha_report
