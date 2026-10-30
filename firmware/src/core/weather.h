// Weather tile (eink-ha-os#318), a port of emulator src/core/weather.ts (vectors spec/test-vectors/weather.json): HA condition →
// drawing, weather.get_forecasts lists → compact entries (streamed through hist::ListScanner, no DOM), and the tile's
// text. Plus the fetch plan (daily + hourly per weather entity, asked again after an hour) and the RTC_NOINIT record
// that carries the forecasts across deep sleep, so a glance wake does not ask again. Pure; the net task drives Fetcher
// (net/ha_client.cpp); all of it lives in PSRAM or RTC memory.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>
#include "core/entities.h"
#include "core/history_series.h"
#include "core/home.h"
#include "core/psram_alloc.h"
#include "core/strings.h"

namespace x4 {
namespace wx {

constexpr int kMaxTiles = 2;                     // per config; also the forecast slots
constexpr int kDaily = 7, kHourly = 16, kDays = 5;
constexpr int64_t kHourMs = 3600000, kDayMs = 24 * kHourMs;
constexpr int64_t kRefreshMs = kHourMs;          // forecasts are asked again after this
constexpr int64_t kRetryMs = 10 * 60000;         // a failed ask is not repeated sooner
constexpr int64_t kRainAheadMs = 12 * kHourMs;   // "rain from" looks this far ahead
constexpr int64_t kTimeoutMs = 60000;

enum class Icon : uint8_t { Sun, Moon, Partly, Cloud, Fog, Rain, Pour, Snow, Sleet, Thunder, Wind, Alert, Count };
const char* iconName(Icon i);
Icon iconOf(const std::string& condition);       // unknown → Cloud
std::string condText(const std::string& condition, Lang l);   // unknown → as is

// One kept entry (12 B): numbers × 100, kNoT / kNoMm = absent.
constexpr int16_t kNoT = INT16_MIN;
constexpr uint16_t kNoMm = UINT16_MAX;
struct Entry {
  uint32_t tS;       // epoch s
  int16_t temp, low;
  uint16_t mm;
  uint8_t icon, pad;
};
double tempOf(int16_t v);    // NaN when absent
double mmOf(uint16_t v);
std::string degText(double v);    // "12°", "—" when absent (weather.ts wxDeg)
bool isWet(const Entry& e);       // precipitation > 0, or without it a rain / snow / thunder drawing (wxWet)

// No implicit padding: the RTC checksum covers every byte.
struct Forecast {
  int64_t dailyAt = 0, hourlyAt = 0;   // epoch ms of the last good answer; 0 = none
  uint8_t nDaily = 0, nHourly = 0, hasDaily = 0, hasHourly = 0;
  uint32_t reserved = 0;
  Entry daily[kDaily] = {};
  Entry hourly[kHourly] = {};
  uint32_t reserved2 = 0;
};
static_assert(sizeof(Entry) == 12 && sizeof(Forecast) == 304, "no padding in the RTC record");

// A forecast list → entries (weather.ts wxEntries): `daily` keeps entries from today's local date, hourly from the hour
// holding now; at most kDaily / kHourly in HA's order; entries without a valid datetime skipped.
class EntryParser : private hist::RowFields {
 public:
  // path: object keys from the answer root to the list (none: the root is the list)
  void begin(const char* const* path, int nPath, bool daily, int64_t now, int tz, Entry* out, uint8_t* n);
  void feed(const char* p, size_t len) { sc_.feed(p, len); }
  bool success() const { return sc_.success(); }
  bool complete() const { return sc_.complete(); }
 private:
  void rowField(const char* key, const char* v, size_t n, bool str) override;
  void rowEnd() override;
  hist::ListScanner sc_;
  Entry* out_ = nullptr;
  uint8_t* n_ = nullptr;
  bool daily_ = false;
  int64_t now_ = 0;
  int tz_ = 0;
  int64_t t_ = INT64_MIN;
  double temp_ = 0, low_ = 0, mm_ = 0;
  Icon icon_ = Icon::Cloud;
  void clearRow();
};
// The whole list at once (vectors): JSON text of the list itself.
void parseList(EntryParser& p, const std::string& json, bool daily, int64_t now, int tz, Entry* out, uint8_t& n);

struct Day { std::string name, hi, lo, mm; Icon icon; double bar; };
struct View {
  EntityGap gap = EntityGap::None;
  Icon icon = Icon::Cloud;
  std::string temp, cond, feels, high, low, wind, rain;
  Day days[kDays];
  int nDays = 0;
  bool forecast = false;
};
// raw: the entity from the mirror (nullptr = not there yet); fc: nullptr or a forecast without lists = none yet.
void view(const EntityValue* raw, const Forecast* fc, int64_t now, int tz, Lang l, View& out);
std::string windText(const EntityValue& raw, Lang l);

// ---- fetch plan (net task) ----
class Fetcher {
 public:
  void setEntities(const std::vector<std::string>& ids);   // the config's weather entities (≤ kMaxTiles, unique)
  void reset();                                             // new socket: nothing in flight
  bool next(int64_t now, int tz, uint32_t id, std::string& json);
  bool owns(uint32_t id) const { return id && id == reqId_; }
  bool inFlight() const { return reqId_ != 0; }
  bool timedOut(int64_t now) const { return reqId_ && now - reqAt_ >= kTimeoutMs; }
  void begin();
  void feed(const char* p, size_t n) { parser_.feed(p, n); }
  void end(int64_t now);             // the answer is in: good → the slot's list; else kept, retried after kRetryMs
  void abandon() { reqId_ = 0; }
  int size() const { return int(slots_.size()); }
  const std::string entity(int i) const { return std::string(slots_[size_t(i)].entity); }
  const Forecast& forecast(int i) const { return slots_[size_t(i)].fc; }
  void restore(const std::string& entity, const Forecast& fc);   // from RTC after a wake
  // Slots whose forecast changed: f(entity, forecast); returns how many.
  template <class F> int publish(F f) {
    int k = 0;
    for (auto& s : slots_) if (s.dirty) { s.dirty = false; ++k; f(std::string(s.entity), s.fc); }
    return k;
  }
 private:
  struct Slot { PStr entity; Forecast fc; int64_t dailyAsk = 0, hourlyAsk = 0; bool dirty = false; };
  std::vector<Slot, PsramAlloc<Slot>> slots_;
  EntryParser parser_;
  Entry incoming_[kHourly] = {};
  uint8_t nIncoming_ = 0;
  uint32_t reqId_ = 0;
  int64_t reqAt_ = 0;
  int reqSlot_ = -1, tz_ = 0;
  bool reqDaily_ = false;
};

// ---- RTC record (deep sleep) ----
struct RtcSlot { uint32_t entityHash, reserved; Forecast fc; };
struct Rtc { uint32_t magic, sum; RtcSlot slot[kMaxTiles]; };
void seal(Rtc& r);
bool valid(const Rtc& r);
void save(Rtc& r, const Fetcher& f);           // every slot, then seal
void load(const Rtc& r, Fetcher& f);           // slots whose entity matches, if valid

}  // namespace wx
}  // namespace x4
