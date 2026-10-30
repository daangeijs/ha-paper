// Power saving on the device (#10, ROBUSTNESS_PLAN Phase 3): runs core/power.h powerDecision() from the main loop and
// takes the display into deep sleep; glance wakes (core/glance.h): Wi-Fi from the RTC cache, one HA snapshot, redraw
// only when a visible value changed, sleep again, 20 s cap. A key press means live mode for `liveMin` minutes; on USB
// it is always live. First-boot safety: no deep sleep before kArmBoots confirmed boots of this version or 30 min online
// with a confirmed image (#231, userdata /arm.json), a Right key held through the boot screen keeps it live 10 min, a USB host blocks sleep (external power).
//
// Sleep entry: home page + ambient chrome drawn (App::prepareSleep), snapshot → RTC, WebSocket closed, Wi-Fi off, then
// the board: panel deep-sleep command, front light parked, rails down, GPIO1 latch held, ext1 wake Power/Right,
// ext0 wake charger STAT, timer (hw/x4_board.cpp). QEMU has no deep sleep: RTC record + fake wake cause + esp_restart().
#pragma once
#include <ArduinoJson.h>

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "app/app.h"
#include "core/glance.h"
#include "core/power.h"
#include "hw/platform.h"

namespace x4::net {

enum class WakeKind : uint8_t { Cold, Timer, Button, Charger, Other };

void powerEarlyBoot();               // first line of setup(): RTC record, wake cause (before diagEarlyBoot)
bool powerSimulatedWake();           // QEMU: this reset ended a simulated deep sleep (diag records DEEPSLEEP)
WakeKind powerWake();
const char* powerWakeName();         // cold | timer | button | charger | other
// After services.begin(), before App::begin(): true = hold the panel, no boot screen (glance wake, or a key wake from
// glance sleep until the data is in, #299).
bool powerBegin(const DisplaySettings& s);
// Hardware sleep (main.cpp, not under QEMU): seconds = timer wake, 0 = Power/Right key or charger only. No return.
void powerOnSleep(std::function<void(int64_t seconds)> fn);
void powerLoop(App& app, Board& board);   // main loop, every pass
int powerArmBootsLeft();             // GET /diagnostics deep_sleep (any task)
const char* powerArmedBy();          // "uptime" | "boots" | nullptr (#231, any task)
std::string powerBatteryJson();      // GET /diagnostics battery (#231, any task)
// GET /diagnostics power_trail (#225, any task): last /power.txt line when this boot started, and the newest lines
void powerTrail(std::string& beforeBoot, std::vector<std::string>& lines);
uint32_t powerEmptySleeps();         // GET /diagnostics power_trail.empty_house_sleeps (#331, any task)
std::string powerPhasesJson();       // GET /diagnostics power_trail.phases (#327, any task): this boot + ended boots
// App::onPowerStage (main task): append the Power key stage to /power.txt, closed before the App goes on
void powerKeyStage(const char* stage);
const char* powerMode();             // GET /status power.mode: awake | glance (a glance wake in progress)
// POST /api/v1/device/sleep (#178, any task): core sleepNowCheck on the last power inputs; 202 = powerLoop enters deep
// sleep within a second (checked once more there), skipping liveMin and the API quiet.
SleepNowCheck powerSleepRequest(bool isNumber, double seconds);
// GET /status (any task): power wakes / redraws / failedWakes / awakeS / asleepS / lastWake, and refreshes (#178).
void powerTallyJson(JsonObject power, JsonObject refreshes);
int powerAppliedCpuMhz();            // GET /status power.applied (#177): clock the power rules set (240 | 80)
const char* powerAppliedWifiPs();    // modem sleep the power rules set: none | min
// Wi-Fi fast connect cache in RTC memory (net/wifi_mgr.cpp, net task): f runs locked, the record is sealed after.
void powerWifiCache(const std::function<void(glance::WifiCache&)>& f);

#if X4_QEMU
// POST /__qemu/power: power source, skip the first-boot count, API idle; charging + cell mV (#249, 0 = 3950)
void powerSimSet(bool battery, bool armed, bool charging = false, int mv = 0);
bool powerSimBattery();                       // QemuBoard::power(): USB (always live) unless set to battery
bool powerSimCharging();                      // QemuBoard::power(): charger STAT
uint16_t powerSimMv();                        // QemuBoard::power(): VCELL
#endif

}  // namespace x4::net
