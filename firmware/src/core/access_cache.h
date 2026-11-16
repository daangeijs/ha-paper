// HA access token across deep sleep (#19). The record lives in RTC_NOINIT memory (net/ha_client.cpp): a glance wake
// reuses a token that is still valid instead of asking /auth/token. Never in flash, never logged. Pure: epoch ms.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

namespace x4::access {

constexpr int64_t kMarginMs = 120000;              // a wake reuses the token only if it has this long left
constexpr int64_t kSlackMs = 60000;                // the clock may step back this much (BM8563 seconds, NTP)
constexpr int64_t kMaxTtlMs = 24LL * 3600000;      // longer = not what HA hands out (30 min): not kept
constexpr int64_t kSaneEpochMs = 1700000000000LL;  // clock unset: nothing is kept or reused
constexpr size_t kMaxLen = 384;                    // HA's JWT is ~180 chars

// No implicit padding: the checksum covers every byte after `sum`.
struct Rec {
  uint32_t magic, sum;
  uint32_t bind;               // link it belongs to (bindOf): a re-link or another HA never reuses it
  uint32_t len;
  int64_t gotAt, expiresAt;    // epoch ms
  char tok[kMaxLen];
};
static_assert(sizeof(Rec) == 32 + kMaxLen, "no padding in the RTC record");

// HA URL + client id + refresh token, hashed (FNV-1a 32: leaks nothing usable about the refresh token).
uint32_t bindOf(const std::string& url, const std::string& clientId, const std::string& refresh);
// Keeps tok for ttlMs from now; a bad clock, ttl or length clears instead.
void store(Rec& r, const std::string& tok, int64_t now, int64_t ttlMs, uint32_t bind);
// Zeroes the token bytes and the magic.
void clear(Rec& r);
// ms until the token expires when a wake may reuse it (more than kMarginMs left, same link, sane clock, intact
// record), else 0. tok receives it only then.
int64_t take(const Rec& r, int64_t now, uint32_t bind, std::string& tok);

}  // namespace x4::access
