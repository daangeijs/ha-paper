// Power trail (#225): the last power transitions, kept in userdata /power.txt so a real power loss (RTC memory and the
// RTC log tail gone) still tells what the board was doing when it lost power. Firmware only: the emulator has no
// power path. Device glue: net/power.cpp. Pure; test/test_power_trail.
// The file is lines, oldest first, capped at kMaxLines: `awake`, `sleep <reason>`, `key <ms> <mV> <usb>` (Power
// KeyDown, before the App acts), `standby drawn <ms>` (after the standby full refresh), `keyup <held ms>`.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace x4::powertrail {

constexpr const char* kAwake = "awake";
constexpr size_t kMaxLines = 32;
std::string sleepMarker(const char* reason);   // "sleep <reason>", written before deep sleep
std::string keyLine(uint32_t ms, int mv, bool usb);   // "key <ms> <mV> <usb 0/1>"; mV -1 = not read
std::string standbyLine(uint32_t ms);                // "standby drawn <ms>"
std::string keyUpLine(uint32_t heldMs);              // "keyup <held ms>"

std::string lastLine(const std::string& trail);
std::vector<std::string> lastLines(const std::string& trail, size_t n);   // oldest first
// trail + line, '\n'-terminated, trimmed to the newest kMaxLines lines (a pre-#225 single marker without '\n' is kept)
std::string append(const std::string& trail, const std::string& line);

// This boot vs the last line the previous boot left. Only a POWERON counts: every other reset keeps the board powered.
//   LostAsleep: it went into deep sleep (latch held) and came back as POWERON, so power vanished while asleep.
//   LostAwake:  it was running (awake, or a Power key stage) and came back as POWERON: battery empty, USB plugged in
//               after one, or power cut.
enum class Verdict : unsigned char { None, LostAsleep, LostAwake };
Verdict verdict(const std::string& trail, const char* reset);
const char* verdictName(Verdict v);   // none | lost-asleep | lost-awake

// New file contents when the board is up and running (a boot or a glance wake that turns live), or "" when the last
// line already says so. A glance wake that sleeps again keeps the sleep marker: no flash write per glance cycle.
std::string awakeWrite(const std::string& trail);
// New file contents before deep sleep, or "" when the last line already says so.
std::string sleepWrite(const std::string& trail, const char* reason);

}  // namespace x4::powertrail
