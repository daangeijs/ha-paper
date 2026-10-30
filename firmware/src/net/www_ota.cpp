#include "net/www_ota.h"

#include <Arduino.h>
#include <FS.h>
#include <esp_heap_caps.h>
#include <esp_partition.h>
#include <mbedtls/sha256.h>

#include <algorithm>
#include <atomic>
#include <cstring>
#include <mutex>

#include "Logging.h"
#include "core/www_image.h"
#include "hw/watchdog.h"
#include "net/health.h"
#include "net/ota.h"
#include "net/storage.h"
#include "net/util.h"

namespace x4::net {

namespace {

constexpr const char* kShaFile = "/www.sha";       // userdata: "<version> <listing marker> <partition sha256>"
constexpr const char* kPendingFile = "/www.pending";   // userdata: "1" from the first erase until the sha checked out
constexpr uint32_t kStallMs = 30000;               // an upload that stops sending is dropped after this
constexpr uint32_t kHashAfterMs = 90000;           // hash an unknown image once the device has settled

// Lock order: g_wmu → g_fsMu → g_mu. g_mu is never held across flash or file I/O.
std::mutex g_wmu;    // the writer (begin/chunk/end/abort)
std::mutex g_fsMu;   // the mount and every console file read
std::mutex g_mu;     // the strings below
std::atomic<bool> g_writing{false}, g_failed{false};   // read lock-free by the web server
std::atomic<uint32_t> g_gen{0};                        // bumped by every write: a hash taken across one is dropped
std::atomic<uint32_t> g_lastChunkMs{0};   // set by the writer (async_tcp), read by the stall check (net task)
uint32_t g_beginMs = 0;                    // g_wmu
bool g_loaded = false, g_hashTried = false;
std::string g_version, g_marker, g_digest, g_message;

www::Writer g_writer;   // g_wmu
mbedtls_sha256_context g_sha;
uint32_t g_eraseMaxMs = 0, g_eraseTotalMs = 0;

const esp_partition_t* part() {
  return esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, "www");
}

struct PartSink : www::Sink {
  const esp_partition_t* p = nullptr;
  esp_err_t last = ESP_OK;   // of the failed op (www::Writer failedOp/failedAt say which and where)
  bool erase(uint32_t off, uint32_t len) override {
    wdt::feedIfSubscribed();
    const uint32_t t0 = millis();
    last = esp_partition_erase_range(p, off, len);
    const uint32_t ms = millis() - t0;   // the async_tcp stall per 4 KB sector, logged at the end
    g_eraseTotalMs += ms;
    g_eraseMaxMs = std::max(g_eraseMaxMs, ms);
    return last == ESP_OK;
  }
  bool write(uint32_t off, const uint8_t* d, size_t n) override {
    last = esp_partition_write(p, off, d, n);
    return last == ESP_OK;
  }
} g_sink;
uint8_t* g_stage = nullptr;   // the writer's 4 KB sector buffer, internal RAM while a write runs

void freeStage() {
  free(g_stage);
  g_stage = nullptr;
}

// "flash erase failed at 0x00c9f000: ESP_ERR_FLASH_OP_TIMEOUT" (flash address); g_wmu held
std::string flashError() {
  char b[96];
  if (!*g_writer.failedOp()) return "flash write failed";
  snprintf(b, sizeof b, "flash %s failed at 0x%08x: %s", g_writer.failedOp(),
           unsigned((g_sink.p ? g_sink.p->address : 0) + g_writer.failedAt()), esp_err_to_name(g_sink.last));
  return b;
}

// SHA through internal RAM (the SHA peripheral's DMA must not read PSRAM, see net/ota.cpp eink-ha-os#57)
void shaInternal(mbedtls_sha256_context* c, const uint8_t* d, size_t n) {
  static uint8_t bounce[1024];
  while (n) {
    size_t k = std::min(n, sizeof bounce);
    memcpy(bounce, d, k);
    mbedtls_sha256_update(c, bounce, k);
    d += k;
    n -= k;
  }
}

bool pendingMarker() {
  std::string m;
  return storage().readFile(kPendingFile, m) && m == "1";
}

// Console version + a marker of the file listing (names and sizes, FNV-1a): a USB re-flash of the same version with
// other content gets a new marker, so the cached sha is not reused for it.
void scan(std::string& version, std::string& marker) {
  version.clear();
  marker.clear();
  std::lock_guard<std::mutex> f(g_fsMu);
  if (!storage().wwwOk()) return;
  if (storage().www().exists("/www/version.txt")) {   // none in consoles before eink-ha-os#350
    File v = storage().www().open("/www/version.txt", "r");
    if (v) {
      char b[96];
      size_t n = v.read(reinterpret_cast<uint8_t*>(b), sizeof b);
      v.close();
      version = www::consoleVersion(std::string(b, n));
    }
  }
  uint32_t h = 2166136261u;
  File dir = storage().www().open("/www");
  if (dir && dir.isDirectory()) {
    for (File e = dir.openNextFile(); e; e = dir.openNextFile()) {
      std::string s = std::string(e.name()) + ":" + std::to_string(e.size()) + ";";
      e.close();
      for (char c : s) h = (h ^ uint8_t(c)) * 16777619u;
    }
    dir.close();
  }
  char b[12];
  snprintf(b, sizeof b, "%08x", unsigned(h));
  marker = b;
}

// Re-read version, marker, cached sha and the interrupted-write marker (no g_mu held on entry).
void load() {
  std::string v, m, rec, digest;
  scan(v, m);
  if (!v.empty() && storage().readFile(kShaFile, rec)) {
    const std::string want = v + " " + m + " ";
    if (rec.compare(0, want.size(), want) == 0) digest = www::consoleVersion(rec.substr(want.size()));
  }
  const bool interrupted = pendingMarker();
  std::lock_guard<std::mutex> l(g_mu);
  g_loaded = true;
  g_version = v;
  g_marker = m;
  g_digest = digest;
  if (interrupted && !g_failed) {
    g_failed = true;
    g_message = "the last console write was interrupted — the console is offline until a good www.bin is written";
  }
}

void ensure() {
  bool need;
  {
    std::lock_guard<std::mutex> l(g_mu);
    need = !g_loaded && !g_writing;
  }
  if (need) load();
}

// KB/s since wwwWriteBegin; g_wmu held
unsigned kbps(size_t bytes) {
  const uint32_t ms = millis() - g_beginMs;
  return unsigned(ms ? uint64_t(bytes) * 1000 / 1024 / ms : 0);
}

// eink-ha-os#365: no data for kStallMs. The chunk time is loaded before the clock is read: async_tcp (core 0, prio 10)
// preempts the net task (core 0, prio 3) for a whole 4 KB erase, and a chunk stamped between millis() and the load
// made now - last wrap to ~4e9 → a live upload aborted as "stalled". silentMs = how long, if stalled.
bool stalled(uint32_t& silentMs) {
  const uint32_t last = g_lastChunkMs.load();
  silentMs = millis() - last;
  return int32_t(silentMs) > int32_t(kStallMs);
}

// g_wmu held
void finishWrite(bool ok, const std::string& why) {
  freeStage();
  {
    std::lock_guard<std::mutex> f(g_fsMu);
    storage().wwwRemount();
  }
  g_failed = !ok || !storage().wwwOk();
  if (!g_failed) storage().writeFile(kPendingFile, "");
  {
    std::lock_guard<std::mutex> l(g_mu);
    g_message = !ok ? why : g_failed ? "www.bin is not a LittleFS image" : "";
    g_loaded = false;
  }
  g_gen++;
  g_writing = false;
  wifiPsOffRelease();
  load();
}

}  // namespace

