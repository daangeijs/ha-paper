// Hardware abstraction used by the app/UI runtime. Device impl: src/hw/*.cpp. Host impl: test/support (PGM output).
#pragma once
#include <cstdint>
#include <cstddef>

namespace x4 {

constexpr int kScreenW = 800;
constexpr int kScreenH = 480;

struct Rect { int16_t x, y, w, h; };

// 2-bit gray framebuffer, row-major, 4 px per byte, MSB first. 0 = black … 3 = white. 96000 bytes (PSRAM).
struct Framebuffer {
  uint8_t* data;
  static constexpr size_t kBytes = kScreenW * kScreenH / 4;
};

class Display {
 public:
  virtual ~Display() = default;
  virtual void fullRefresh(const Framebuffer& fb) = 0;              // clean: one short flash (SSD1677 HALF, #197)
  virtual void fastRefresh(const Framebuffer& fb) = 0;              // whole frame, no flash (navigation, #197)
  virtual void partialRefresh(const Framebuffer& fb, Rect r) = 0;   // windowed, no flash
  virtual void sleep() = 0;
};

enum class Key : uint8_t { Prev, Next, Home, Power };
struct InputEvent {
  enum class Kind : uint8_t { KeyDown, Tap, Swipe } kind;
  Key key;        // KeyDown
  int16_t x, y;   // Tap position / swipe start
  int8_t dir;     // Swipe: -1 = left (next), +1 = right (prev)
};

// charging = charger STAT; usb = a USB host is seen (HWCDC SOF). Neither sees a full battery on a dumb charger.
// known: gauge read at least once; mv: cell voltage (CW2017 VCELL, #73), 0 = unknown (no CW2017, or VCELL not read)
struct PowerInfo { uint8_t batteryPct; bool charging; bool usb; bool known = true; uint16_t mv = 0; };

class Board {
 public:
  virtual ~Board() = default;
  virtual bool pollInput(InputEvent& out) = 0;
  virtual void setFrontlight(uint8_t brightnessPct, uint8_t warmthPct) = 0;
  virtual PowerInfo power() = 0;
  virtual uint32_t millis() = 0;
  virtual int64_t epochSeconds() = 0;   // 0 if unknown (no NTP/RTC yet)
  virtual void restart() = 0;
  virtual void pause(uint32_t ms) { (void)ms; }   // block the calling task (hardware); no-op in host tests
  virtual uint8_t heldKeys() { return 0; }   // keys held now, core/recovery.h bits (kKeyPower | kKeyRight | kKeyLeft)
  virtual bool pushInput(const InputEvent&) { return false; }   // remote input (#214), any task; false = queue full
  virtual void powerOff() {}   // Power held 2 s (#258): hardware cuts its own power, no return; QEMU / host return
};

}  // namespace x4
