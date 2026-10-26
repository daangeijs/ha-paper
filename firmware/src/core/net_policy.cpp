#include "core/net_policy.h"

#include <algorithm>

namespace x4 {

uint32_t jitterMs(uint32_t baseMs, uint32_t rnd) {
  const uint32_t span = static_cast<uint32_t>(uint64_t(baseMs) * 2 / 5);   // 40 % wide window
  return baseMs - baseMs / 5 + static_cast<uint32_t>((uint64_t(span) * rnd) >> 32);
}

uint32_t nextBackoffMs(uint32_t curMs, uint32_t maxMs) {
  return curMs >= maxMs / 2 ? maxMs : curMs * 2;
}

uint32_t ElapsedSum::add(uint32_t now) {
  constexpr uint32_t kMaxStep = 60000;
  if (!running_) {
    running_ = true;
    total_ = 0;
  } else {
    const uint32_t step = std::min(now - last_, kMaxStep);
    total_ = total_ > UINT32_MAX - step ? UINT32_MAX : total_ + step;
  }
  last_ = now;
  return total_;
}

void WifiEscalation::reset() {
  offline_.reset();
  restartSent_ = false;
}

uint32_t WifiEscalation::restartAfterMs() const {
  uint32_t t = kRestartMs;
  for (uint32_t i = 0; i < restarts_ && t < kRestartMaxMs; i++) t *= 2;
  return std::min(t, kRestartMaxMs);
}

WifiEscalation::Action WifiEscalation::poll(uint32_t now, bool mayReset, bool mayRestart) {
  if (!offline_.running()) {
    offline_.add(now);
    nextRetry_ = kRetryMs;
    nextReset_ = kResetMs;
    return Action::None;
  }
  const uint32_t t = offline_.add(now);
  if (!restartSent_ && mayRestart && t >= restartAfterMs()) {
    restartSent_ = true;
    return Action::Restart;
  }
  if (t >= nextReset_ && mayReset) {
    nextReset_ = t + kResetMs;
    nextRetry_ = t + kRetryMs;
    return Action::Reset;
  }
  if (t >= nextRetry_) {
    nextRetry_ = t + kRetryMs;
    return Action::Reconnect;
  }
  return Action::None;
}

void StaleLink::reached() {
  fails_ = 0;
  waitMs_ = kStaleMs;
}

void StaleLink::failed(uint32_t now) {
  if (fails_++ == 0) firstFail_ = now;
}

void StaleLink::linkDown() { fails_ = 0; }

bool StaleLink::poll(uint32_t now) {
  if (fails_ < kFails || now - firstFail_ < waitMs_) return false;
  fails_ = 0;
  waitMs_ = std::min(waitMs_ * 2, kMaxMs);
  return true;
}

bool HeapWatch::sample(uint32_t now, uint32_t largestFreeBlock, uint32_t freeInternal, int localHour, bool mayRestart) {
  if (heapOkForTls(largestFreeBlock, freeInternal)) {
    low_.reset();
    sent_ = false;
    return false;
  }
  const uint32_t t = low_.add(now);
  if (sent_ || !mayRestart || localHour != 3 || t < kLowForMs) return false;
  sent_ = true;
  return true;
}

bool sameOriginWrite(const std::string& origin, const std::string& referer, const std::string& host) {
  if (host.empty()) return false;
  const std::string want = "http://" + host;
  if (!origin.empty()) return origin == want;
  return referer == want || referer.compare(0, want.size() + 1, want + "/") == 0;
}

}  // namespace x4
