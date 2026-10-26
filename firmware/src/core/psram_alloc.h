// PSRAM allocator for the entity mirror (#76). malloc() keeps blocks up to 4 KB in internal RAM (main.cpp; lowering
// that breaks DMA users such as TLS, #79), so the hundreds of small strings and map nodes of HA entity states
// fragmented it below the contiguous block a TLS handshake needs. Every container and string inside EntityValue, EntityAdapter's raw
// states and EntityStore allocates here: PSRAM on the device (internal RAM when PSRAM is missing or full), malloc on
// the host. Native builds count live bytes so tests can check nothing else is used.
#pragma once
#include <cstddef>
#include <cstdlib>
#include <functional>
#include <map>
#include <string>
#include <string_view>
#include <utility>
#ifdef ESP_PLATFORM
#include <esp_heap_caps.h>
#endif

namespace x4 {

#ifndef ESP_PLATFORM
inline long& psramLiveBytes() { static long n = 0; return n; }   // host only: bytes held through PsramAlloc
#endif

template <class T>
struct PsramAlloc {
  using value_type = T;
  PsramAlloc() = default;
  template <class U> PsramAlloc(const PsramAlloc<U>&) {}
  T* allocate(size_t n) {
#ifdef ESP_PLATFORM
    void* p = heap_caps_malloc(n * sizeof(T), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!p) p = std::malloc(n * sizeof(T));
#else
    void* p = std::malloc(n * sizeof(T));
    psramLiveBytes() += long(n * sizeof(T));
#endif
    if (!p) std::abort();
    return static_cast<T*>(p);
  }
  void deallocate(T* p, size_t n) {
#ifndef ESP_PLATFORM
    psramLiveBytes() -= long(n * sizeof(T));
#else
    (void)n;
#endif
    std::free(p);   // takes blocks from either heap
  }
  template <class U> bool operator==(const PsramAlloc<U>&) const { return true; }
  template <class U> bool operator!=(const PsramAlloc<U>&) const { return false; }
};

// std::string in PSRAM. Converts to and from std::string so readers keep using std::string.
struct PStr : std::basic_string<char, std::char_traits<char>, PsramAlloc<char>> {
  using Base = std::basic_string<char, std::char_traits<char>, PsramAlloc<char>>;
  PStr() = default;
  PStr(const char* s) : Base(s) {}
  PStr(const char* s, size_t n) : Base(s, n) {}
  PStr(std::string_view s) : Base(s.data(), s.size()) {}
  PStr(const std::string& s) : Base(s.data(), s.size()) {}
  PStr& operator=(const char* s) { assign(s); return *this; }
  PStr& operator=(std::string_view s) { assign(s.data(), s.size()); return *this; }
  PStr& operator=(const std::string& s) { assign(s.data(), s.size()); return *this; }
  operator std::string() const { return std::string(data(), size()); }
  std::string str() const { return std::string(data(), size()); }
};
// Exact-match comparisons (beat basic_string's templates and the std::string conversion both ways).
#define X4_PSTR_CMP(A, B)                                                                                  \
  inline bool operator==(A a, B b) { return std::string_view(a) == std::string_view(b); }                 \
  inline bool operator!=(A a, B b) { return std::string_view(a) != std::string_view(b); }                 \
  inline bool operator<(A a, B b) { return std::string_view(a) < std::string_view(b); }
X4_PSTR_CMP(const PStr&, const PStr&)
X4_PSTR_CMP(const PStr&, const char*)
X4_PSTR_CMP(const char*, const PStr&)
X4_PSTR_CMP(const PStr&, const std::string&)
X4_PSTR_CMP(const std::string&, const PStr&)
#undef X4_PSTR_CMP
inline std::string operator+(std::string a, const PStr& b) { return a.append(b.data(), b.size()); }

template <class V>
using PMap = std::map<PStr, V, std::less<>, PsramAlloc<std::pair<const PStr, V>>>;

}  // namespace x4
