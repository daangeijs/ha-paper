// Minimal PNG writer for the 2-bit gray framebuffer (stored deflate blocks, no zlib dependency).
#pragma once
#include <cstdint>
#include <vector>

namespace x4::net {

// fb: row-major 2 bpp, MSB first, 0 = black … 3 = white (hw/platform.h Framebuffer).
std::vector<uint8_t> encodePng2bpp(const uint8_t* fb, int w, int h);

}  // namespace x4::net