WwwInfo wwwInfo() {
  ensure();
  const bool mounted = storage().wwwOk();
  std::lock_guard<std::mutex> l(g_mu);
  WwwInfo i;
  i.version = g_version;
  i.sha256 = g_digest;
  i.message = g_message;
  i.current = !g_writing && !g_failed && mounted && www::consoleCurrent(g_version, firmwareVersion());
  i.state = g_writing ? "updating" : g_failed ? "failed" : !mounted ? "missing" : i.current ? "current" : "stale";
  return i;
}

bool wwwServing() {
  ensure();
  return !g_writing && !g_failed && storage().wwwOk();
}
bool wwwWriting() { return g_writing; }
bool wwwCurrent() { return wwwInfo().current; }

bool wwwStat(const char* path, size_t& size) {
  if (!wwwServing()) return false;
  std::lock_guard<std::mutex> f(g_fsMu);
  if (g_writing || !storage().wwwOk() || !storage().www().exists(path)) return false;
  File h = storage().www().open(path, "r");
  if (!h) return false;
  size = h.size();
  h.close();
  return true;
}

int wwwRead(const char* path, size_t off, uint8_t* d, size_t n) {
  if (g_writing || g_failed) return -1;
  std::lock_guard<std::mutex> f(g_fsMu);
  if (g_writing || !storage().wwwOk()) return -1;
  File h = storage().www().open(path, "r");
  if (!h) return -1;
  int k = h.seek(off) ? int(h.read(d, n)) : -1;
  h.close();
  return k;
}

