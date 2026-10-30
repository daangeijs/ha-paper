// HTTPS helpers: attach the IDF built-in Mozilla CA bundle (x509_crt_bundle, linked from libmbedtls).
#pragma once
#include <NetworkClientSecure.h>

#include <string>
#include <utility>
#include <vector>
#include <cstddef>
#include <cstdint>

namespace x4::net {

void attachCaBundle(NetworkClientSecure& c);

// Returned instead of an HTTP status when an https:// request is skipped for lack of internal heap (net/health.h).
// Also for a handshake that failed with MBEDTLS_ERR_SSL_ALLOC_FAILED: two 16 KB record buffers did not fit.
constexpr int kHttpLowMemory = -100;
constexpr int kTlsAllocFailed = -0x7F00;   // MBEDTLS_ERR_SSL_ALLOC_FAILED (-32512)

// mbedTLS record buffers from a 4-slot reserve first (PSRAM on the device, internal on QEMU; net/tls_pool.cpp). Call
// before Wi-Fi starts.
void tlsPoolBegin();
unsigned tlsPoolUsed();      // slots in use now
uint32_t tlsPoolSpills();    // record buffers since boot that missed the reserve and came from the heap
constexpr unsigned kTlsPoolSlots = 4;

// DNS + TCP + TLS handshake, logged with its duration and the internal heap before it (host only, eink-ha-os#123).
// 0 = connected; else -1 or kHttpLowMemory.
int tlsConnect(NetworkClientSecure& c, const char* host, uint16_t port, uint32_t timeoutMs);

// Blocking HTTP(S) helpers for the net task. Return HTTP status (negative = transport error, kHttpLowMemory).
int httpPostForm(const std::string& url, const std::string& body, std::string& response, uint32_t timeoutMs = 15000);
// JSON POSTs to base + path, one after the other over one keep-alive connection (one TLS handshake), with
// "Authorization: Bearer <bearer>". Stops at the first non-2xx answer; returns its status, else the last one.
int httpPostJsonEach(const std::string& base, const std::string& bearer, const std::vector<std::pair<std::string, std::string>>& pathBodies,
                     uint32_t timeoutMs = 8000);
int httpGet(const std::string& url, std::string& response, size_t maxBytes = 64 * 1024, uint32_t timeoutMs = 15000,
            const char* accept = nullptr);
// GET without following redirects; a 3xx answer's Location goes to `location` (HA address probe, eink-ha-os#54).
int httpProbe(const std::string& url, std::string& response, std::string& location, size_t maxBytes, uint32_t timeoutMs);

}  // namespace x4::net
