#include "core/access_cache.h"

#include <cstring>
#include "core/glance.h"

namespace x4::access {
namespace {
constexpr uint32_t kMagic = 0x58344154;   // "X4AT"
uint32_t sumOf(const Rec& r) {
  const auto* p = reinterpret_cast<const uint8_t*>(&r) + offsetof(Rec, bind);
  return glance::fnv1a(p, sizeof(Rec) - offsetof(Rec, bind), kMagic ^ uint32_t(sizeof(Rec)));
}
}  // namespace

uint32_t bindOf(const std::string& url, const std::string& clientId, const std::string& refresh) {
  uint32_t h = glance::fnv1a(url.data(), url.size());
  h = glance::fnv1a("\n", 1, h);
  h = glance::fnv1a(clientId.data(), clientId.size(), h);
  h = glance::fnv1a("\n", 1, h);
  return glance::fnv1a(refresh.data(), refresh.size(), h);
}

void clear(Rec& r) {
  r.magic = 0;
  volatile char* p = reinterpret_cast<volatile char*>(&r);
  for (size_t i = 0; i < sizeof r; ++i) p[i] = 0;
}

void store(Rec& r, const std::string& tok, int64_t now, int64_t ttlMs, uint32_t bind) {
  clear(r);
  if (now < kSaneEpochMs || ttlMs <= kMarginMs || ttlMs > kMaxTtlMs || tok.empty() || tok.size() >= kMaxLen) return;
  r.bind = bind;
  r.len = uint32_t(tok.size());
  r.gotAt = now;
  r.expiresAt = now + ttlMs;
  memcpy(r.tok, tok.data(), tok.size());
  r.sum = sumOf(r);
  r.magic = kMagic;
}

int64_t take(const Rec& r, int64_t now, uint32_t bind, std::string& tok) {
  if (r.magic != kMagic || r.sum != sumOf(r) || r.bind != bind) return 0;
  if (r.len == 0 || r.len >= kMaxLen || now < kSaneEpochMs || r.gotAt < kSaneEpochMs) return 0;
  if (now < r.gotAt - kSlackMs || r.expiresAt - r.gotAt > kMaxTtlMs) return 0;   // clock went back: don't trust it
  const int64_t left = r.expiresAt - now;
  if (left <= kMarginMs) return 0;
  tok.assign(r.tok, r.len);
  return left;
}

}  // namespace x4::access
