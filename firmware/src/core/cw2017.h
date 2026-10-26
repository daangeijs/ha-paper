// CW2017 fuel gauge (X4 Pro, I2C 0x63) as a non-blocking state machine (issue #11). The vendored BatteryMonitor
// recovers a sleeping/reset gauge with delay() loops (soft reset + up to 1 s VERSION + 3 s SoC wait) on the
// caller's task; on the X4 that is "x4input", so touch and keys froze for ~4 s. Same register sequence and
// profile as vendor BatteryMonitor.cpp (OEM Cw2017PowerHal), but each call does one short bus step and the caller
// sleeps until msUntilDue(). Pure: register I/O goes through Cw2017Bus. No emulator counterpart (hardware only).
#pragma once
#include <cstdint>

namespace x4 {

struct Cw2017Bus {
  virtual ~Cw2017Bus() = default;
  virtual bool read(uint8_t reg, uint8_t& v) = 0;
  virtual bool write(uint8_t reg, uint8_t v) = 0;
};

// VCELL (0x02 high, 0x03 low) → mV. CW2017 datasheet register map: 14-bit cell voltage, big-endian, bits 15:14 of
// 0x02 reserved, 312.5 µV/LSB (= 5/16 mV). Rounded as the vendor BatteryMonitor readGaugeMillivolts (OEM
// Cw2017PowerHal): (raw * 5 + 8) >> 4. Range 0..5120 mV. spec/test-vectors/cw2017-vcell.json.
uint16_t cw2017Millivolts(uint8_t hi, uint8_t lo);

class Cw2017 {
 public:
  static constexpr uint32_t kPollMs = 30000;   // steady SoC read; also the retry after a failed init/recovery

  // Run the due step (call when msUntilDue() == 0). True when it read a fresh SoC (soc()); VCELL is read with it.
  bool step(Cw2017Bus& bus, uint32_t now);
  uint32_t msUntilDue(uint32_t now) const { return int32_t(now - next_) >= 0 ? 0 : next_ - now; }
  bool recovering() const { return state_ > State::Read; }   // reset/wait sequence in flight
  uint8_t soc() const { return soc_; }
  uint16_t mv() const { return mv_; }   // cell voltage with the last SoC; 0 = not read (VCELL read failed)

 private:
  enum class State : uint8_t { Init, Read, Reset1, Reset2, Reset3, WaitVersion, WaitSoc };
  void go(State s, uint32_t now, uint32_t in) { state_ = s; next_ = now + in; }
  bool got(Cw2017Bus& bus, uint8_t soc, uint32_t now);
  State state_ = State::Init;
  uint32_t next_ = 0;
  uint8_t tries_ = 0, soc_ = 0;
  uint16_t mv_ = 0;
};

}  // namespace x4
