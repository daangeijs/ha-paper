// Board impl for the Xteink X4 Pro: keys (Left GPIO0 = Prev, Right GPIO7 = Next, Power GPIO3), GT911 touch
// (tap + horizontal swipe) and capacitive Home key, dual warm/cool front light, CW2017 battery gauge,
// BM8563 RTC (+ NTP via net, TZ Europe/Amsterdam by default).
//
// All I2C traffic (GT911, CW2017, BM8563 share SDA39/SCL38) runs on one "x4input" task, so the app/web
// tasks never contend for the bus: input events go through a FreeRTOS queue, battery/charging are cached. The CW2017
// gauge is read one short step at a time (core/cw2017.h), so a gauge recovery never stalls input.
// The task sleeps on a task notification raised by GPIO interrupts (keys, GT911 INT) and only polls while a key
// debounce or a touch contact is in flight (firmware/DEVIATIONS.md).
#pragma once
#include <atomic>
#include <cstdint>

#include "hw/platform.h"

namespace x4 {

// X4 Pro power latch (#225): power.latch0 (GPIO1) keeps the board on when it runs on battery. A global constructor
// drives it HIGH before Arduino's init and setup(), and leaves the pad held (gpio_hold_en): esp_restart, OTA, panic
// and watchdog resets keep the pad HIGH instead of floating it through the next boot. Only an RTC/system reset
// or a real power loss clears the hold.
void powerLatchLog();                    // one [I][POWER] line: pin, held, ms after power-on (after Serial.begin)
bool powerLatchHigh();                   // the pad reads HIGH (logged with every power transition)

class X4Board : public Board {
 public:
  void begin();                          // power rails, input, front light, gauge, RTC → system clock
  bool pollInput(InputEvent& out) override;
  void setFrontlight(uint8_t brightnessPct, uint8_t warmthPct) override;
  PowerInfo power() override;
  uint32_t millis() override;
  int64_t epochSeconds() override;
  void restart() override;
  void pause(uint32_t ms) override;
  uint8_t heldKeys() override;           // GPIO levels now (not the debounced events): hardware-key factory reset

  void writeRtcFromSystemClock();        // after NTP sync (thread-safe: handed to the input task)
  // Deep sleep (#10, net/power.cpp): front light parked, rails down, GPIO1 latch held, wake on Power/Right, charger
  // STAT, and a timer (seconds > 0). Call after the panel's deep-sleep command. Does not return: a wake is a reset.
  [[noreturn]] void deepSleep(int64_t seconds);
  // Power held 2 s (#258), after the "Turned off" face and the panel's deep-sleep command: waits for Power to be
  // released, releases the GPIO1 latch (battery: the board goes off). Still running 1 s later (USB) → deep sleep, only
  // Power wakes, latch held LOW (unplugging then switches it off). Does not return.
  [[noreturn]] void powerOff() override;
  void notifyOnInput(void* task);        // TaskHandle_t to xTaskNotifyGive() whenever an event is queued
  bool pushInput(const InputEvent& e) override;   // remote input (#214): same queue as touch/keys

 private:
  static void taskEntry(void* self);
  void task();
  [[noreturn]] void sleepNow(int64_t seconds, bool offHold);
  void readBattery(uint32_t now);        // x4input only (I2C)
  uint32_t batteryDueIn(uint32_t now) const;
  void* queue_ = nullptr;                // QueueHandle_t
  void* inputTask_ = nullptr;            // TaskHandle_t of "x4input"
  std::atomic<void*> consumer_{nullptr}; // TaskHandle_t notified per queued event
  std::atomic<uint8_t> battery_{0};
  std::atomic<bool> charging_{false};
  std::atomic<bool> rtcWriteRequested_{false};
  std::atomic<bool> batteryKnown_{false};
  std::atomic<uint16_t> batteryMv_{0};
  std::atomic<uint8_t> batteryRaw_{0};   // gauge % before the #327 filter
};

}  // namespace x4
