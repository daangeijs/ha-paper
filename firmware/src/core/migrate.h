// Schema versions + migrations of persisted state (issue #12), a 1:1 port of emulator/src/core/migrate.ts. Pure;
// checked against spec/test-vectors/migrations/*.json. Device glue (boot entry point, NVS): net/storage.cpp
// Storage::migrate(); the map of what is stored where: net/storage.h.
//
// Rules for every step: one version at a time (n → n+1), never down; keep keys the step does not own (a newer
// firmware may have written them before an OTA rollback); never change the meaning of an existing key, move the value
// to a new key instead (firmware from before the step can still write the old key after a rollback). Newer or
// unreadable schema: read what you can, write nothing at boot.
#pragma once
#include <string>

#include "core/json.h"

namespace x4::migrate {

constexpr int kSettingsSchema = 1;   // userdata /settings.json "schema"; 0 = file from before versioning (no key)
constexpr int kDeviceSchema = 1;     // NVS x4dev/schema, one number for x4wifi/x4ha/x4tok/x4dev/x4ota; 0 = no key

enum class Status { Current, Upgrade, Newer, Unknown, Invalid };
const char* statusName(Status s);   // "current" | "upgrade" | "newer" | "unknown" | "invalid" (vectors, logs)

Status schemaStatus(int stored, int current);   // stored < 0 = Unknown
int schemaOf(const Json& obj);                  // missing = 0; not a non-negative integer = -1

struct Result {
  Status status = Status::Invalid;
  int from = -1, version = -1;
  std::string text;   // the object to write back (Upgrade), else the input object re-serialized; empty when Invalid
};

Result migrate(const Json& doc, int from);       // doc must be an object, else Invalid
Result migrateSettings(const std::string& text); // parse + schemaOf + migrate

// What to write on a settings save: the stored object (upgraded if older) with the keys of `known` (a JSON object)
// replaced in place / appended. Unknown keys stay; a newer schema stays (no downgrade); else kSettingsSchema.
// stored == nullptr: no file.
std::string persistSettings(const std::string* stored, const std::string& known);

std::string toText(const Json& v);   // compact JSON, insertion order, JS number formatting

}  // namespace x4::migrate
