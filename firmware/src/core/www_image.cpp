#include "core/www_image.h"

#include <algorithm>
#include <cctype>
#include <cstring>

#include "core/json.h"

namespace x4::www {

const char* checkTarget(uint32_t addr, uint32_t partSize, size_t image) {
  if (addr < kStart || partSize == 0 || addr % kErase || partSize % kErase) return "www partition not where expected";
  if (uint64_t(addr) + partSize > kEnd) return "www partition reaches past 0xFD0000";
  if (image != partSize) return "www.bin must be exactly the size of the www partition";
  return nullptr;
}

const char* Writer::begin(Sink* s, uint8_t* buf, uint32_t addr, uint32_t partSize, size_t image) {
  sink_ = nullptr;
  failedOp_ = "";
  failedAt_ = 0;
  if (!s || !buf) return "no flash";
  if (const char* e = checkTarget(addr, partSize, image)) return e;
  sink_ = s;
  buf_ = buf;
  image_ = image;
  off_ = fill_ = 0;
  return nullptr;
}

// The staged sector (fill_ bytes ending at off_) → erase + one write at its sector offset.
bool Writer::flush() {
  const uint32_t at = static_cast<uint32_t>(off_ - fill_);
  if (!sink_->erase(at, kErase)) {
    failedOp_ = "erase";
    failedAt_ = at;
    return false;
  }
  if (!sink_->write(at, buf_, fill_)) {
    failedOp_ = "write";
    failedAt_ = at;
    return false;
  }
  fill_ = 0;
  return true;
}

bool Writer::write(const uint8_t* d, size_t n) {
  if (!sink_) return false;
  if (n > image_ - off_) {   // more than the image: refuse the whole chunk
    sink_ = nullptr;
    return false;
  }
  while (n) {
    const size_t k = std::min(n, size_t(kErase) - fill_);
    memcpy(buf_ + fill_, d, k);
    fill_ += k;
    off_ += k;
    d += k;
    n -= k;
    if ((fill_ == kErase || off_ == image_) && !flush()) {
      sink_ = nullptr;
      return false;
    }
  }
  return true;
}

const char* Writer::finish(const std::string& gotSha, const std::string& wantSha) {
  const bool was = sink_ != nullptr;
  sink_ = nullptr;
  if (!was) return "write failed";
  if (off_ != image_) return "www.bin is incomplete";
  if (gotSha.size() != 64 || wantSha.size() != 64) return "SHA-256 missing";
  for (size_t i = 0; i < 64; ++i)
    if (tolower(static_cast<unsigned char>(gotSha[i])) != tolower(static_cast<unsigned char>(wantSha[i])))
      return "SHA-256 does not match";
  return nullptr;
}

std::string consoleVersion(const std::string& file) {
  size_t b = file.find_first_not_of(" \t\r\n"), e = file.find_last_not_of(" \t\r\n");
  if (b == std::string::npos) return "";
  std::string s = file.substr(b, e - b + 1);
  if (s.size() > 64) return "";
  for (char c : s)
    if (c < 0x21 || c > 0x7e) return "";
  return s;
}

bool parseManifest(const std::string& json, Manifest& m) {
  Json j;
  if (!parseJson(json, j)) return false;
  const Json* w = j.get("www");
  if (!w || !w->isObj()) return false;
  const Json* p = w->get("path");
  const Json* s = w->get("sha256");
  const Json* n = w->get("size");
  m.path = p ? p->strOr("") : "";
  m.sha256 = s ? s->strOr("") : "";
  for (auto& c : m.sha256) c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
  const double sz = n ? n->numOr(0) : 0;
  m.size = sz > 0 && sz < 64.0 * 1024 * 1024 ? static_cast<size_t>(sz) : 0;
  if (m.sha256.size() != 64 || m.size == 0 || m.path.empty()) return false;
  for (char c : m.sha256)
    if (!isxdigit(static_cast<unsigned char>(c))) return false;
  return true;
}

}  // namespace x4::www
