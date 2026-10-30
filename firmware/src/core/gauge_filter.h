// Gauge filter (#327), a port of emulator/src/core/battery.ts gaugeStep: the CW2017 % reads low under load and high
// after rest (92 → 94 % after a night asleep, no charger). The shown % never rises without a charger; a rise of
// kRisePts or more confirmed by kRiseReads reads in a row is taken (a charge the board did not see). Falls pass at
// once. Pure and trivially copyable: the device keeps it in RTC_NOINIT memory (hw/x4_board.cpp) across deep sleep.
// Vectors: spec/test-vectors/gauge-filter.json.
#pragma once
#include <cstdint>

namespace x4::gauge {

constexpr int kRisePts = 5;
constexpr int kRiseReads = 3;

struct State {
  int16_t shown = -1;   // -1 = nothing shown yet (power-on)
  uint8_t rise = 0;     // reads in a row at least kRisePts above shown
};

// One gauge read: raw < 0 = not read (state kept); charging = STAT or USB host seen.
State step(State s, int raw, bool charging);

}  // namespace x4::gauge
