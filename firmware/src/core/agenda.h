// Agenda and Next tiles (#316) = emulator src/core/agenda.ts, vectors spec/test-vectors/agenda.json (test_agenda).
// calendar.get_events (return_response, HA 2023.12+) for local midnight today + 7 days, one call per calendar set; the
// answer streams through Scanner (no DOM, no copy of the frame) into at most kMaxEvents events of ≤ 48-byte titles.
// Fetcher plans the calls (every 30 min, at the local day change) and keeps the events in PSRAM; save()/load() carry
// them across a reboot (glance deep sleep) so a wake does not ask HA again. Pure.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>
#include "core/psram_alloc.h"
#include "core/strings.h"

namespace x4 {
namespace agenda {

constexpr int kMaxCalendars = 4;      // per tile
constexpr int kMaxTiles = 4;          // agenda + next tiles per config
constexpr int kMaxEvents = 12;        // per calendar set
constexpr size_t kTitleBytes = 48;
constexpr int kDays = 7;
constexpr int64_t kMin = 60000, kDay = 86400000;
constexpr int64_t kRefreshMs = 30 * kMin;   // and when the local day changes
constexpr int64_t kRetryMs = 5 * kMin;      // after a failed call
constexpr int64_t kTimeoutMs = 60000;

bool isAgendaType(const std::string& t);   // agenda | next
std::vector<std::string> calendarsOf(const std::string& entities);
// The tile's own rule (calendar ids are list picks, core/config.cpp): "" when fine.
std::string configError(const std::string& type, const std::string& entities);
std::string keyOf(const std::string& entities);   // sorted, without repeats, space-separated
int64_t dayOf(int64_t ms, int tz);                // local day number
std::string request(const std::string& key, int64_t now, int tz, uint32_t id);
std::string cutTitle(const std::string& s);

struct Event {
  int64_t start = 0, end = 0;
  bool allDay = false;
  uint8_t cal = 0;     // index in the key's calendar list
  uint8_t len = 0;
  char title[kTitleBytes + 1] = {};
  std::string text() const { return std::string(title, len); }
};
using EventList = std::vector<Event, PsramAlloc<Event>>;
struct Fetch {
  EventList events;   // sorted (cmp), at most kMaxEvents
  int more = 0;       // events the answer had past kMaxEvents
};
int cmp(const Event& a, const Event& b);
void insert(Fetch& f, const Event& e);

// Streaming parse of the result frame `{"id":N,"type":"result","success":true,"result":{"response":{"calendar.x":
// {"events":[{start, end, summary, …}]}}}}`, any chunking. ok(): one whole JSON value with success true.
class Scanner {
 public:
  void begin(const std::string& key, int64_t now, int tz, Fetch* out);
  void feed(const char* p, size_t n);
  bool ok() const { return !broken_ && done_ && depth_ == 0 && success_; }

 private:
  static constexpr int kMaxDepth = 32;
  static constexpr size_t kKey = 96, kVal = 40;
  void open(bool obj);
  void close();
  void scalarEnd(bool str);
  void putByte(uint8_t b);
  void putCp(uint32_t cp);
  void eventEnd();
  Fetch* out_ = nullptr;
  std::vector<std::string> cals_;
  int64_t now_ = 0, wEnd_ = 0;
  int tz_ = 0;
  uint32_t objBits_ = 0, keyBits_ = 0;
  int depth_ = 0, match_ = 0, cal_ = -1;   // match_: containers 1…match_ are on the path to an event
  enum Mode : uint8_t { Ws, Str, Esc, Uni, Lit } mode_ = Ws;
  uint8_t uni_ = 0;
  uint32_t cp_ = 0, hi_ = 0;               // \u digits; a pending high surrogate
  bool isKey_ = false, broken_ = false, done_ = false, success_ = false;
  // the string or literal in progress: key / start / end text, or the title
  enum Field : uint8_t { FNone, FKey, FStart, FEnd, FSummary, FSuccess } field_ = FNone;
  char key_[kKey + 1] = {};
  size_t keyN_ = 0;
  bool keyOver_ = false;
  char lastKey_[kKey + 1] = {};             // the key of the value that comes next
  bool lastKeyOver_ = false;
  char val_[kVal + 1] = {};
  size_t valN_ = 0;
  bool valOver_ = false;
  // event in progress
  bool evStart_ = false, evEnd_ = false;
  char start_[kVal + 1] = {}, end_[kVal + 1] = {};
  uint8_t title_[kTitleBytes + 1] = {};
  size_t titleN_ = 0;
  bool titleStr_ = false;
};

// Agenda tile lines: a day header then its events; more = events not shown.
struct Line { bool day = false; std::string time, text; bool allDay = false; };
struct Lines { std::vector<Line> lines; int more = 0; };
int maxLines(int rs);   // 4 on one row, 11 on two
Lines lines(const Fetch& f, int64_t now, int tz, Lang l, int maxLines);
// Next tile: has = a timed event not ended.
struct Next { bool has = false; std::string title, when, pill; int64_t mins = 0; };
Next next(const Fetch& f, int64_t now, int tz, Lang l);

// ---- what to ask HA, per calendar set ----
enum class State : uint8_t { Loading, Ok, Error };
class Fetcher {
 public:
  void setKeys(const std::vector<std::string>& keys);   // the config's calendar sets; others are forgotten
  void reset();                                         // new socket: nothing in flight
  bool next(int64_t now, int tz, uint32_t id, std::string& json);
  bool inFlight() const { return reqId_ != 0; }
  uint32_t requestId() const { return reqId_; }
  bool owns(uint32_t id) const { return id && id == reqId_; }
  bool timedOut(int64_t now) const { return reqId_ && now - reqAt_ >= kTimeoutMs; }
  void begin(uint32_t id);
  void feed(const char* p, size_t n) { scan_.feed(p, n); }
  bool end(int64_t now);   // true = events taken (save the cache)
  void abandon();
  // Sets whose events or state changed: f(key, state, fetch).
  template <class F> void publish(F f) {
    for (auto& s : slots_) {
      if (!s.dirty) continue;
      s.dirty = false;
      f(std::string(s.key), s.state, s.fetch);
    }
  }
  std::string save() const;                             // the sets with events (text, one line per event)
  void load(const std::string& text);                   // into the sets of setKeys that have no events yet
  size_t size() const { return slots_.size(); }

 private:
  struct Slot { PStr key; State state = State::Loading; Fetch fetch; int64_t fetchedAt = 0, triedAt = 0; bool dirty = true; };
  std::vector<Slot, PsramAlloc<Slot>> slots_;
  uint32_t reqId_ = 0;
  int reqSlot_ = -1;
  int64_t reqAt_ = 0, reqNow_ = 0;
  int reqTz_ = 0;
  Fetch incoming_;
  Scanner scan_;
};

}  // namespace agenda
}  // namespace x4
