// History tile series from an attribute list or weather.get_forecasts (#292; emulator history.ts attrSamples, vectors
// spec/test-vectors/history-series.json). A streaming parse into Samples: the attribute's JSON text from the entity
// mirror, or a call_service answer chunk by chunk, without a DOM. Pure; samples live in PSRAM (PsramAlloc).
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>
#include "core/history.h"
#include "core/psram_alloc.h"

namespace x4 {
namespace hist {

constexpr size_t kMaxSamples = 400;   // per tile: a 5-min nowcast is ~49, an hourly forecast 48, 15-min solar 2 days 192
using SampleList = std::vector<Sample, PsramAlloc<Sample>>;

class ListScanner {
 public:
  // path: object keys from the root to the list (none: the root is the list). Entries: objects (time from `time`,
  // value from `value`; skipped without a valid time or a number) or plain numbers, one per `step` from t0.
  void begin(const char* const* path, int nPath, const std::string& value, const std::string& time, int64_t t0,
             int64_t step, int tz, SampleList* out);
  void feed(const char* p, size_t n);   // any chunking
  bool success() const { return success_; }   // a WS answer's "success": true
  bool broken() const { return broken_; }
  bool complete() const { return !broken_ && rootDone_ && depth_ == 0 && mode_ == Ws; }   // one whole JSON value
  size_t dropped() const { return dropped_; }   // entries over kMaxSamples

 private:
  static constexpr int kPath = 4;
  static constexpr size_t kKey = 96, kField = 48, kTok = 72;
  void open(bool obj);
  void close(bool obj);
  void scalar(bool str);
  void put(char c) { if (tokN_ < kTok) tok_[tokN_++] = c; else over_ = true; }
  void push(int64_t t, double v);
  SampleList* out_ = nullptr;
  char path_[kPath][kKey] = {};
  int nPath_ = 0;
  char value_[kField] = {}, time_[kField] = {};
  int64_t t0_ = 0, step_ = 0;
  int tz_ = 0;
  uint64_t objBits_ = 0, keyBits_ = 0;
  int depth_ = 0, match_ = 0;   // containers 1…match_ of the current branch are on the path
  enum Mode : uint8_t { Ws, Str, Esc, Uni, Lit } mode_ = Ws;
  uint8_t uni_ = 0;
  bool isKey_ = false, keyOk_ = false, success_ = false, broken_ = false, over_ = false, inList_ = false, inRow_ = false;
  bool succKey_ = false, rootDone_ = false;
  uint8_t rowKey_ = 0;          // the row's current key: 1 = time, 2 = value
  int64_t idx_ = 0, rowT_ = kNoTime;
  double rowV_ = kNone;
  size_t dropped_ = 0;
  char tok_[kTok + 1] = {};
  size_t tokN_ = 0;
};

// The whole text at once (an attribute from the mirror), then sorted by time (stable, like the TS sort). sc: scratch.
void attrSamples(ListScanner& sc, const char* json, size_t n, const Spec& spec, int64_t now, int tz, SampleList& out);
void sortSamples(SampleList& s);

}  // namespace hist
}  // namespace x4
