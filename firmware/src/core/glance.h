// Glance mode (#10, "glance by default" on battery per #18), a port of emulator/src/core/glance.ts: the snapshot of
// what the panel shows (region key → FNV-1a hash), the wake decision (redraw only when a visible value changed), the
// Wi-Fi fast-connect cache, live mode and the first-boot safety counter. Plus the RTC_NOINIT record that carries all
// of it across deep sleep (layout here so the checksum logic is host-tested). Pure; vectors spec/test-vectors/glance.json.
// When to sleep and for how long: core/power.h powerDecision(). Device glue: net/power.cpp.
#pragma once
#include <cstddef>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "core/phases.h"

namespace x4::glance {

constexpr uint32_t kAwakeCapMs = 20000;        // a glance wake gives up after 20 s (HA unreachable = failed wake)
constexpr int kLiveMins[] = {1, 3, 5, 10};      // setting liveMin
constexpr int kDefaultLiveMin = 3;
constexpr int kOfflineAfter = 3;                // failed wakes in a row before the panel shows the offline mark
constexpr int kStaleMin = 60;                   // unchanged values: redraw anyway after 60 min (clock)
constexpr int64_t kWifiIpMaxAgeS = 3600;        // reuse the cached IP (no DHCP) while younger
constexpr int kWifiCacheMaxFails = 2;           // fast connects failed in a row → drop the cache
constexpr int kArmBoots = 3;                    // first-boot safety: confirmed boots with network before any sleep
constexpr double kArmUptimeMin = 30;            // ... or this long online in one boot with a confirmed image (#231)
constexpr int kBootHoldLiveMin = 10;            // a key held through the boot screen keeps it live this long

uint32_t fnv1a(const void* data, size_t n, uint32_t h = 0x811c9dc5u);
inline uint32_t fnv1a(const std::string& s) { return fnv1a(s.data(), s.size()); }

// What the panel shows, small enough for RTC memory: sorted by key hash. Regions past kMaxEntries - 1 fold into one.
constexpr int kMaxEntries = 48;
struct Entry { uint32_t key, val; };
struct Snapshot { uint8_t n; Entry e[kMaxEntries]; };
Snapshot snapshotOf(const std::map<std::string, std::string>& regions);   // App::regionSignatures()
// Key hashes that differ, plus keys only one side has; ignore = clock regions (key hashes). prev null = all of next.
std::vector<uint32_t> snapshotDiff(const Snapshot* prev, const Snapshot& next, const std::vector<uint32_t>& ignore);

struct StepIn { bool ok; int changed; bool hadSnapshot; int fails; bool drawnOffline; double minSinceDraw; };
struct StepOut { bool redraw; const char* reason; int fails; bool drawnOffline; };   // reason: same words as the emulator
StepOut step(const StepIn& i);

struct WifiCache {
  bool valid;
  uint32_t ssidHash;
  uint8_t bssid[6];
  uint8_t channel;
  uint8_t fails;                 // fast connects that failed in a row
  uint32_t ip, gw, mask, dns;    // network order (lwIP u32_addr)
  int64_t ipAtEpoch;             // when DHCP gave us ip; 0 = clock unknown
};
enum class WifiFast : uint8_t { None, Radio, Ip };   // normal connect | BSSID+channel, DHCP | + static IP
WifiFast wifiFast(const WifiCache& c, uint32_t savedSsidHash, int64_t nowEpoch);
const char* wifiFastName(WifiFast f);   // none | radio | ip

bool liveNow(int64_t msSinceInput, int liveMin);   // msSinceInput < 0 = no input since the wake

struct ArmRecord { std::string version; int boots = 0; bool uptime = false; };   // uptime: armed by kArmUptimeMin
ArmRecord armFor(const ArmRecord* stored, const std::string& version);   // other version / none → 0 boots
ArmRecord armCount(const ArmRecord& r);                                   // this boot confirmed with network
ArmRecord armUptime(const ArmRecord& r, double netUpMin, bool pendingVerify);   // #231
int armBootsLeft(const ArmRecord& r);   // 0 = armed
const char* armedBy(const ArmRecord& r);   // "uptime" | "boots" | nullptr (not armed)
std::string armReason(const ArmRecord& r);   // "30 min online" | "3 boots online" | ""

// Wake counters since power-on (#178, emulator WakeTally; vectors glance.json tally): GET /status power + refreshes.
constexpr uint32_t kNoMs = 0xFFFFFFFFu;   // lastWifiMs / lastHaMs: not reached in that wake
struct Tally {
  uint32_t wakes;                // deep-sleep wakes (timer, button, charger)
  uint32_t redraws;              // glance wakes that redrew the panel
  uint32_t failedWakes;          // glance wakes without HA data within the 20 s cap
  uint32_t asleepS;              // total deep sleep
  uint64_t awakeMs;              // total awake time of boots that ended in deep sleep
  uint32_t fullRefreshes, partialRefreshes;   // of boots that ended in deep sleep; the running boot adds App::Stats
  bool hasLast;                  // a glance wake decided since power-on
  uint32_t lastWifiMs, lastHaMs, lastTotalMs;   // since the reset: Wi-Fi up, HA connected after Wi-Fi, decision
};
// Deep sleep length: clock at sleep and now when known (0 = unknown) and not backwards, else the planned timer, else 0.
int64_t sleptSeconds(int64_t sleptAtEpoch, int64_t wakeAtEpoch, int64_t nowEpoch);
void tallyWake(Tally& t, int64_t sleptS);
void tallyGlance(Tally& t, bool ok, bool redraw, uint32_t wifiMs, uint32_t haMs, uint32_t totalMs);   // kNoMs = never
void tallySleep(Tally& t, uint32_t awakeMs, uint32_t full, uint32_t partial);

// Survives deep sleep and esp_restart() in RTC_NOINIT memory (net/power.cpp); garbage after power-on → reset.
enum class SimWake : uint8_t { None, Timer, Button, Charger };   // QEMU: the wake cause a simulated sleep left behind
struct Rtc {
  uint32_t magic;
  uint32_t sum;                  // FNV-1a over everything after this field
  bool hasSnap;
  Snapshot snap;
  uint8_t fails;
  bool drawnOffline;
  int64_t drawnAtEpoch;          // last glance/live draw before sleeping; 0 = unknown
  WifiCache wifi;
  SimWake simWake;
  bool simBattery;               // QEMU: power source "battery" (default USB = always live)
  bool simArmed;                 // QEMU: skip the first-boot safety count
  int64_t sleptAtEpoch, wakeAtEpoch;
  Tally tally;
  uint32_t emptySleeps;           // #331: deep sleeps with reason "empty house" since power-on
  phases::Ring wakes;             // #327: awake phases of the newest boots that ended in deep sleep
};
void reset(Rtc& r);              // zeroes it (padding included) and seals
void seal(Rtc& r);
bool valid(const Rtc& r);

}  // namespace x4::glance
