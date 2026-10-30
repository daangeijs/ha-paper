// Good morning page state across deep sleep (#330, core/morning.h): armed by quiet hours, the page's end time. RTC
// memory survives deep sleep and esp_restart(); after a power-on the checksum fails and the state is idle (no page).
#pragma once
#include "core/morning.h"

namespace x4::net {

morning::State morningRtcLoad();
void morningRtcSave(const morning::State& s);

}  // namespace x4::net
