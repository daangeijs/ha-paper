// Empty-house sleep (eink-ha-os#331, emulator src/core/emptyHouse.ts, spec/test-vectors/empty-house.json): while the presence
// source says nobody is home, glance wakes every kEmptyWaitS and the sleeping panel shows the Nobody home face.
// Setting `emptyHouse`: "" = off, else the entity. Quiet hours win; a key press wakes into live mode as always. Pure.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace x4 {

constexpr int64_t kEmptyWaitS = 2 * 3600;
constexpr const char* kDefaultEmptySource = "zone.home";

bool validEmptySource(const std::string& v);   // "" or a zone / binary_sensor / input_boolean / group entity id
// zone: state = persons in it, "0" = empty; the others: "off" = empty. Missing / unknown / unavailable = not empty.
bool houseEmpty(const std::string& entity, const char* state);
int64_t emptyWaitS(int32_t localSec, const std::string& quiet);   // kEmptyWaitS, cut at the start of quiet hours
std::string emptyNextAt(int32_t localSec, const std::string& quiet, const std::string& clock);   // "16:05" / "4:05"

bool isOpeningClass(const char* deviceClass);   // door, window, opening, garage_door

struct FactEntity { std::string id, name, state, deviceClass; };
enum class Alarm : uint8_t { None, Armed, Disarmed, Triggered };
// The face's facts: inside temperature, doors / windows (open count + first open name by id), alarm. Absent = row dropped.
struct HouseFacts {
  bool hasInside = false;
  double inside = 0;
  bool hasOpen = false;
  int open = 0;
  std::string firstOpen;
  Alarm alarm = Alarm::None;
};
Alarm alarmOf(const std::string& state);
HouseFacts houseFacts(bool hasInside, double inside, std::vector<FactEntity> ents);

}  // namespace x4
