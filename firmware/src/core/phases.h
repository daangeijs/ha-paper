// Awake phases (#327): where a boot's awake time goes, as an energy proxy (the radio and CPU are on for all of it).
// Wall time since the reset is cut in order: boot (reset → setup done), wifi (→ Wi-Fi first up), ha (→ HA connected
// with entities in), then the rest. render and panel are this boot's totals (App::Stats); idle = the rest minus the
// render + panel time after the ha mark. A phase not reached takes the time up to now, the later ones are 0. Firmware
// only (the emulator has no power path). Device glue: net/power.cpp; GET /diagnostics power_trail.phases.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

namespace x4::phases {

constexpr uint32_t kNoMs = 0xFFFFFFFFu;
constexpr size_t kWakes = 12;   // newest ended boots kept in RTC memory (3 h of 15 min glance wakes)

struct Marks {                  // ms since the reset; kNoMs = not reached yet
  uint32_t bootMs = kNoMs, wifiMs = kNoMs, haMs = kNoMs;
  uint32_t drawAtHaMs = 0;      // render + panel ms of this boot when haMs was marked
};

struct Rec {                    // trivially copyable: lives in RTC_NOINIT memory
  uint32_t epoch;               // when measured (end of the boot); 0 = clock unknown
  uint32_t boot, wifi, ha, render, panel, idle, total;   // ms
  int16_t mv;                   // cell voltage; -1 = not read
  int8_t pct, raw;              // shown % (#327 filter) and the gauge's own; -1 = not read
  char wake;                    // c(old) t(imer) b(utton) h = charger, o(ther)
};

struct Ring {
  Rec recs[kWakes];
  uint8_t n, head;              // head = next slot
};

Rec measure(const Marks& m, uint32_t totalMs, uint32_t renderMs, uint32_t panelMs);
void push(Ring& r, const Rec& rec);
std::string recJson(const Rec& r);   // {"wake":"timer","epoch":…|null,"boot_ms":…,…,"pct":…,"raw":…,"mv":…|null}
std::string json(const Rec* running, const Ring& r);   // {"boot":<running>|null,"wakes":[newest first]}
std::string line(const Rec& r);      // "boot 812 · wifi 1530 · ha 2210 · render 340 · panel 1650 · idle 3200 · total 7752 ms"

}  // namespace x4::phases
