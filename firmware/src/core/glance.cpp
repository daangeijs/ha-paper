#include "core/glance.h"

#include <algorithm>
#include <cstring>

namespace x4::glance {

namespace {
constexpr uint32_t kRtcMagic = 0x474c4e44u;   // "GLND" (#178 tally); ^ sizeof(Rtc): another layout starts fresh. Bump on change
const uint8_t* body(const Rtc& r) { return reinterpret_cast<const uint8_t*>(&r) + offsetof(Rtc, hasSnap); }
constexpr size_t kBody = sizeof(Rtc) - offsetof(Rtc, hasSnap);
}  // namespace

uint32_t fnv1a(const void* data, size_t n, uint32_t h) {
  const auto* p = static_cast<const uint8_t*>(data);
  for (size_t i = 0; i < n; ++i) { h ^= p[i]; h *= 0x01000193u; }
  return h;
}

Snapshot snapshotOf(const std::map<std::string, std::string>& regions) {
  Snapshot s{};
  std::vector<Entry> all;
  uint32_t rest = 0x811c9dc5u;
  int i = 0;
  for (auto& kv : regions) {
    if (i++ < kMaxEntries - 1) { all.push_back({fnv1a(kv.first), fnv1a(kv.second)}); continue; }
    rest = fnv1a(kv.first.data(), kv.first.size(), rest);
    rest = fnv1a(kv.second.data(), kv.second.size(), rest);
  }
  if (i >= kMaxEntries) all.push_back({fnv1a(std::string("*rest*")), rest});
  std::sort(all.begin(), all.end(), [](const Entry& a, const Entry& b) { return a.key < b.key; });
  s.n = static_cast<uint8_t>(all.size());
  std::copy(all.begin(), all.end(), s.e);
  return s;
}

std::vector<uint32_t> snapshotDiff(const Snapshot* prev, const Snapshot& next, const std::vector<uint32_t>& ignore) {
  std::vector<uint32_t> out;
  auto skip = [&](uint32_t k) { return std::find(ignore.begin(), ignore.end(), k) != ignore.end(); };
  if (!prev) {
    for (int i = 0; i < next.n; ++i) if (!skip(next.e[i].key)) out.push_back(next.e[i].key);
    return out;
  }
  int a = 0, b = 0;   // merge of two key-sorted lists
  while (a < prev->n || b < next.n) {
    const Entry* p = a < prev->n ? &prev->e[a] : nullptr;
    const Entry* q = b < next.n ? &next.e[b] : nullptr;
    uint32_t k;
    bool diff;
    if (p && q && p->key == q->key) { k = p->key; diff = p->val != q->val; ++a; ++b; }
    else if (q && (!p || q->key < p->key)) { k = q->key; diff = true; ++b; }
    else { k = p->key; diff = true; ++a; }
    if (diff && !skip(k)) out.push_back(k);
  }
  return out;
}

StepOut step(const StepIn& i) {
  if (!i.ok) {
    const int fails = i.fails + 1;
    if (fails >= kOfflineAfter && !i.drawnOffline) return {true, "offline", fails, true};
    return {false, "unreachable", fails, i.drawnOffline};
  }
  if (!i.hadSnapshot) return {true, "first", 0, false};
  if (i.changed > 0) return {true, "changed", 0, false};
  if (i.drawnOffline) return {true, "back online", 0, false};
  if (i.minSinceDraw >= kStaleMin) return {true, "stale", 0, false};
  return {false, "unchanged", 0, false};
}

WifiFast wifiFast(const WifiCache& c, uint32_t savedSsidHash, int64_t nowEpoch) {
  if (!c.valid || c.ssidHash != savedSsidHash || c.channel < 1 || c.channel > 14 || c.fails >= kWifiCacheMaxFails) return WifiFast::None;
  return nowEpoch > 0 && c.ipAtEpoch > 0 && nowEpoch >= c.ipAtEpoch && nowEpoch - c.ipAtEpoch < kWifiIpMaxAgeS ? WifiFast::Ip : WifiFast::Radio;
}
const char* wifiFastName(WifiFast f) { return f == WifiFast::Ip ? "ip" : f == WifiFast::Radio ? "radio" : "none"; }

bool liveNow(int64_t msSinceInput, int liveMin) { return msSinceInput >= 0 && msSinceInput < int64_t(liveMin) * 60000; }

ArmRecord armFor(const ArmRecord* stored, const std::string& version) {
  if (stored && stored->version == version && stored->boots >= 0) return *stored;
  ArmRecord r;
  r.version = version;
  return r;
}
ArmRecord armCount(const ArmRecord& r) {
  ArmRecord n = r;
  if (n.boots < kArmBoots) n.boots++;
  return n;
}
int armBootsLeft(const ArmRecord& r) { return std::max(0, kArmBoots - r.boots); }

int64_t sleptSeconds(int64_t sleptAtEpoch, int64_t wakeAtEpoch, int64_t nowEpoch) {
  if (sleptAtEpoch > 0 && nowEpoch >= sleptAtEpoch) return nowEpoch - sleptAtEpoch;
  return wakeAtEpoch > sleptAtEpoch ? wakeAtEpoch - sleptAtEpoch : 0;
}
void tallyWake(Tally& t, int64_t sleptS) {
  t.wakes++;
  t.asleepS += uint32_t(std::max<int64_t>(0, sleptS));
}
void tallyGlance(Tally& t, bool ok, bool redraw, uint32_t wifiMs, uint32_t haMs, uint32_t totalMs) {
  if (redraw) t.redraws++;
  if (!ok) t.failedWakes++;
  t.hasLast = true;
  t.lastWifiMs = wifiMs;
  t.lastHaMs = haMs;
  t.lastTotalMs = totalMs;
}
void tallySleep(Tally& t, uint32_t awakeMs, uint32_t full, uint32_t partial) {
  t.awakeMs += awakeMs;
  t.fullRefreshes += full;
  t.partialRefreshes += partial;
}

void reset(Rtc& r) {
  memset(&r, 0, sizeof r);
  seal(r);
}
void seal(Rtc& r) {
  r.magic = kRtcMagic ^ uint32_t(sizeof(Rtc));
  r.sum = fnv1a(body(r), kBody);
}
bool valid(const Rtc& r) {
  return r.magic == (kRtcMagic ^ uint32_t(sizeof(Rtc))) && r.sum == fnv1a(body(r), kBody) && r.snap.n <= kMaxEntries;
}

}  // namespace x4::glance