int wwwWriteBegin(size_t size, std::string& err) {
  std::unique_lock<std::mutex> w(g_wmu, std::try_to_lock);
  if (!w.owns_lock() || g_writing) {
    err = "a console update is already running";
    return 409;
  }
  if (otaBusy()) {
    err = "a firmware update is running";
    return 409;
  }
  if (otaPendingVerify()) {   // a rollback must never leave a newer console behind
    err = "the new firmware is not confirmed yet — try again in a minute";
    return 409;
  }
  if (!otaBatteryOk(&err)) return 409;
  g_sink.p = part();
  if (!g_sink.p) {
    err = "no www partition";
    return 500;
  }
  if (!g_stage) g_stage = static_cast<uint8_t*>(heap_caps_malloc(www::kErase, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  if (!g_stage) {
    err = "not enough memory right now — try again in a minute";
    return 409;
  }
  if (const char* e = g_writer.begin(&g_sink, g_stage, g_sink.p->address, g_sink.p->size, size)) {
    freeStage();
    err = std::string(e) + " (" + std::to_string(g_sink.p->size) + " bytes)";
    return 413;
  }
  g_lastChunkMs = millis();   // before g_writing: the stall check in wwwLoop (net task) reads both
  g_writing = true;   // wwwStat/wwwRead refuse from here on
  {
    std::lock_guard<std::mutex> f(g_fsMu);   // waits for a read in progress; none can start after it
    storage().wwwUnmount();
  }
  if (!storage().writeFile(kPendingFile, "1")) {
    g_writer.abort();
    freeStage();
    g_writing = false;
    std::lock_guard<std::mutex> f(g_fsMu);
    storage().wwwRemount();
    err = "userdata not writable";
    return 500;
  }
  wifiPsOffAcquire();
  {
    std::lock_guard<std::mutex> l(g_mu);
    g_message.clear();
  }
  g_failed = false;
  g_gen++;
  g_eraseMaxMs = g_eraseTotalMs = 0;
  mbedtls_sha256_init(&g_sha);
  mbedtls_sha256_starts(&g_sha, 0);
  g_beginMs = millis();
  g_lastChunkMs = g_beginMs;
  LOG_INF("WWW", "rewriting the www partition (0x%06x, %u bytes)", unsigned(g_sink.p->address), unsigned(size));
  return 0;
}

bool wwwWriteChunk(const uint8_t* d, size_t n, std::string* err) {
  std::lock_guard<std::mutex> w(g_wmu);
  if (!g_writing || !g_writer.active()) {
    if (err && g_writing) *err = flashError();
    else if (err) {
      std::lock_guard<std::mutex> l(g_mu);
      const std::string why = g_message.substr(0, g_message.find(" — "));   // the reason, not the consequence
      *err = "the console update was stopped: " + (why.empty() ? std::string("aborted") : why);
    }
    return false;
  }
  wdt::feedIfSubscribed();
  shaInternal(&g_sha, d, n);
  g_lastChunkMs = millis();
  const bool ok = g_writer.write(d, n);
  g_lastChunkMs = millis();   // after the erase: a slow sector is not silence
  if (ok) return true;
  if (err) *err = flashError();
  LOG_ERR("WWW", "%s (%u of %u bytes)", flashError().c_str(), unsigned(g_writer.written()), unsigned(g_writer.size()));
  return false;
}

bool wwwWriteEnd(const std::string& sha, std::string& err, std::string* digestHex) {
  std::lock_guard<std::mutex> w(g_wmu);
  if (!g_writing) {
    err = "no console update in progress";
    return false;
  }
  uint8_t dg[32];
  mbedtls_sha256_finish(&g_sha, dg);
  mbedtls_sha256_free(&g_sha);
  const std::string got = hex(dg, 32);
  if (digestHex) *digestHex = got;
  const size_t written = g_writer.written();
  if (const char* e = g_writer.finish(got, sha)) {
    err = std::string(e) + " — the console is offline until a good www.bin is written";
    LOG_ERR("WWW", "rewrite failed after %u bytes: %s", unsigned(written), e);
    finishWrite(false, err);
    return false;
  }
  finishWrite(true, "");
  if (g_failed) {
    err = "www.bin is not a LittleFS image";
    return false;
  }
  std::string v, m;
  {
    std::lock_guard<std::mutex> l(g_mu);
    g_digest = got;
    v = g_version;
    m = g_marker;
  }
  storage().writeFile(kShaFile, v + " " + m + " " + got);
  LOG_INF("WWW", "console v%s written (%u bytes in %u s, %u KB/s; erase %u ms, max %u ms per 4 KB) · %s", v.c_str(),
          unsigned(written), unsigned((millis() - g_beginMs) / 1000), kbps(written), unsigned(g_eraseTotalMs),
          unsigned(g_eraseMaxMs),
          www::consoleCurrent(v, firmwareVersion()) ? "matches the firmware" : "still not the firmware's version");
  return true;
}

namespace {
// g_wmu held
void abortLocked(const char* why) {
  LOG_ERR("WWW", "rewrite aborted after %u of %u bytes, %u s, %u KB/s (erase %u ms, max %u ms per 4 KB): %s",
          unsigned(g_writer.written()), unsigned(g_writer.size()), unsigned((millis() - g_beginMs) / 1000),
          kbps(g_writer.written()), unsigned(g_eraseTotalMs), unsigned(g_eraseMaxMs), why);
  g_writer.abort();
  mbedtls_sha256_free(&g_sha);
  finishWrite(false, std::string(why) + " — the console is offline until a good www.bin is written");
}
}  // namespace

void wwwWriteAbort(const char* why) {
  std::lock_guard<std::mutex> w(g_wmu);
  if (g_writing) abortLocked(why);
}

void wwwLoop() {
  uint32_t silent;
  if (g_writing && stalled(silent)) {
    std::lock_guard<std::mutex> w(g_wmu);   // a chunk mid-write holds it; re-check after it
    if (g_writing && stalled(silent)) {
      char why[48];
      snprintf(why, sizeof why, "upload stalled (no data for %u s)", unsigned(silent / 1000));
      abortLocked(why);
    }
  }
  ensure();
  std::string v, m;
  {
    std::lock_guard<std::mutex> l(g_mu);
    if (g_hashTried || g_writing || millis() < kHashAfterMs || !g_digest.empty() || g_version.empty()) return;
    g_hashTried = true;   // once per boot; the result is cached per console version + listing
    v = g_version;
    m = g_marker;
  }
  const uint32_t gen = g_gen;
  const esp_partition_t* p = part();
  uint8_t* buf = static_cast<uint8_t*>(heap_caps_malloc(4096, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  if (!p || !buf) {
    free(buf);
    return;
  }
  const uint32_t t0 = millis();
  mbedtls_sha256_context c;
  mbedtls_sha256_init(&c);
  mbedtls_sha256_starts(&c, 0);
  bool ok = true;
  for (uint32_t off = 0; ok && off < p->size; off += 4096) {   // no lock: a write in between bumps g_gen
    if (off % 0x40000 == 0) wdt::feedIfSubscribed();
    ok = esp_partition_read(p, off, buf, 4096) == ESP_OK && !g_writing;
    if (ok) mbedtls_sha256_update(&c, buf, 4096);
  }
  uint8_t dg[32];
  mbedtls_sha256_finish(&c, dg);
  mbedtls_sha256_free(&c);
  free(buf);
  if (!ok || gen != g_gen) return;
  const std::string digest = hex(dg, 32);
  {
    std::lock_guard<std::mutex> l(g_mu);
    if (g_version != v) return;
    g_digest = digest;
  }
  storage().writeFile(kShaFile, v + " " + m + " " + digest);
  LOG_INF("WWW", "console v%s · sha256 %.12s… (%u ms)", v.c_str(), digest.c_str(), unsigned(millis() - t0));
}

}  // namespace x4::net
