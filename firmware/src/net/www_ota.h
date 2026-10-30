// Web console (`www` partition, www.bin) rewritten over the air (#350), so console and firmware never drift.
//  * The console carries its version (/www/version.txt, scripts/build_ui.py = X4_FW_VERSION of the same build).
//    version != firmwareVersion() → stale: the web server shows "console out of date" at / (old console one click on).
//  * Sources: the release of the running version (net/ota.cpp, net task in steps, only once the image is confirmed so
//    a rolled-back app never meets a newer console) or POST /api/v1/ota/upload-www (AsyncTCP).
//  * One writer at a time; core/www_image bounds it to 0xC90000..0xFD0000 (never NVS/userdata), streamed with
//    sha256. A userdata marker (/www.pending) is set before the first erase and cleared after the sha check: a power
//    loss mid-write reads as failed after the reboot, not as current.
//  * Console files are only read through wwwStat/wwwRead (one chunk per call, under a lock): no File handle outlives a
//    call, so the unmount for a rewrite never pulls the file system from under a response.
//  * Failed (console offline): the release is retried every 10 min and on reconnect; stale (old console works):
//    after every check, otherwise every 6 h (net/ota.cpp).
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

namespace x4::net {

struct WwwInfo {
  std::string version;   // "" = no version.txt (console older than #350) or not mounted
  std::string sha256;    // of the whole partition; "" until known (hashed once per image, cached in userdata)
  std::string message;   // why the last write failed
  const char* state;     // current | stale | missing | updating | failed
  bool current;
};

WwwInfo wwwInfo();
bool wwwServing();   // mounted, not being rewritten, last write not failed
bool wwwWriting();   // a rewrite runs (counts as otaBusy: no firmware install, no maintenance restart, no sleep)
bool wwwCurrent();   // console version == firmware version

// Console files (path like "/www/app.js.gz"). false / -1 while not serving or missing.
bool wwwStat(const char* path, size_t& size);
int wwwRead(const char* path, size_t off, uint8_t* d, size_t n);

// 0 = started; else an HTTP status (409 busy/battery/unconfirmed firmware, 413 size, 500) with err.
int wwwWriteBegin(size_t size, std::string& err);
// false: err says why, for a flash error with the op, flash address and esp_err_t name
bool wwwWriteChunk(const uint8_t* d, size_t n, std::string* err = nullptr);
bool wwwWriteEnd(const std::string& sha256Hex, std::string& err, std::string* digestHex = nullptr);
void wwwWriteAbort(const char* why);

void wwwLoop();   // net task: abort a stalled upload, hash the partition once if its sha is unknown

}  // namespace x4::net
