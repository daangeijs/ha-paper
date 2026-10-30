#include "core/qr.h"
#include <qrcodegen.h>

#include <cstddef>

namespace x4 {

// Nayuki's qrcodegen (firmware/lib/qrcodegen, the C twin of emulator/src/core/qrcodegen.ts): ECC M, no ECC boost,
// automatic mask, the smallest version 1..maxVersion that holds the text. Buffers on the heap (v10: 2 × 407 B).
bool encodeQr(const std::string& text, QrMatrix& out, int maxVersion) {
  if (maxVersion < 1 || maxVersion > 10 || text.find('\0') != std::string::npos) return false;
  std::vector<uint8_t> tmp(qrcodegen_BUFFER_LEN_FOR_VERSION(maxVersion)), qr(tmp.size());
  if (!qrcodegen_encodeText(text.c_str(), tmp.data(), qr.data(), qrcodegen_Ecc_MEDIUM, 1, maxVersion, qrcodegen_Mask_AUTO, false))
    return false;
  const int n = qrcodegen_getSize(qr.data());
  out.size = n;
  out.modules.assign(size_t(n) * n, 0);
  for (int y = 0; y < n; ++y)
    for (int x = 0; x < n; ++x) out.modules[size_t(y) * n + x] = qrcodegen_getModule(qr.data(), x, y) ? 1 : 0;
  return true;
}

}  // namespace x4
