// Guest Wi-Fi tile (eink-ha-os#329) = emulator src/core/guestWifi.ts; vectors spec/test-vectors/guest-wifi.json. Pure. The QR is
// core/qr.h (qrcodegen, ECC M, version 1..6). Never log the payload, the ssid or the password.
#pragma once
#include <string>
#include "core/qr.h"

namespace x4 {
namespace guest {

constexpr int kMaxVersion = 6;
constexpr int kQuiet = 4;      // quiet zone, modules
constexpr int kTextH = 108;    // two rows: caption (18 high) + value (34 high), 54 apart
constexpr int kRowValue = 18, kRowNext = 54;

std::string wifiEscape(const std::string& s);   // backslash before \ ; , : "
std::string payload(const std::string& ssid, const std::string& password, const std::string& security, bool hidden);
std::string fieldEncode(const std::string& v);  // screens.yaml form of ssid / password (%XX), see guestWifi.ts
std::string fieldDecode(const std::string& v);
bool validSecurity(const std::string& s);      // WPA, WEP, nopass
bool pwDomain(const std::string& entityId);    // input_text, text, sensor

enum class Status { Ok, Pick, Wait, Long };
struct View {
  Status status = Status::Pick;
  std::string ssid, password, payload;   // payload only for Ok / Long
  bool open = false;                     // security nopass
};
// ssid / password as stored (encoded); pwState nullptr = the entity has no state.
View view(const std::string& ssid, const std::string& password, const std::string& security, const std::string& hidden,
          const std::string& pwEntity, const char* pwState);
// The modules of a payload at version <= 6 (false = too long). Keeps the last result: signatures and paint of a
// static tile ask for the same code.
bool encode(const std::string& payload, QrMatrix& m);

enum class Kind { Stack, Side, Qr };
struct Layout {
  Kind kind = Kind::Qr;
  int zx = 0, zy = 0, zs = 0;    // the square for the code and its quiet zone
  int px = 0, qx = 0, qy = 0;    // px per module (0 = no code), the code's top-left
  bool hasText = false;
  int tx = 0, ty = 0, tw = 0;    // text block
};
// Tile-relative geometry of a w × h tile (2 px border inside), n modules per side (0 = no code).
Layout layout(int w, int h, int cs, int rs, int n);

}  // namespace guest
}  // namespace x4
