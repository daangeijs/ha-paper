// Device log ring (GET /api/v1/logs, eink-ha-os#200). Spec: emulator/src/core/logs.ts, vectors spec/test-vectors/logs.json.
// A byte ring over caller-owned memory (64 KB PSRAM on the device; a 2 KB copy in RTC memory keeps the previous
// boot's tail). Record = 16-byte header (seq, ms, epoch, level, tag len, msg len) + tag + message; records may wrap
// around the end of the buffer, so `used` is exactly the sum of record sizes and eviction matches the spec.
// Not thread-safe: net/log.cpp serialises access.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace x4::logs {

constexpr uint32_t kCap = 65536, kTailCap = 2048, kHdr = 16, kTagMax = 15, kMsgMax = 239;
constexpr uint32_t kRecMax = kHdr + kTagMax + kMsgMax;
constexpr int kLimit = 300, kLimitMax = 1000;

struct Hdr {   // bookkeeping; POD so it can live in RTC_NOINIT memory
  uint32_t cap, head, used, next, count;
};

struct Query {
  uint32_t since = 0;
  char level = 0;     // 0 = all, else E | W | I (that level and worse)
  std::string tags;   // ",HA,EPD," (uppercase, comma-wrapped) or empty = all
  int limit = kLimit;
};

class Ring {
 public:
  Ring(Hdr* h, uint8_t* data) : h_(h), d_(data) {}
  void init(uint32_t cap);
  bool valid(uint32_t cap) const;   // structure intact (after a reset: RTC memory may hold garbage)
  // msg must already be redacted; tag and msg are cut on a UTF-8 boundary. epoch 0 = clock unknown.
  void push(uint32_t ms, uint32_t epoch, char level, std::string_view tag, std::string_view msg);
  const Hdr& hdr() const { return *h_; }
  // Appends the GET /logs JSON for this ring to out. boot = "current" | "previous".
  void queryJson(const Query& q, const char* boot, std::string& out) const;

 private:
  void copyOut(uint32_t off, void* dst, uint32_t n) const;
  void copyIn(uint32_t off, const void* src, uint32_t n);
  uint32_t recSize(uint32_t off) const;
  Hdr* h_;
  uint8_t* d_;
};

// Mask secret-looking values (spec logs.ts redact). Writes at most cap bytes; returns the length.
size_t redact(const char* in, size_t n, char* out, size_t cap);
std::string redact(std::string_view in);
// Length of s cut to max bytes without splitting a UTF-8 character.
size_t cutUtf8(std::string_view s, size_t max);
// ?since=&level=&tag=&limit= (nullptr = absent) → q, or false with err (422).
bool parseQuery(const char* since, const char* level, const char* tag, const char* limit, Query& q, std::string& err);

}  // namespace x4::logs
