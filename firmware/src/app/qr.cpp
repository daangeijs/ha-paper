#include "core/qr.h"
#include <qrcode.h>

#include <cstddef>

namespace x4 {

bool encodeQr(const std::string& text, QrMatrix& out) {
  // byte-mode capacity at ECC_MEDIUM, versions 1..10 (the library does not check capacity itself)
  static const uint16_t cap[] = {14, 26, 42, 62, 84, 106, 122, 152, 180, 213};
  for (uint8_t version = 1; version <= 10; ++version) {
    if (text.size() > cap[version - 1]) continue;
    QRCode q;
    std::vector<uint8_t> buf(qrcode_getBufferSize(version));
    if (qrcode_initText(&q, buf.data(), version, ECC_MEDIUM, text.c_str()) != 0) continue;
    out.size = q.size;
    out.modules.assign(size_t(q.size) * q.size, 0);
    for (int y = 0; y < q.size; ++y)
      for (int x = 0; x < q.size; ++x) out.modules[size_t(y) * q.size + x] = qrcode_getModule(&q, x, y) ? 1 : 0;
    return true;
  }
  return false;
}

}  // namespace x4
