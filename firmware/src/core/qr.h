// QR abstraction: core/UI only need a module matrix. Implemented in src/app/qr.cpp with ricmoo/QRCode (device + host).
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

bool encodeQr(const std::string& text, QrMatrix& out);

}  // namespace x4
