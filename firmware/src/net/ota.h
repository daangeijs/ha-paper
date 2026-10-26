// OTA from GitHub Releases (stable = /releases/latest, beta = newest non-draft incl. pre-releases) and local
// upload (POST /api/v1/ota/upload). Release assets: firmware.bin + manifest.json {version, sha256, size, notes[]}.
//
// Rollback: main.cpp overrides verifyRollbackLater() → a freshly installed image boots ESP_OTA_IMG_PENDING_VERIFY.
//  * Marked valid (esp_ota_mark_app_valid_cancel_rollback) after 60 s of running with the network up and the App
//    loop() alive (otaLoopAlive). Home Assistant is NOT involved: updates install and stick whether or not HA is
//    linked or reachable.
//  * Crash / reboot before that → the bootloader boots the previous image on its own.
//  * No network within 10 min → esp_ota_mark_app_invalid_rollback_and_reboot (an offline image could never be
//    fixed over the air).
//  * Hang (no crash, so no reset) → otaBootGuard restarts at 12 min (esp_timer; RTC watchdog 1 min later as the
//    hardware backstop) → bootloader rollback.
// Automatic checks: Settings › Updates › Automatic — off | notify (daily check) | night (daily check + install
// 03:00–04:00 local, battery > 50 % or charging).
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

namespace x4::net {

// X4_OTA_REPO left at the "[YOU]" placeholder (a fork's build, QEMU): no GitHub checks, no daily auto check,
// no night install. Local upload keeps working. GET /api/v1/ota then reports status "idle", auto "off", repo "" and
// this message.
constexpr const char* kOtaChecksOffMsg =
    "Update checks are off in this build. Install new firmware by upload (POST /api/v1/ota/upload).";

bool otaBootGuard();                      // first line of setup(): PENDING_VERIFY → arm restart guard (true if armed)
void otaLoopAlive();                      // every App loop() pass (UI heartbeat for the health check)
void otaBegin();                          // boot: detect PENDING_VERIFY
void otaLoop();                           // net task: daily auto check, verify deadlines
bool otaCheck(std::string& err);          // blocking; updates Hub status (Available / UpToDate)
// Blocking download+install of the release found by otaCheck. Returns false (err) without touching the
// running image; on success the device restarts.
bool otaInstall(std::string& err);
std::string otaChannel();                 // "stable" | "beta"
void otaSetChannel(const std::string& ch);
std::string otaLastError();
int64_t otaLastCheckEpoch();
bool otaPendingVerify();
bool otaBusy();                           // download/install or local upload running (no maintenance restart)
bool otaChecking();
bool otaJustUpdated();                    // first boot of a new version (until the next check)
double otaAvailableSizeMb();
bool otaBatteryOk(std::string* why);      // ≥ 30 % (or charging)

// Local upload (AsyncTCP task). sha256Hex optional ("" = rely on the image's own checksum + app header).
// version: from ?version= or a manifest part sent first ("" = unknown); shown on the install face (#237)
bool otaUploadBegin(size_t size, const std::string& version, std::string& err);
void otaUploadSetVersion(const std::string& version);   // manifest part arrived after the image started
std::string otaUploadVersion(const std::string& raw);    // printable, <= 64 chars, leading "v" dropped; else ""
bool otaUploadWrite(const uint8_t* d, size_t n);
bool otaUploadEnd(const std::string& sha256Hex, std::string& err, std::string* digestHex = nullptr);
void otaUploadAbort();

}  // namespace x4::net
