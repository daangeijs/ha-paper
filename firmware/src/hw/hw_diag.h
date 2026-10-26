// Hardware facts for GET /api/v1/diagnostics (net/diag.cpp). Device: hw/x4_display.cpp + hw/x4_board.cpp;
// QEMU: hw/qemu_hw.cpp (no panel, no touch).
#pragma once
#include <cstdint>

#include "core/diag.h"

namespace x4 {

void panelDiag(diag::Panel& out);   // XteinkDetect probe snapshot + OEM hw_calib/screenType (read only)
int64_t touchRecoveries();          // GT911 rail power-cycles since boot; -1 = no touch hardware

}  // namespace x4
