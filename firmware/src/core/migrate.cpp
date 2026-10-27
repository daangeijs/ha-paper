#include "core/migrate.h"

#include <cmath>

#include "core/logic.h"

namespace x4::migrate {

namespace {

// Step n upgrades a settings object from schema n to n + 1, in place. Index = from-version.
using Step = void (*)(Json&);
void settings0to1(Json&) {}   // files from before versioning, same shape; only stamped
Json* member(Json& o, const std::string& k);
Json text(const std::string& s) {
  Json j;
  j.type = Json::Type::String;
  j.str = s;
  return j;
}
// 1 → 2 (#295): quiet hours. New key `quiet` from `night` (kept for a rollback); "Sleep at night" becomes glance.
void settings1to2(Json& d) {
  if (!member(d, "quiet")) {
    const Json* n = d.get("night");
    d.obj.push_back({"quiet", text(quietFromNight(n && n->isStr() ? &n->str : nullptr))});
  }
  if (Json* p = member(d, "powerSave"); p && p->isStr() && p->str == "night") p->str = "glance";
}
constexpr Step kSettingsSteps[] = {settings0to1, settings1to2};
static_assert(sizeof kSettingsSteps / sizeof kSettingsSteps[0] == kSettingsSchema, "one step per version");

Json* member(Json& o, const std::string& k) {
  for (auto& kv : o.obj)
    if (kv.first == k) return &kv.second;
  return nullptr;
}

Json number(double v) {
  Json j;
  j.type = Json::Type::Number;
  j.num = v;
  return j;
}

void setSchema(Json& o, int v) {   // where it is, or as the first key
  if (Json* s = member(o, "schema")) *s = number(v);
  else o.obj.insert(o.obj.begin(), {"schema", number(v)});
}

Result invalid() { return Result{}; }

}  // namespace

const char* statusName(Status s) {
  switch (s) {
    case Status::Current: return "current";
    case Status::Upgrade: return "upgrade";
    case Status::Newer: return "newer";
    case Status::Unknown: return "unknown";
    case Status::Invalid: break;
  }
  return "invalid";
}

Status schemaStatus(int stored, int current) {
  if (stored < 0) return Status::Unknown;
  return stored == current ? Status::Current : stored < current ? Status::Upgrade : Status::Newer;
}

int schemaOf(const Json& obj) {
  const Json* s = obj.get("schema");
  if (!s) return 0;
  if (!s->isNum() || s->num < 0 || s->num > 1e6 || std::floor(s->num) != s->num) return -1;
  return static_cast<int>(s->num);
}

Result migrate(const Json& doc, int from) {
  if (!doc.isObj()) return invalid();
  Result r;
  r.status = schemaStatus(from, kSettingsSchema);
  r.from = r.version = from;
  if (r.status != Status::Upgrade) {
    r.text = toText(doc);
    return r;
  }
  Json d = doc;
  for (int v = from; v < kSettingsSchema; v++) kSettingsSteps[v](d);
  setSchema(d, kSettingsSchema);
  r.version = kSettingsSchema;
  r.text = toText(d);
  return r;
}

Result migrateSettings(const std::string& text) {
  Json doc;
  if (!parseJson(text, doc) || !doc.isObj()) return invalid();
  return migrate(doc, schemaOf(doc));
}

std::string persistSettings(const std::string* stored, const std::string& known) {
  Json d;
  d.type = Json::Type::Object;
  bool newer = false;
  if (stored) {
    Result m = migrateSettings(*stored);
    if (m.status != Status::Invalid) parseJson(m.text, d);
    newer = m.status == Status::Newer;
  }
  if (!newer) setSchema(d, kSettingsSchema);
  Json k;
  if (parseJson(known, k) && k.isObj())
    for (auto& kv : k.obj) {
      if (Json* v = member(d, kv.first)) *v = kv.second;
      else d.obj.push_back(kv);
    }
  return toText(d);
}

std::string toText(const Json& v) {
  switch (v.type) {
    case Json::Type::Null: return "null";
    case Json::Type::Bool: return v.b ? "true" : "false";
    case Json::Type::Number: return jsNumber(v.num);
    case Json::Type::String: return jsonQuote(v.str);
    case Json::Type::Array: {
      std::string o = "[";
      for (size_t i = 0; i < v.arr.size(); i++) o += (i ? "," : "") + toText(v.arr[i]);
      return o + "]";
    }
    case Json::Type::Object: {
      std::string o = "{";
      for (size_t i = 0; i < v.obj.size(); i++) o += (i ? "," : "") + jsonQuote(v.obj[i].first) + ":" + toText(v.obj[i].second);
      return o + "}";
    }
  }
  return "null";
}

}  // namespace x4::migrate
