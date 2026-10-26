// Power decision (docs/ROBUSTNESS_PLAN.md Phase 3), a 1:1 port of emulator/src/core/power.ts: may the display
// deep-sleep now, when must it wake, how hard should CPU and Wi-Fi work while awake. Pure; checked against
// spec/test-vectors/power/*.json. Device glue: net/power.cpp (glance, #10).
#pragma once
#include <cstdint>
#include <string>

namespace x4 {

enum class PowerSave : uint8_t { Off, Night, Standby, Glance };   // glance: default on battery (#10, #18)
enum class OtaAuto : uint8_t { Off, Notify, Night };
enum class CpuProfile : uint8_t { Full, Auto };   // Full = 240 MHz; Auto = 80 MHz (cpuMhzFor, #177)
enum class WifiPs : uint8_t { None, Min };        // None = no modem sleep; Min = modem sleep (DTIM)

constexpr int64_t kMaxSleepS = 8 * 3600;      // a missed wake source must never leave the device off longer
constexpr int64_t kApiQuietMs = 120000;       // no deep sleep within 2 min of an API request
constexpr int kLowBatteryPct = 5;             // below: sleep until a button or the charger wakes it
constexpr double kRecentChargeMin = 30;       // charged within 30 min and ≥ 4.15 V counts as external power
constexpr double kFullVoltage = 4.15;
constexpr int kOtaHour = 3;                   // auto install / daily check window 03:00–04:00 (net/ota.cpp)
constexpr int64_t kGlanceBackoffMaxS = 2 * 3600;   // glance wait after failed wakes: wakeEvery doubled per failure

struct PowerInputs {
  int64_t nowEpoch = 0;          // seconds (UTC)
  int32_t localSec = 0;          // seconds since local midnight
  PowerSave powerSave = PowerSave::Off;
  int wakeEvery = 15;            // minutes, standby timer wake
  std::string night = "off";     // "23-07" | "off"
  bool peeking = false;          // dashboard shown for 60 s after a key press at night
  bool standby = false;          // standby face is on
  bool charging = false;
  bool usb = false;              // USB host connected (USB-JTAG)
  double chargedAgoMin = -1;     // < 0 = not since boot
  double voltage = -1;           // < 0 = unknown
  int battery = -1;              // %, < 0 = gauge not read yet
  bool otaPendingVerify = false; // a deep-sleep wake is a reset, a reset rolls an unconfirmed image back
  bool otaBusy = false;          // download / install running
  OtaAuto otaAuto = OtaAuto::Notify;
  bool otaDue = false;           // an install (auto night) or the daily check is due
  bool setup = false;            // AP / setup wizard
  int64_t msSinceApi = -1;       // < 0 = no API request since boot
  bool live = false;             // glance: key press / touch within liveMin minutes (or a key held at boot)
  int glanceFails = 0;           // glance: wakes in a row that could not reach HA
  int armBootsLeft = 0;          // first-boot safety: confirmed boots still needed before any deep sleep
};

struct PowerDecision {
  bool deepSleepNow = false;
  int64_t wakeAtEpoch = 0;       // 0 = none (awake, or low battery: button/charger only)
  bool buttonWakeOnly = false;
  CpuProfile cpuProfile = CpuProfile::Full;
  WifiPs wifiPs = WifiPs::None;
  bool external = false;
  const char* reason = "";       // same words as the emulator ("unconfirmed image", "night", …)
};

int64_t secsUntil(int32_t localSec, int32_t targetSec);   // next targetSec of the day; equal = a full day
int64_t glanceWaitS(int wakeEvery, int fails);            // wakeEvery·60 doubled per failure (max 4×), ≤ 2 h
bool isExternalPower(const PowerInputs& i);
PowerDecision powerDecision(const PowerInputs& i);

// POST /api/v1/device/sleep {"seconds": N} (#178, emulator sleepNowCheck, spec/test-vectors/sleep-now.json): deep sleep
// now, skipping liveMin and the API quiet. 422 bad seconds; 409 "stays awake: <powerDecision word>" on an unconfirmed
// image, OTA, external power, setup. isNumber false = missing / not a JSON number.
constexpr int64_t kSleepNowMinS = 60, kSleepNowMaxS = 86400;
struct SleepNowCheck { int status; std::string error; };   // 202 = sleep
SleepNowCheck sleepNowCheck(bool isNumber, double seconds, const PowerInputs& i);

const char* powerSaveName(PowerSave p);   // off | night | standby | glance
bool parsePowerSave(const std::string& s, PowerSave& out);
const char* cpuProfileName(CpuProfile p); // full | auto
const char* wifiPsName(WifiPs p);         // none | min
// Clock per profile (emulator CPU_MHZ, #177). No CONFIG_PM_ENABLE in the Arduino libs, so no esp_pm DFS: Auto is a
// fixed 80 MHz, the lowest clock that keeps APB at 80 MHz (UART, SPI to the panel, I2C, Wi-Fi unchanged).
int cpuMhzFor(CpuProfile p);              // 240 | 80

// Charging honesty (issue #11, emulator powerSource/batteryLabel, spec/test-vectors/battery-label.json): "charging"
// only when the charger STAT pin says so; a full battery on USB drops STAT, so a seen USB host reads "on USB".
// No VBUS pin is confirmed on the X4 Pro: a full battery on a charger without data lines still reads "battery".
const char* powerSource(bool charging, bool usb);                  // usb | battery
std::string batteryLabel(int pct, bool charging, bool usb);        // "80% · charging" | "100% · on USB" | "64%"

}  // namespace x4
