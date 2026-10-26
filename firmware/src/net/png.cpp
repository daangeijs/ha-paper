#include "net/png.h"

#include <cstring>
#include <algorithm>

namespace x4::net {

namespace {

uint32_t crcTable[256];
bool crcInit = false;

uint32_t crc32(const uint8_t* d, size_t n, uint32_t c = 0) {
  if (!crcInit) {
    for (uint32_t i = 0; i < 256; i++) {
      uint32_t v = i;
      for (int k = 0; k < 8; k++) v = (v & 1) ? 0xEDB88320u ^ (v >> 1) : v >> 1;
      crcTable[i] = v;
    }
    crcInit = true;
  }
  c ^= 0xFFFFFFFFu;
  for (size_t i = 0; i < n; i++) c = crcTable[(c ^ d[i]) & 0xFF] ^ (c >> 8);
  return c ^ 0xFFFFFFFFu;
}

void be32(std::vector<uint8_t>& o, uint32_t v) {
  o.push_back(v >> 24);
  o.push_back(v >> 16);
  o.push_back(v >> 8);
  o.push_back(v);
}

void chunk(std::vector<uint8_t>& o, const char* type, const uint8_t* data, size_t n) {
  be32(o, static_cast<uint32_t>(n));
  size_t start = o.size();
  o.insert(o.end(), type, type + 4);
  if (n) o.insert(o.end(), data, data + n);
  be32(o, crc32(o.data() + start, n + 4));
}

}  // namespace

std::vector<uint8_t> encodePng2bpp(const uint8_t* fb, int w, int h) {
  const size_t rowBytes = static_cast<size_t>(w) / 4;
  const size_t raw = (rowBytes + 1) * h;
  std::vector<uint8_t> o;
  o.reserve(raw + raw / 65535 * 5 + 128);
  static const uint8_t sig[8] = {137, 80, 78, 71, 13, 10, 26, 10};
  o.insert(o.end(), sig, sig + 8);
  uint8_t ihdr[13];
  ihdr[0] = w >> 24; ihdr[1] = w >> 16; ihdr[2] = w >> 8; ihdr[3] = w;
  ihdr[4] = h >> 24; ihdr[5] = h >> 16; ihdr[6] = h >> 8; ihdr[7] = h;
  ihdr[8] = 2;    // bit depth
  ihdr[9] = 0;    // grayscale (0 = black … 3 = white, same as our framebuffer)
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunk(o, "IHDR", ihdr, 13);

  // zlib stream of stored blocks
  std::vector<uint8_t> z;
  z.reserve(raw + raw / 65535 * 5 + 16);
  z.push_back(0x78);
  z.push_back(0x01);
  uint32_t a = 1, b = 0;
  std::vector<uint8_t> scan(raw);
  for (int y = 0; y < h; y++) {
    scan[y * (rowBytes + 1)] = 0;   // filter: none
    memcpy(&scan[y * (rowBytes + 1) + 1], fb + y * rowBytes, rowBytes);
  }
  for (uint8_t v : scan) {
    a = (a + v) % 65521;
    b = (b + a) % 65521;
  }
  size_t off = 0;
  while (off < raw) {
    size_t n = std::min<size_t>(65535, raw - off);
    z.push_back(off + n >= raw ? 1 : 0);
    z.push_back(n & 0xFF);
    z.push_back(n >> 8);
    z.push_back(~n & 0xFF);
    z.push_back((~n >> 8) & 0xFF);
    z.insert(z.end(), scan.begin() + off, scan.begin() + off + n);
    off += n;
  }
  be32(z, (b << 16) | a);
  chunk(o, "IDAT", z.data(), z.size());
  chunk(o, "IEND", nullptr, 0);
  return o;
}

}  // namespace x4::net
