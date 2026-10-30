// ArduinoJson documents in PSRAM (eink-ha-os#57). malloc() keeps blocks up to 4 KB in internal RAM (main.cpp), so the default
// allocator would put every string and pool there: an 800-entity HA answer is thousands of small blocks, and the
// long-lived allocations made meanwhile split the contiguous block a TLS handshake needs (net/health.h). Falls back
// to internal RAM when PSRAM is missing or full.
#pragma once
#include <ArduinoJson.h>
#include <esp_heap_caps.h>

#include <cstdlib>

namespace x4::net {

class PsramJsonAllocator : public ArduinoJson::Allocator {
 public:
  void* allocate(size_t n) override {
    void* p = heap_caps_malloc(n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    return p ? p : malloc(n);
  }
  void deallocate(void* p) override { free(p); }   // free() takes blocks from either heap
  void* reallocate(void* p, size_t n) override {
    void* q = heap_caps_realloc(p, n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    return q ? q : realloc(p, n);
  }
};

// `JsonDocument d(psramJson());` for anything built from Home Assistant data.
inline ArduinoJson::Allocator* psramJson() {
  static PsramJsonAllocator a;
  return &a;
}

// While alive, `operator new` on this task allocates PSRAM (net/psram.cpp), so std containers of pure core code
// (x4::Json DOM, Config) stay out of internal RAM (eink-ha-os#137: the seed answer's DOM took ~80 KB of it, low-water 1.1 KB).
// Wrap only pure computation: never a scope that may create a DMA buffer (TLS, SPI). Nests; per task (eink-ha-os#160: the web
// task's config PUT and the net task's entity events overlap), up to 4 tasks at once, a 5th allocates internal RAM.
class PsramScope {
 public:
  PsramScope();
  ~PsramScope();
  PsramScope(const PsramScope&) = delete;
  PsramScope& operator=(const PsramScope&) = delete;

 private:
  void* slot_;
};

}  // namespace x4::net
