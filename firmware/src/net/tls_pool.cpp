// mbedTLS record buffers from a reserve in internal RAM (#123). Each TLS session allocates two of them
// (MBEDTLS_SSL_IN/OUT_BUFFER_LEN, 16717 B with CONFIG_MBEDTLS_SSL_MAX_CONTENT_LEN 16384) in mbedtls_ssl_setup. Next
// to the open WebSocket the second session often found only one free block that size: small long-lived allocations
// settle in the holes earlier sessions leave, and the report failed with -32512 every 10 s at 105 KB free.
// Four slots, taken first: the WebSocket holds two, the second session (HA report, OTA, token refresh; TLS only runs
// on the net task, so never a third) the other two. With three, that session took one 16.7 KB block from the heap per
// push; next to Wi-Fi/lwIP churn that left the real X4 Pro's largest internal block at 17,396 B after a night with
// 62 KB free and TLS refused (#198). Internal RAM, not PSRAM: the AES DMA reads these buffers, and QEMU's GDMA can't
// read PSRAM.
// Everything else (x509 chains, MPI, handshake state, cipher contexts) goes to PSRAM on the device (#198): the CPU
// reads it, and the S3 SHA/AES DMA drivers bounce or cache-sync the PSRAM buffers they are handed. QEMU keeps it
// internal (its GDMA can't read PSRAM), so the contract suite does not exercise this path.
#include "net/tls.h"

#include <esp_heap_caps.h>
#include <freertos/FreeRTOS.h>
#include <mbedtls/platform.h>

#include <cstring>

#include "Logging.h"

namespace x4::net {

namespace {

constexpr size_t kSlot = 16 * 1024 + 512;   // ≥ 16717 B (record buffer), < any other mbedTLS allocation of that order
constexpr size_t kSlots = kTlsPoolSlots;
alignas(4) uint8_t g_pool[kSlots][kSlot];
bool g_used[kSlots];
uint32_t g_spills = 0;   // record-sized allocations the reserve could not take (internal heap instead)
portMUX_TYPE g_mux = portMUX_INITIALIZER_UNLOCKED;   // mbedTLS also runs in the Wi-Fi task (WPA crypto)

void* poolCalloc(size_t n, size_t size) {
  const size_t bytes = n * size;
  if (size && bytes / size != n) return nullptr;
  if (bytes > 16 * 1024 && bytes <= kSlot) {
    int slot = -1;
    portENTER_CRITICAL(&g_mux);
    for (size_t i = 0; i < kSlots && slot < 0; i++)
      if (!g_used[i]) g_used[i] = true, slot = int(i);
    portEXIT_CRITICAL(&g_mux);
    if (slot >= 0) {
      memset(g_pool[slot], 0, bytes);
      return g_pool[slot];
    }
    g_spills++;
  }
#if !X4_QEMU
  if (bytes <= 16 * 1024)
    if (void* p = heap_caps_calloc(n, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)) return p;
#endif
  // what CONFIG_MBEDTLS_INTERNAL_MEM_ALLOC's esp_mbedtls_mem_calloc does
  return heap_caps_calloc(n, size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
}

void poolFree(void* p) {
  const auto a = reinterpret_cast<uintptr_t>(p), base = reinterpret_cast<uintptr_t>(g_pool);
  if (a >= base && a < base + sizeof g_pool) {
    portENTER_CRITICAL(&g_mux);
    g_used[(a - base) / kSlot] = false;
    portEXIT_CRITICAL(&g_mux);
    return;
  }
  heap_caps_free(p);   // also frees what was allocated before tlsPoolBegin()
}

}  // namespace

void tlsPoolBegin() {
  mbedtls_platform_set_calloc_free(poolCalloc, poolFree);
#if X4_QEMU
  const bool psram = false;
#else
  const bool psram = heap_caps_get_total_size(MALLOC_CAP_SPIRAM) > 0;
#endif
  LOG_INF("NET", "TLS: record buffers in a %u x %u B internal pool, other mbedTLS allocations in %s",
          unsigned(kSlots), unsigned(kSlot), psram ? "PSRAM" : "internal RAM");
}

uint32_t tlsPoolSpills() { return g_spills; }

unsigned tlsPoolUsed() {
  unsigned n = 0;
  portENTER_CRITICAL(&g_mux);
  for (bool u : g_used) n += u;
  portEXIT_CRITICAL(&g_mux);
  return n;
}

}  // namespace x4::net
