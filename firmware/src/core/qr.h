// QR abstraction: core/UI only need a module matrix. Implemented in src/app/qr.cpp with Nayuki's qrcodegen
// (firmware/lib/qrcodegen; the emulator runs the same library's TypeScript version).
#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include <cstddef>

namespace x4 {

struct QrMatrix {
  int size = 0;
  std::vector<uint8_t> modules;   // size*size, 1 = dark
  bool at(int x, int y) const { return modules[size_t(y) * size + x] != 0; }
};

// ECC M, byte/alphanumeric/numeric as qrcodegen picks, versions 1..maxVersion (≤ 10); false = too long.
bool encodeQr(const std::string& text, QrMatrix& out, int maxVersion = 10);

}  // namespace x4
