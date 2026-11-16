// X4_QEMU only: Display + Board for Espressif QEMU (`-machine esp32s3`), which has no SPI panel, no I2C
// (GT911 / CW2017 / BM8563) and no LEDC. The display keeps the last framebuffer (served as PGM at
// GET /__qemu/framebuffer.pgm and as PNG via /api/v1/screens/{id}/preview.png); input is scripted through
// POST /__qemu/input (tap=x,y | key=prev|next|home|power | swipe=-1|1). Never built for hardware.
#pragma once
#if X4_QEMU
#include <atomic>
#include <cstdint>
#include <string>

#include "hw/platform.h"

namespace x4 {

class QemuDisplay : public Display {
 public:
  bool begin();
  void fullRefresh(const Framebuffer& fb) override;
  void fastRefresh(const Framebuffer& fb) override;
  void partialRefresh(const Framebuffer& fb, Rect r) override;
  void sleep() override {}
  const uint8_t* lastFrame() const { return last_; }
  void redrawLast() { if (last_ && panelIo()) ++fulls_; }
  uint32_t fulls() const { return fulls_; }
  uint32_t partials() const { return partials_; }
  uint32_t fasts() const { return fasts_; }
  void setStuck(bool stuck);   // POST /__qemu/panel (eink-ha-os#181): simulate a BUSY line that never releases

 private:
  bool panelIo();   // the real display's BUSY gate (core/panel_guard) against the simulated line; false = skip
  uint8_t* last_ = nullptr;
  std::atomic<bool> stuck_{false};
  std::atomic<uint32_t> fulls_{0}, partials_{0}, fasts_{0};
};

class QemuBoard : public Board {
 public:
  void begin();
  bool pollInput(InputEvent& out) override;
  void setFrontlight(uint8_t, uint8_t) override {}
  PowerInfo power() override;
  uint32_t millis() override;
  int64_t epochSeconds() override;
  void restart() override;
  void powerOff() override;   // eink-ha-os#258: no latch in QEMU; logs, returns (the App keeps the face, Power restarts)
  void writeRtcFromSystemClock() {}
  void notifyOnInput(void* task);   // TaskHandle_t woken by qemuPushInput (same contract as X4Board)
  bool pushInput(const InputEvent& e) override;
};

// Web debug hooks (any task).
bool qemuPushInput(const std::string& spec);        // "tap=400,240" | "key=next" | "swipe=-1"; false = bad spec
bool qemuPushEvent(const InputEvent& e);            // false = queue full / not begun
std::string qemuFramebufferPgm(const uint8_t* fb);  // P5 800×480, 8-bit gray (0 / 85 / 170 / 255)
QemuDisplay& qemuDisplayStats();                     // refresh counters for /__qemu/state

}  // namespace x4
#endif
