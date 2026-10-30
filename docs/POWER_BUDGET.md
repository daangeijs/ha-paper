# Power budget: measurement plan

Every battery figure in this repo is an estimate. This file says what to measure, with what, and where the numbers
go (#19). The measured columns are empty on purpose; fill them on hardware, then set the v0.3 / v1.0 battery
targets from them. Design and rules for sleeping are in [ROBUSTNESS_PLAN.md](ROBUSTNESS_PLAN.md) Phase 3; the glance
decision is #18; the implementation shipped in #10 (PR #60); hardware validation is #20.

## 1. Modes

Issue #19 calls them A-E. Since #10 the firmware deep-sleeps on battery (`/status` `power.mode` is `glance` on a
glance timer wake, else `awake`), so all five can be shown. None is measured on hardware yet.

| Mode | What runs | Measurable now? |
|---|---|---|
| A. Live | Awake, Home on screen, Wi-Fi associated, HA WebSocket open, minute-tick partials. On battery: 80 MHz, modem sleep `min`; on USB: 240 MHz, no modem sleep (#177; `/status` `power.applied`) | yes |
| B. Glance wake | Timer wake → Wi-Fi → HA snapshot → full refresh only if the sleep face changed → deep sleep. Since #356 only at transitions: midnight, quiet-hours start and end, the 03:00 install slot, at most every 8 h (was every `wakeEvery`, 15 min) | yes (built in #10, unmeasured) |
| C. Deep sleep | Floor between wakes. GPIO1 held, timer + Power/Right/charger wake armed, touch rail off | yes (built in #10, unmeasured; stock firmware's sleep as a reference) |
| D. Wi-Fi connect | From radio on to an IP (and, for B, to the first HA answer). Part of every B; also at boot and after a router restart | yes, at boot |
| E. Refresh | One full refresh (~3 s assumed, A13 in [HARDWARE_ASSUMPTIONS.md](HARDWARE_ASSUMPTIONS.md)) and one partial (clock tick, page turn) | yes |

Front light on is not a mode but adds to A; measure it once at 50 % and 100 %.

## 2. Setup

| Tool | How it connects | Good for | Not good for |
|---|---|---|---|
| Nordic PPK2 (preferred) | **Ampere meter mode**, in series with the battery's + lead. The real cell stays in, so the CW2017 gauge keeps working | all modes, µA floor to A peaks, charge per wake (integrate the trace) | needs the case open and access to the battery lead; whether the X4 Pro cell has a connector is unknown |
| PPK2 source meter | Supplies 3.85 V to the battery terminals instead of the cell | same, plus repeatable supply voltage | the gauge reports nonsense (no real cell); STAT reads not charging |
| µCurrent / bench multimeter | in series with the battery | average current in A and C | wake profiles: too slow to integrate a 10 s wake |
| USB-C inline power meter | between charger and pogo adapter | rough A on USB | anything on battery. With a USB cable in, the firmware counts as on external power (since #10: full speed, no sleep), and the meter also sees charging current. Only meaningful with a full battery, and only if the charger feeds the system directly (unknown) |
| Battery % per day | `/status` `battery` at the same time every day ([TESTERS.md](TESTERS.md)) | long-run check of the model | anything short: 1 % ≈ 11 mAh, and the gauge's percent is itself an assumption (A26) |

Rules for every run:

- **No USB data cable** while measuring battery modes. The USB host is detected (`HWCDC::isPlugged()`) and changes the
  power decision. Read state over Wi-Fi (`/status`) instead of the serial log.
- Sample the PPK2 at 100 kS/s; save the raw `.ppk2` and a CSV export per run as
  `backups/power/YYYYMMDD-<mode>-<n>.ppk2`.
- Note battery %, RSSI (`/status` via the console or the Wi-Fi page), firmware version, room temperature.
- Five repeats per event (wake, refresh, connect). Report the median and the spread.

## 3. What to log per event

One CSV row per wake or event. #10 added one summary log line per glance wake (`[POWER] glance wake · <ms> · HA
data in|HA unreachable · <n> region(s) changed · <refresh>`), so the PPK2 trace and the log line up. It has no
Wi-Fi or HA timings yet.

```
date,firmware,mode,wake_cause,battery_pct,rssi_dbm,bssid_cached,t_awake_ms,t_wifi_ms,t_ha_ms,refresh,refresh_ms,charge_mC,avg_mA,peak_mA,sleep_uA,notes
```

| Field | Meaning | Source |
|---|---|---|
| `mode` | A-E from §1 | you |
| `wake_cause` | timer, Power, Right, charger, reset | `/diagnostics` `boots[0].reason`; the `[POWER] wake: <cause>` boot log line (#10) |
| `bssid_cached` | B: reconnected from the BSSID/IP cached in RTC memory (ROBUSTNESS_PLAN 3.4) | firmware (#10, `net/wifi_mgr.cpp` fast join) |
| `t_awake_ms` | first current rise to back at the sleep floor | PPK2 trace |
| `t_wifi_ms` | radio on to IP | PPK2 trace (the RX/TX bursts), or `[I][WIFI] connected` on a logged run |
| `t_ha_ms` | radio on to first HA data | PPK2 trace; not in the #10 log line yet |
| `refresh` | none / partial / full | firmware log or what you saw |
| `refresh_ms` | BUSY high time | PPK2 (the refresh current plateau) or video |
| `charge_mC` | integral over `t_awake_ms` | PPK2 selection |
| `sleep_uA` | average over 60 s of floor between wakes | PPK2 |

## 4. Procedure

1. **Stock reference** ([FIRST_FLASH.md](FIRST_FLASH.md) step 5, before flashing): stock idle on a page (60 s
   average), one stock page turn (charge), stock sleep after a Power press (60 s floor). The stock sleep floor is
   the reference for ours (built in #10, unmeasured), and the first check of the < 200 µA target.
2. **A, live** (our firmware, battery, front light off): 10 min average on Home, linked to HA. Then with front light
   at 50 % and 100 %.
3. **D, connect**: `POST /api/v1/device/restart` from the console or `curl`; mark from the current rise to the
   `connected` point (the console shows the display back). Five times. Once more after a router restart.
4. **E, refresh**: `POST /api/v1/display/refresh` (one full refresh) five times, 30 s apart. Partials: five page
   turns with Right. Charge per event = event charge minus the A baseline over the same time.
5. **B and C** (built in #10, not yet run on hardware): one hour on battery with `powerSave: standby`, `wakeEvery: 15`. Four wakes give four rows;
   the floor between them is C.

## 5. Model

Per mode. "Estimate" quotes what the repo already says; nothing here is measured.

| Mode | Estimate (source) | Measured avg | Measured duration | Measured charge per event |
|---|---|---|---|---|
| A. Live, today (240 MHz; estimate made before 0.4 removed the busy loops) | 44-73 mA: 15-25 h on 1100 mAh (ROBUSTNESS_PLAN Phase 3) | | continuous | — |
| A. Live at 80 MHz fixed (no `esp_pm` in the Arduino libs, #177) + modem sleep (3.2) | 27-38 mA: 1.2-1.7 days (ROBUSTNESS_PLAN 3.2) | | continuous | — |
| A. Live with automatic light sleep (3.5) | 3.3-9.2 mA: 5-14 days (ROBUSTNESS_PLAN 3.5) | | continuous | — |
| B. Glance wake | 10.5 s, 0.67 C = 0.19 mAh per wake (TRMNL's figure, `emulator/src/core/power.ts`); ours is "unmeasured (Wi-Fi + TLS to HA + a gray refresh)" | | | |
| C. Deep sleep | ~100 µA (TRMNL); our target < 200 µA (ROBUSTNESS_PLAN hardware test list) | | — | — |
| D. Wi-Fi connect | none in the repo (inside TRMNL's 10.5 s) | | | |
| E. Full refresh | ~3 s (comment in `main.cpp`); no current estimate in the repo | | | |
| E. Partial refresh | none in the repo | | | |
| Front light 50 % / 100 % | none in the repo | | continuous | — |

Per day, with N wakes, live time `t_live` (hours) and the rest asleep:

```
mAh/day = I_C × (24 − t_live − N × t_B) + N × Q_B + t_live × I_A
Q_B [mAh] = charge per wake [C] / 3.6
days    = 1100 mAh / (mAh/day)          (capacity is itself an assumption: A27)
```

| Scenario | Estimate | Estimated days | Measured mAh/day | Measured days |
|---|---|---|---|---|
| Always live, never sleeps (firmware before #10) | 44-73 mA × 24 h ≈ 1060-1750 mAh/day | 0.6-1.0 (15-25 h) | | |
| Live with 3.2 | 650-910 mAh/day | 1.2-1.7 | | |
| Live with 3.5 | 80-220 mAh/day | 5-14 | | |
| Night deep sleep (3.3) + 3.5 by day | ≈ 92 mAh/day | ~12 (ROBUSTNESS_PLAN) | | |
| Glance, 15 min, TRMNL figures: 0.1 mA × 24 h + 96 × 0.19 mAh | ≈ 20.6 mAh/day | ~53 (ROBUSTNESS_PLAN says ~2 months, power.ts ~55 days) | | |
| Glance, 15 min, + 10 min live per day at the 3.2 estimate | 20.6 + (27-38 mA × 0.17 h) ≈ 25-27 mAh/day | ~41-44 | | |

Since #356 glance wakes 2-4 times a day instead of 96 (midnight / quiet start, quiet end, the 8 h cap), so the wake term
drops from ≈ 18 mAh/day to under 1 mAh/day at the TRMNL figure; the floor (C) and live time after presses dominate.

What the numbers will decide: whether glance at 15 minutes reaches "weeks, not hours" with our HA + TLS wake (TRMNL
pulls one image; we open a TLS session to HA and may redraw), how long a button press may keep the display live, and
whether 3.5 is worth its risk once 3.4 exists.
