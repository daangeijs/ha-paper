// Remote input spec (#214): "tap=x,y" | "key=prev|next|home|power" | "swipe=-1|1" → InputEvent. Shared by QEMU's
// POST /__qemu/input and POST /api/v1/debug/input; both feed the board's input queue like real touch/keys.
#pragma once
#include <string>

#include "hw/platform.h"

namespace x4 {

bool parseInputSpec(const std::string& spec, InputEvent& out);   // false = bad spec

}  // namespace x4
