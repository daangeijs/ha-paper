// Web console update over the air (#350): the `www` partition (partitions.csv, www.bin) rewritten in place.
// Pure: bounds, the sequential erase-then-write order, the sha256 verdict, the console version file and the
// manifest.json `www` entry. net/www_ota.cpp drives it with esp_partition_* and mbedtls.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

namespace x4::www {

constexpr uint32_t kStart = 0xC90000;   // partitions.csv `www`
constexpr uint32_t kEnd = 0xFD0000;     // userdata starts here; nothing at or past it is ever written
// One 4 KB sector at a time: erase, then one aligned 4 KB write from an internal staging buffer, like Arduino Update
// (the firmware upload). The first device run erased 64 KB blocks and wrote TCP-sized chunks straight from the
// pbuf: three uploads failed with "flash write failed" and one stalled (#350, 0.2.0-beta.5.n7).
constexpr uint32_t kErase = 0x1000;     // sector (partition offset and size are multiples of it)

// Partition (flash address, size) and the image size: the partition must lie inside [kStart, kEnd) and the image
// fill it exactly (mklittlefs pads www.bin to the partition size). nullptr = ok, else the reason.
const char* checkTarget(uint32_t addr, uint32_t partSize, size_t image);

struct Sink {   // partition-relative offsets
  virtual ~Sink() = default;
  virtual bool erase(uint32_t off, uint32_t len) = 0;
  virtual bool write(uint32_t off, const uint8_t* d, size_t n) = 0;
};

// Sequential writer: bytes are staged in buf (kErase bytes, caller-owned, internal RAM); each full sector is erased and
// written in one go. Never past the image.
class Writer {
 public:
  const char* begin(Sink* s, uint8_t* buf, uint32_t addr, uint32_t partSize, size_t image);   // nullptr = ok
  bool write(const uint8_t* d, size_t n);
  // gotSha = digest of the bytes written, wantSha = expected (hex, any case). nullptr = complete and matching.
  const char* finish(const std::string& gotSha, const std::string& wantSha);
  void abort() { sink_ = nullptr; }
  bool active() const { return sink_ != nullptr; }
  size_t written() const { return off_; }
  size_t size() const { return image_; }
  // after a failed write(): which flash op failed and at which partition offset ("" = refused, not a flash error)
  const char* failedOp() const { return failedOp_; }
  uint32_t failedAt() const { return failedAt_; }

 private:
  bool flush();
  Sink* sink_ = nullptr;
  uint8_t* buf_ = nullptr;
  size_t image_ = 0, off_ = 0, fill_ = 0;
  const char* failedOp_ = "";
  uint32_t failedAt_ = 0;
};

// /www/version.txt (scripts/build_ui.py): trimmed, printable ASCII, <= 64 chars; else "" (missing/garbled).
std::string consoleVersion(const std::string& file);
inline bool consoleCurrent(const std::string& console, const std::string& fw) { return !console.empty() && console == fw; }

// manifest.json `www`: {path, size, sha256} (firmware/scripts/release_manifest.py). false = absent or malformed.
struct Manifest {
  std::string path, sha256;
  size_t size = 0;
};
bool parseManifest(const std::string& json, Manifest& m);

}  // namespace x4::www
