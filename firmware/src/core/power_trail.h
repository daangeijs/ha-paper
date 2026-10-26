// Power trail (#225): the last power transition, kept in userdata /power.txt so a real power loss (RTC memory and the
// RTC log tail gone) still tells what the board was doing when it lost power. Firmware only: the emulator has no
// power path. Device glue: net/power.cpp. Pure; test/test_power_trail.
#pragma once
#include <string>

namespace x4::powertrail {

constexpr const char* kAwake = "awake";
std::string sleepMarker(const char* reason);   // "sleep <reason>", written before deep sleep

// This boot vs the marker the previous boot left. Only a POWERON counts: every other reset keeps the board powered.
//   LostAsleep: it went into deep sleep (latch held) and came back as POWERON, so power vanished while asleep.
//   LostAwake:  it was running and came back as POWERON: battery empty, USB plugged in after one, or power cut.
enum class Verdict : unsigned char { None, LostAsleep, LostAwake };
Verdict verdict(const std::string& marker, const char* reset);
const char* verdictName(Verdict v);   // none | lost-asleep | lost-awake

// Marker to write when the board is up and running (a boot or a glance wake that turns live), or "" when the file
// already says so. A glance wake that sleeps again keeps the sleep marker: no flash write per glance cycle.
std::string awakeWrite(const std::string& marker);
// Marker to write before deep sleep, or "" when the file already says so.
std::string sleepWrite(const std::string& marker, const char* reason);

}  // namespace x4::powertrail
