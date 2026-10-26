// Improv Wi-Fi over the serial console (core/improv.h, #31): the web flasher sends Wi-Fi credentials over USB right
// after installing. HWCDC on the X4 Pro, UART0 under QEMU. Polled from loop() (20 ms cadence, no task of its own);
// the join runs on the net task through WifiMgr::connect, which saves the network like any other join.
#pragma once

namespace x4::net {

void improvPoll();   // loop task: reads what the host sent, answers, posts joins/scans to the net task

}  // namespace x4::net
