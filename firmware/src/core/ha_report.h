// Device health as Home Assistant entities (#32), a 1:1 port of emulator/src/core/haReport.ts. Pure; checked against
// spec/test-vectors/ha-report.json. Device glue (POST /api/states/<id> with the display's HA key): net/ha_report.cpp.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace x4::ha_report {

constexpr uint32_t kMinGapMs = 60000;    // never two pushes within a minute
constexpr uint32_t kRetryMs = 10000;     // except one early retry after a network failure (#123)
constexpr uint32_t kEveryMs = 600000;    // full push every 10 min (HA forgets these states on restart)

struct Health {
  std::string hostname, name, firmware, resetReason;
  int battery = 0;
  bool charging = false, usb = false;
  bool hasRssi = false;   // false: no Wi-Fi reading (QEMU Ethernet) → no wifi_signal entity
  int rssi = 0;
  int64_t lastFullEpoch = 0, bootEpoch = 0;   // seconds; before 1700000000 (clock not set) → entity left out
};

struct State {
  std::string entityId, state;
  std::string attributes;   // JSON object text, keys in emulator order
};

struct Last {
  uint32_t atMs = 0;
  int battery = 0;
  bool charging = false;
  bool retry = false;   // the last push failed on the network: due again after kRetryMs, not kMinGapMs
};

std::string slug(const std::string& hostname);   // "ha-paper-a1b2.local" → "ha_paper_a1b2"
std::vector<State> states(const Health& h);
std::string body(const State& s);                // POST body: {"state":…,"attributes":{…}}
// last == nullptr: never pushed this boot. force: (re)connected or the toggle turned on. nowMs/atMs: millis().
bool due(const Last* last, bool force, uint32_t nowMs, int battery, bool charging);

}  // namespace x4::ha_report
