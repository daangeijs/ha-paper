// Small helpers shared by src/net (device only).
#pragma once
#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>

namespace x4::net {

std::string randomToken(size_t n, const char* alphabet);       // esp_random-based
void randomBytes(uint8_t* out, size_t n);
std::string hex(const uint8_t* d, size_t n);
std::string sha256Hex(const std::string& s);
void sha256(const uint8_t* d, size_t n, uint8_t out[32]);
std::string base64UrlNoPad(const uint8_t* d, size_t n);
std::string base64Encode(const uint8_t* d, size_t n);
bool base64Decode(const std::string& in, std::vector<uint8_t>& out);
std::string urlEncode(const std::string& s);
bool constantTimeEq(const std::string& a, const std::string& b);
std::string jsonEscape(const std::string& s);
std::string errorJson(const std::string& msg);

// "http://ha.local:8123/" → scheme/host/port/basePath. Returns false on junk.
struct Url { bool tls = false; std::string host; uint16_t port = 80; std::string path; };
bool parseUrl(const std::string& in, Url& out);
std::string normalizeBaseUrl(const std::string& in);   // trims trailing '/', adds http:// if missing

// Semver-ish compare: "0.3.0" < "0.3.1-beta.1" < "0.3.1". Returns -1/0/1.
int compareVersions(const std::string& a, const std::string& b);

const char* firmwareVersion();   // X4_FW_VERSION or "0.0.0-dev"
const char* otaRepo();           // X4_OTA_REPO; "" when still the [YOU] placeholder

// Power instrumentation (/status `power`, boot log; docs/ROBUSTNESS_PLAN.md 3.0).
const char* wifiPsMode();        // esp_wifi_get_ps: "none" | "min" | "max"; nullptr when the Wi-Fi driver is not running (QEMU)
bool usbHostPlugged();           // USB-Serial-JTAG sees a host (SOF timer); false on QEMU

}  // namespace x4::net
