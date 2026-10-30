// Battery history (eink-ha-os#231), a port of emulator/src/core/battery.ts: the gauge every 5 min, newest 288 rows (24 h), for
// GET /api/v1/diagnostics `battery`, plus the [BATT] log line. Rows live in PSRAM (core/psram_alloc.h, ~4.6 KB), lost
// on a reset or deep-sleep wake. Pure; vectors spec/test-vectors/battery-history.json. Device glue: net/power.cpp.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

#include "core/psram_alloc.h"

namespace x4::batt {

constexpr uint32_t kSampleS = 300;
constexpr size_t kRows = 288;
constexpr int kNoRssi = -128;

struct In {
  uint32_t ms = 0;          // millis()
  int64_t epoch = 0;        // 0 = clock unknown
  int pct = -1;             // < 0 = gauge not read
  int mv = -1;              // < 0 = not read
  bool chg = false, usb = false;
  const char* power = "";   // powerDecision reason (static string) or "glance"
  int rssi = kNoRssi;
};

struct Row {
  uint32_t t;               // epoch, or uptime seconds while the clock is unknown
  const char* power;        // static string
  int16_t mv;               // -1 = not read
  int8_t pct, rssi;         // rssi kNoRssi = not on Wi-Fi
  uint8_t chg, usb;
};

class History {
 public:
  // One power-loop pass; returns the log line to write ("" = none).
  std::string step(const In& i);
  size_t size() const { return n_; }
  const Row& at(size_t k) const { return buf_[(head_ + k) % kRows]; }   // 0 = oldest
  std::string json() const;   // {"interval_s":300,"fields":[…],"history":[[…],…]}

 private:
  std::vector<Row, PsramAlloc<Row>> buf_;
  size_t head_ = 0, n_ = 0;
  uint32_t lastMs_ = 0;
  bool sampled_ = false, seen_ = false, chg_ = false, usb_ = false;
};

std::string line(const In& i);   // "92% 4334 mV · chg 1 · usb 1 · rssi -78"

}  // namespace x4::batt
