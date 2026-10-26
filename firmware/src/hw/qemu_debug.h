// X4_QEMU_DEBUG only (env:x4qemu_debug, docs/ESP32_EMULATION.md): memory-corruption checks for QEMU soak runs (#39).
//  - every portENTER/EXIT_CRITICAL goes through a wrapper (-Wl,--wrap) that keeps the last 64 ops per core and checks
//    the spinlock before and after; a corrupt lock prints both rings + the 72 bytes around it, then aborts;
//    an assert inside the real spinlock code prints the rings from the panic path (net/diag.cpp)
//  - a monitor task runs heap_caps_check_integrity_all() every 10 s and logs per-task stack high-water marks every 30 s
#pragma once
#if X4_QEMU_DEBUG
namespace x4 {
void qemuDebugBegin();
}  // namespace x4
extern "C" void x4QemuDebugPanicDump();   // IRAM, panic context: prints both critical-section rings
#endif
