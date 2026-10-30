// First-run screens from the user's own Home Assistant (eink-ha-os#23). Port of emulator/src/core/seed.ts (rules there);
// parity: spec/test-vectors/seed.json. Runs once on the first link when userdata has no /screens.yaml
// (net/ha_client.cpp builds the snapshot, net/device_services applies + saves the result).
#pragma once
#include <string>
#include <vector>

#include "core/config.h"

namespace x4 {

// The render_template the first link sends (SEED_TEMPLATE in the emulator; spec/test-vectors/seed.json `template`).
const char* seedTemplate();
// The template answer is a JSON object. Anything else = the seed failed: save nothing, retry on the next link (eink-ha-os#58).
bool seedAnswerOk(const std::string& text);
// render_template event with report_errors: HA sends {error, level: "WARNING"} for e.g. an undefined attribute and
// keeps rendering; the result (or an ERROR) follows. level nullptr = absent.
bool templateEventFinal(bool hasResult, const char* level);

// Seed report (eink-ha-os#89): per tile (SEED_TILES in the emulator) the entity + rule that filled it, or why it was dropped.
// rule: id | energy | device | name | area | grid | found. why: no_energy | no_meter | no_sensor | none | few_rooms |
// overview_full. Saved as /seed.json on userdata, served by GET /api/v1/seed.
struct SeedTile { std::string tile, screen, entity, rule, why; };
struct SeedReport {
  std::vector<SeedTile> tiles;
  int filled() const;
};
// {"filled":N,"total":M,"tiles":[{tile, screen, entity?, rule | why}]}: seed.json `report`, same key order.
std::string seedReportJson(const SeedReport& r);

// snapshot JSON: {"energy": <energy/get_prefs> | null, "live": [logical ids with a source: price, routes],
//                 "areas": [[id, name]], "climate": [[id, name, area, state] | id], "vehicles": [ids], "lights": [[id, area, "g" | ""]],
//                 "sensors": [[id, class, area, name, unit]], "weather": [ids]}
// Every stat / gauge entity it writes is one of `sensors` (eink-ha-os#82). Unparseable or empty → clock-only overview + tail.
Config seedConfig(const std::string& snapshotJson, const std::vector<Screen>& tail, SeedReport* report = nullptr);
struct Json;
Config seedConfig(const Json& snapshot, const std::vector<Screen>& tail, SeedReport* report = nullptr);

// Glue helper: {"energy": prefs, "live": live, …members of the seed template's answer object…}.
// prefsJson / templateJson "" (or not an object) are left out.
std::string seedSnapshot(const std::string& prefsJson, const std::vector<std::string>& live, const std::string& templateJson);

std::string seedLabel(const std::string& s);   // area name → label value (drops , : { } [ ] # ")
// Template row kind: "t" temperature, "p" power, "e" energy today, "b" charge %, "" other (`text` = lower-case
// "entity_id name"). sharedWords: leading object-id words two entity ids share (p1_meter_power, p1_meter_energy → 2).
std::string sensorKind(const std::string& cls, const std::string& unit, const std::string& text);
int sharedWords(const std::string& a, const std::string& b);

}  // namespace x4
