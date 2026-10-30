#include "core/diag.h"

#include <cstdio>
#include <cstring>

#include "core/json.h"

namespace x4::diag {

namespace {

void copyCut(char* dst, size_t cap, const char* src) {
  size_t i = 0;
  for (; src && src[i] && i < cap - 1; i++) dst[i] = src[i];
  dst[i] = '\0';
}

bool terminated(const char* s, size_t cap) { return memchr(s, '\0', cap) != nullptr; }

std::string num(uint64_t v) { return std::to_string(v); }
std::string hex32(uint32_t v) {
  char b[11];
  snprintf(b, sizeof b, "0x%08x", static_cast<unsigned>(v));
  return b;
}
std::string strOrNull(const char* s) { return s && *s ? jsonQuote(s) : "null"; }
std::string epochOrNull(int64_t e) { return e > 0 ? std::to_string(e) : "null"; }

std::string bootJson(const Boot& b, bool api) {
  std::string o = "{\"reason\":" + jsonQuote(b.reason) + ",\"hw\":" + strOrNull(b.hw);
  if (api) o += std::string(",\"crash\":") + (isCrash(b.reason) ? "true" : "false");
  o += ",\"version\":" + jsonQuote(b.version) + ",\"uptime_s\":" + num(b.uptimeS) +
       ",\"min_free_heap\":" + num(b.minFreeHeap) + ",\"panic\":" + strOrNull(b.panic) +
       ",\"last_seen\":" + epochOrNull(b.lastSeen) + "}";
  return o;
}

}  // namespace

void clear(Ring& r) { memset(&r, 0, sizeof r); }

const Boot* at(const Ring& r, int i) {
  if (i < 0 || i >= r.count) return nullptr;
  return &r.boots[(r.head + kBoots - i) % kBoots];
}

void push(Ring& r, const char* reason, const char* version, const char* panic, const char* hw) {
  // glance (#10): a DEEPSLEEP wake right after a DEEPSLEEP wake takes its slot, so wakes never push crashes out
  const bool wake = reason && !strcmp(reason, "DEEPSLEEP");
  if (wake && r.count && !strcmp(r.boots[r.head].reason, "DEEPSLEEP")) {
    r.head = static_cast<uint8_t>((r.head + kBoots - 1) % kBoots);   // drop it: the push below reuses its slot
    r.count--;
  }
  r.head = r.count ? static_cast<uint8_t>((r.head + 1) % kBoots) : 0;
  if (r.count < kBoots) r.count++;
  Boot& b = r.boots[r.head];
  memset(&b, 0, sizeof b);
  copyCut(b.reason, sizeof b.reason, reason);
  copyCut(b.version, sizeof b.version, version);
  copyCut(b.panic, sizeof b.panic, panic);
  copyCut(b.hw, sizeof b.hw, hw);
}

void touch(Ring& r, uint32_t uptimeS, uint32_t minFreeHeap, int64_t epoch) {
  if (!r.count) return;
  Boot& b = r.boots[r.head];
  b.uptimeS = uptimeS;
  b.minFreeHeap = minFreeHeap;
  if (epoch > 0) b.lastSeen = epoch;
}

bool isCrash(const char* reason) {
  for (const char* c : {"PANIC", "INT_WDT", "TASK_WDT", "WDT", "BROWNOUT", "CPU_LOCKUP"})
    if (strcmp(reason, c) == 0) return true;
  return false;
}

bool valid(const Ring& r) {
  if (r.count > kBoots || r.head >= kBoots) return false;
  for (const Boot& b : r.boots)
    if (!terminated(b.reason, sizeof b.reason) || !terminated(b.version, sizeof b.version) || !terminated(b.panic, sizeof b.panic) ||
        !terminated(b.hw, sizeof b.hw))
      return false;
  return true;
}

std::string bootsJson(const Ring& r) {
  std::string o = "[";
  for (int i = 0; i < r.count; i++) o += (i ? "," : "") + bootJson(*at(r, i), true);
  return o + "]";
}

std::string lastCrashJson(const Ring& r) {
  for (int i = 0; i < r.count; i++) {
    const Boot& b = *at(r, i);
    if (!isCrash(b.reason)) continue;
    const Boot* prev = at(r, i + 1);
    return "{\"reason\":" + jsonQuote(b.reason) + ",\"panic\":" + strOrNull(b.panic) +
           ",\"version\":" + jsonQuote(prev ? prev->version : b.version) +
           ",\"uptime_s\":" + (prev ? num(prev->uptimeS) : "null") +
           ",\"last_seen\":" + (prev ? epochOrNull(prev->lastSeen) : "null") + "}";
  }
  return "null";
}

std::string toJson(const Ring& r) {
  std::string o = "{\"boots\":[";
  for (int i = 0; i < r.count; i++) o += (i ? "," : "") + bootJson(*at(r, i), false);
  return o + "]}";
}

bool fromJson(const std::string& text, Ring& out) {
  clear(out);
  Json j;
  if (!parseJson(text, j) || !j.isObj()) return false;
  const Json* boots = j.get("boots");
  if (!boots || !boots->isArr()) return false;
  // stored newest first → push oldest first
  const int n = static_cast<int>(boots->arr.size()) < kBoots ? static_cast<int>(boots->arr.size()) : kBoots;
  for (int i = n - 1; i >= 0; i--) {
    const Json& b = boots->arr[i];
    if (!b.isObj()) return false;
    const Json* panic = b.get("panic");
    const std::string p = panic ? panic->strOr("") : "";
    const Json* hw = b.get("hw");
    const std::string w = hw ? hw->strOr("") : "";
    push(out, (b.get("reason") ? b.get("reason")->strOr("UNKNOWN") : "UNKNOWN").c_str(),
         (b.get("version") ? b.get("version")->strOr("") : "").c_str(), p.c_str(), w.c_str());
    Boot& cur = out.boots[out.head];
    if (const Json* u = b.get("uptime_s")) cur.uptimeS = static_cast<uint32_t>(u->numOr(0));
    if (const Json* h = b.get("min_free_heap")) cur.minFreeHeap = static_cast<uint32_t>(h->numOr(0));
    if (const Json* s = b.get("last_seen")) cur.lastSeen = static_cast<int64_t>(s->numOr(0));
  }
  return true;
}

void appendOlder(Ring& r, const Ring& older) {
  Ring merged;
  clear(merged);
  const int keep = r.count;
  const int extra = older.count < kBoots - keep ? older.count : kBoots - keep;
  // oldest first: the tail of `older`, then r
  for (int i = extra - 1; i >= 0; i--) {
    push(merged, "", "", nullptr);
    merged.boots[merged.head] = *at(older, i);
  }
  for (int i = keep - 1; i >= 0; i--) {
    push(merged, "", "", nullptr);
    merged.boots[merged.head] = *at(r, i);
  }
  r = merged;
}

std::string wdtJson(const Wdt& w) {
  if (!w.set) return "null";
  return "{\"uptime_s\":" + num(w.uptimeS) + ",\"tasks\":" + jsonQuote(w.tasks) + ",\"free_internal\":" + num(w.freeInternal) +
         ",\"largest_internal\":" + num(w.largestInternal) + ",\"min_dma\":" + num(w.minDma) +
         ",\"last_log\":" + strOrNull(w.lastLog.c_str()) + "}";
}

std::string reportJson(const Ring& r, const Report& rep) {
  std::string o = "{\"firmware\":" + jsonQuote(rep.firmware) + ",\"uptime_s\":" + num(rep.uptimeS) +
                  ",\"reset_reason\":" + jsonQuote(rep.resetReason) + ",\"boots\":" + bootsJson(r) +
                  ",\"last_crash\":" + lastCrashJson(r) + ",\"last_wdt\":" + wdtJson(rep.wdt);
  const Heap& h = rep.heap;
  o += ",\"heap\":{\"free_internal\":" + num(h.freeInternal) + ",\"min_free_internal\":" + num(h.minFreeInternal) +
       ",\"largest_free_internal\":" + num(h.largestFreeInternal) + ",\"free_psram\":" + num(h.freePsram) + ",\"low_point\":";
  const LowPoint& lp = h.lowPoint;
  if (!lp.set) o += "null}";
  else
    o += "{\"min_free_internal\":" + num(lp.minFreeInternal) + ",\"min_dma\":" + num(lp.minDma) +
         ",\"min_8bit_int\":" + num(lp.min8bitInt) + ",\"uptime_s\":" + num(lp.uptimeS) + ",\"where\":" + jsonQuote(lp.where) +
         ",\"ws\":" + (lp.ws ? "true" : "false") + ",\"tls_slots\":" + std::to_string(lp.tlsSlots) +
         ",\"ha_report\":" + (lp.haReport ? "true" : "false") + ",\"ota\":" + (lp.ota ? "true" : "false") +
         ",\"web_open\":" + std::to_string(lp.webOpen) + ",\"last_path\":" + jsonQuote(lp.lastPath) +
         ",\"rssi\":" + (lp.rssiKnown ? std::to_string(lp.rssi) : "null") + "}}";
  const Panel& p = rep.panel;
  static const char* const kVerdicts[] = {"primary", "ultrachip", "inconclusive"};
  std::string ver;
  for (int i = 0; i < p.verBytes && i < 5; i++) {
    char b[4];
    snprintf(b, sizeof b, i ? " %02X" : "%02X", p.ver[i]);
    ver += b;
  }
  o += ",\"panel\":{\"controller\":" + jsonQuote(p.controller) + ",\"source\":" + jsonQuote(p.source) +
       ",\"verdict\":" + (p.probed && p.verdict < 3 ? jsonQuote(kVerdicts[p.verdict]) : "null") +
       ",\"promoted\":" + (p.promoted ? "true" : "false") +
       ",\"ver\":" + (p.probed && !ver.empty() ? jsonQuote(ver) : "null") +
       ",\"flg\":" + (p.probed ? num(p.flg) : "null") +
       ",\"nvs_screen_type\":" + (p.nvsScreenType >= 0 ? std::to_string(p.nvsScreenType) : "null") +
       ",\"failed\":" + (p.failure.empty() ? "false" : "true") +
       ",\"failure\":" + (p.failure.empty() ? "null" : jsonQuote(p.failure)) + "}";
  const Coredump& c = rep.core;
  if (c.present) {
    std::string bt = "[";
    for (uint32_t i = 0; i < c.btDepth && i < 16; i++) bt += (i ? "," : "") + jsonQuote(hex32(c.bt[i]));
    bt += "]";
    o += ",\"coredump\":{\"task\":" + jsonQuote(c.task) + ",\"pc\":" + jsonQuote(hex32(c.pc)) + ",\"backtrace\":" + bt +
         ",\"backtrace_corrupted\":" + (c.btCorrupted ? "true" : "false") + ",\"exc_cause\":" + num(c.excCause) +
         ",\"exc_vaddr\":" + jsonQuote(hex32(c.excVaddr)) + ",\"panic\":" + strOrNull(c.panic.c_str()) +
         ",\"elf_sha256\":" + jsonQuote(c.elfSha256) + ",\"size\":" + num(c.size) + "}";
  } else {
    o += ",\"coredump\":null";
  }
  o += ",\"touch_recoveries\":" + (rep.touchRecoveries >= 0 ? std::to_string(rep.touchRecoveries) : std::string("null"));
  o += ",\"deep_sleep\":{\"armed\":" + std::string(rep.sleepBootsLeft > 0 ? "false" : "true") + ",\"boots_left\":" +
       std::to_string(rep.sleepBootsLeft > 0 ? rep.sleepBootsLeft : 0) +
       ",\"armed_by\":" + (rep.sleepArmedBy ? jsonQuote(rep.sleepArmedBy) : std::string("null")) + "}";
  o += ",\"battery\":" + (rep.batteryJson.empty() ? std::string("null") : rep.batteryJson);
  o += ",\"power_trail\":{\"before_boot\":" + strOrNull(rep.trailBeforeBoot.c_str()) + ",\"lines\":[";
  for (size_t i = 0; i < rep.trail.size(); i++) o += (i ? "," : "") + jsonQuote(rep.trail[i]);
  o += "],\"empty_house_sleeps\":" + std::to_string(rep.emptyHouseSleeps) +
       ",\"phases\":" + (rep.phasesJson.empty() ? std::string("null") : rep.phasesJson) + "}";
  const Net& n = rep.net;
  o += ",\"web\":{\"open\":" + std::to_string(n.webOpen) + ",\"served\":" + num(n.served) + ",\"refused_503\":" +
       num(n.refused503) + ",\"last_request_age_s\":" + (n.lastRequestAgeS >= 0 ? std::to_string(n.lastRequestAgeS) : "null") + "}";
  o += ",\"mdns\":{\"up\":" + std::string(n.mdnsUp ? "true" : "false") + ",\"restarts\":" + num(n.mdnsRestarts) +
       ",\"last_restart_reason\":" + (n.mdnsReason ? jsonQuote(n.mdnsReason) : std::string("null")) + "}";
  o += ",\"wifi\":{\"rssi\":" + (n.rssiKnown ? std::to_string(n.rssi) : std::string("null")) +
       ",\"bssid\":" + (n.bssid.empty() ? std::string("null") : jsonQuote(n.bssid)) + ",\"idle_checks\":" +
       num(n.idleChecks) + ",\"idle_reconnects\":" + num(n.idleReconnects) + "}";
  return o + "}";
}

}  // namespace x4::diag
