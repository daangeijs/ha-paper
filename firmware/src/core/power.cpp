#include "core/power.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>

#include "core/empty_house.h"
#include "core/logic.h"

namespace x4 {

int64_t secsUntil(int32_t localSec, int32_t targetSec) {
  int64_t d = ((int64_t(targetSec) - localSec) % 86400 + 86400) % 86400;
  return d == 0 ? 86400 : d;
}

int64_t glanceWaitS(int32_t localSec, const std::string& quiet) {
  const int64_t midnight = secsUntil(localSec, 0);
  return nightEndHour(quiet) < 0 ? midnight : std::min(midnight, secsUntil(localSec, std::atoi(quiet.c_str()) * 3600));
}

bool isExternalPower(const PowerInputs& i) {
  return i.charging || i.usb || (i.chargedAgoMin >= 0 && i.chargedAgoMin < kRecentChargeMin && i.voltage >= kFullVoltage);
}

PowerDecision powerDecision(const PowerInputs& i) {
  PowerDecision d;
  d.external = isExternalPower(i);
  d.cpuProfile = d.external || i.otaBusy || i.battery < 0 ? CpuProfile::Full : CpuProfile::Auto;
  d.wifiPs = d.external || i.otaBusy || i.setup ? WifiPs::None : WifiPs::Min;
  auto awake = [&](const char* why) { d.reason = why; return d; };

  if (i.otaPendingVerify) return awake("unconfirmed image");
  if (i.otaBusy) return awake("ota running");
  if (d.external) return awake("external power");
  if (i.armBootsLeft > 0) return awake("not armed");
  if (i.battery < 0) return awake("battery unknown");
  if (i.battery < kLowBatteryPct) { d.deepSleepNow = true; d.buttonWakeOnly = true; return awake("low battery"); }
  if (i.setup) return awake("setup mode");
  if (i.msSinceApi >= 0 && i.msSinceApi < kApiQuietMs) return awake("recent api");
  const int hour = (i.localSec / 3600) % 24;
  const bool otaWanted = i.otaDue && i.otaAuto != OtaAuto::Off;
  if (otaWanted && hour == kOtaHour) return awake("ota window");
  if (i.powerSave == PowerSave::Off) return awake("power save off");
  if (i.powerSave == PowerSave::Glance && i.live) return awake("live");

  const bool quiet = isNightHour(hour, i.quiet) && !i.peeking;   // quiet hours (#295): no timer wakes in the window
  int64_t wait = kMaxSleepS;
  if (quiet) { d.reason = "quiet"; wait = std::min(wait, secsUntil(i.localSec, nightEndHour(i.quiet) * 3600)); }
  else if (i.powerSave == PowerSave::Standby && i.standby) { d.reason = "standby"; wait = std::min<int64_t>(wait, int64_t(i.wakeEvery) * 60); }
  else if (i.powerSave == PowerSave::Glance && i.emptyHouse) { d.reason = "empty house"; wait = std::min(wait, emptyWaitS(i.localSec, i.quiet)); }   // #331
  else if (i.powerSave == PowerSave::Glance) { d.reason = "glance"; wait = std::min(wait, glanceWaitS(i.localSec, i.quiet)); }   // #356
  else return awake("awake");
  if (otaWanted) wait = std::min(wait, secsUntil(i.localSec, kOtaHour * 3600));
  d.deepSleepNow = true;
  d.wakeAtEpoch = i.nowEpoch + wait;
  return d;
}

const char* powerSaveName(PowerSave p) {
  return p == PowerSave::Standby ? "standby" : p == PowerSave::Glance ? "glance" : "off";
}
bool parsePowerSave(const std::string& s, PowerSave& out) {
  if (s == "off") out = PowerSave::Off;
  else if (s == "standby") out = PowerSave::Standby;
  else if (s == "glance") out = PowerSave::Glance;
  else return false;
  return true;
}
const char* cpuProfileName(CpuProfile p) { return p == CpuProfile::Auto ? "auto" : "full"; }
SleepNowCheck sleepNowCheck(bool isNumber, double seconds, const PowerInputs& i) {
  if (!isNumber || seconds != std::floor(seconds) || seconds < double(kSleepNowMinS) || seconds > double(kSleepNowMaxS))
    return {422, "seconds must be an integer from " + std::to_string(kSleepNowMinS) + " to " + std::to_string(kSleepNowMaxS)};
  auto no = [](const char* why) { return SleepNowCheck{409, std::string("stays awake: ") + why}; };
  if (i.otaPendingVerify) return no("unconfirmed image");
  if (i.otaBusy) return no("ota running");
  if (isExternalPower(i)) return no("external power");
  if (i.setup) return no("setup mode");
  return {202, ""};
}

const char* wifiPsName(WifiPs p) { return p == WifiPs::Min ? "min" : "none"; }
int cpuMhzFor(CpuProfile p) { return p == CpuProfile::Auto ? 80 : 240; }

const char* powerSource(bool charging, bool usb) { return charging || usb ? "usb" : "battery"; }

std::string batteryLabel(int pct, bool charging, bool usb) {
  return std::to_string(pct) + "%" + (charging ? " · charging" : usb ? " · on USB" : "");
}

}  // namespace x4
