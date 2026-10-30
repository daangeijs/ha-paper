#include "core/gauge_filter.h"

namespace x4::gauge {

State step(State s, int raw, bool charging) {
  if (raw < 0) return s;
  if (s.shown < 0 || charging || raw <= s.shown) return State{int16_t(raw), 0};
  if (raw - s.shown < kRisePts) return State{s.shown, 0};
  const int rise = s.rise + 1;
  return rise >= kRiseReads ? State{int16_t(raw), 0} : State{s.shown, uint8_t(rise)};
}

}  // namespace x4::gauge
