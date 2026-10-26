#include "core/cw2017.h"

namespace x4 {

namespace {
constexpr uint8_t kRegVersion = 0x00;    // 0xA0 while starting; running versions match 0x0D/0x0F
constexpr uint8_t kRegVcell = 0x02;     // 0x02/0x03, see cw2017Millivolts()
constexpr uint8_t kRegSoc = 0x04;        // integer percent
constexpr uint8_t kRegMode = 0x08;
constexpr uint8_t kRegSocAlert = 0x0B;   // bit7 = profile loaded
constexpr uint8_t kRegBatinfo = 0x10;    // 80-byte profile, 0x10..0x5F
constexpr uint8_t kModeNormal = 0x00, kModeRestart = 0x30, kModeDefault = 0xF0, kUpdateFlag = 0x80;
constexpr uint32_t kResetGapMs = 20;     // between MODE writes, and the VERSION poll period
constexpr uint32_t kSocPollMs = 100;
constexpr uint8_t kVersionTries = 50;    // ~1 s
constexpr uint8_t kSocTries = 30;        // ~3 s

// X4 Pro cell profile, copied from vendor BatteryMonitor.cpp CW2017_BATINFO (OEM app1 table @ DROM 0x3c5d8d00).
constexpr uint8_t kBatinfo[80] = {
    0x50, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xaa, 0xbf, 0xb5, 0xb4, 0xa4, 0x9c, 0xeb, 0xe2,
    0xdf, 0xe5, 0xca, 0xa0, 0x8a, 0x62, 0x53, 0x48, 0x40, 0x3a, 0x32, 0xb1, 0xae, 0xda, 0xb5, 0xff,
    0xff, 0xff, 0xe8, 0xdb, 0xd9, 0xd6, 0xd4, 0xd2, 0xd0, 0xcb, 0xc3, 0xbc, 0x9e, 0x87, 0x7b, 0x71,
    0x72, 0x7c, 0x8c, 0xa3, 0xb7, 0xc8, 0xa5, 0x4f, 0x00, 0x00, 0xab, 0x02, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x23};

bool running(uint8_t version) { return (version & 0xFD) == 0x0D; }

// false = I/O error (never rewrite the profile on a transient bus failure).
bool profileMatches(Cw2017Bus& bus, bool& matches) {
  uint8_t v = 0;
  if (!bus.read(kRegSocAlert, v)) return false;
  matches = (v & kUpdateFlag) != 0;
  for (uint8_t i = 0; matches && i < sizeof(kBatinfo); ++i) {
    if (!bus.read(static_cast<uint8_t>(kRegBatinfo + i), v)) return false;
    matches = v == kBatinfo[i];
  }
  return true;
}
}  // namespace

uint16_t cw2017Millivolts(uint8_t hi, uint8_t lo) {
  const uint32_t raw = (uint32_t(hi & 0x3F) << 8) | lo;
  return static_cast<uint16_t>((raw * 5 + 8) >> 4);
}

bool Cw2017::got(Cw2017Bus& bus, uint8_t soc, uint32_t now) {
  soc_ = soc;
  // A failed VCELL read keeps the fresh SoC but leaves the voltage unknown, never a stale one.
  uint8_t hi = 0, lo = 0;
  mv_ = bus.read(kRegVcell, hi) && bus.read(static_cast<uint8_t>(kRegVcell + 1), lo) ? cw2017Millivolts(hi, lo) : 0;
  go(State::Read, now, kPollMs);
  return true;
}

bool Cw2017::step(Cw2017Bus& bus, uint32_t now) {
  uint8_t mode = 0, version = 0, soc = 0;
  switch (state_) {
    case State::Read:
      // An acked but sleeping/restarted gauge is not a fresh SoC: recover straight away.
      if (bus.read(kRegMode, mode) && mode == kModeNormal && bus.read(kRegVersion, version) && running(version) &&
          bus.read(kRegSoc, soc) && soc <= 100)
        return got(bus, soc, now);
      go(State::Init, now, 0);
      return false;

    case State::Init: {
      bool matches = false;
      if (!bus.read(kRegMode, mode) || !bus.read(kRegVersion, version) || !profileMatches(bus, matches)) break;
      if (!matches) {   // ~25 ms of writes at 100 kHz, once per lost profile
        bool ok = true;
        for (uint8_t i = 0; ok && i < sizeof(kBatinfo); ++i) ok = bus.write(static_cast<uint8_t>(kRegBatinfo + i), kBatinfo[i]);
        if (!ok || !bus.write(kRegSocAlert, kUpdateFlag)) break;
        go(State::Reset1, now, kResetGapMs);
        return false;
      }
      if (mode == kModeNormal && running(version) && bus.read(kRegSoc, soc) && soc <= 100) return got(bus, soc, now);
      go(State::Reset1, now, 0);   // not running, or an invalid SoC: one controlled restart
      return false;
    }

    case State::Reset1:
      if (!bus.write(kRegMode, kModeDefault)) break;
      go(State::Reset2, now, kResetGapMs);
      return false;
    case State::Reset2:
      if (!bus.write(kRegMode, kModeRestart)) break;
      go(State::Reset3, now, kResetGapMs);
      return false;
    case State::Reset3:
      if (!bus.write(kRegMode, kModeNormal)) break;
      tries_ = 0;
      go(State::WaitVersion, now, kResetGapMs);
      return false;

    case State::WaitVersion:
      if (bus.read(kRegVersion, version) && running(version)) {
        tries_ = 0;
        go(State::WaitSoc, now, 0);
        return false;
      }
      if (++tries_ >= kVersionTries) break;
      go(State::WaitVersion, now, kResetGapMs);
      return false;
    case State::WaitSoc:
      if (bus.read(kRegSoc, soc) && soc <= 100) return got(bus, soc, now);
      if (++tries_ >= kSocTries) break;
      go(State::WaitSoc, now, kSocPollMs);
      return false;
  }
  go(State::Init, now, kPollMs);   // I/O error or timeout: retry at the poll cadence
  return false;
}

}  // namespace x4
