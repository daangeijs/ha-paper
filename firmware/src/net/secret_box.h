// App-level encryption for secrets kept in NVS (HA refresh token, Wi-Fi password).
//
// The precompiled Arduino core has no NVS encryption / flash encryption, so secrets are sealed with
// AES-256-GCM. Key = HMAC-SHA256(chip base MAC ‖ eFuse OPTIONAL_UNIQUE_ID, "x4-home/secrets/v1").
// The label keeps the old product name (#217): changing it would make sealed secrets unreadable.
//
// LIMITATION (see docs/FLASHING.md "Security notes"): the key material lives in readable eFuse, not in
// flash. A flash dump on its own does not reveal secrets, but anyone with the device itself (USB access →
// esptool read-mac / espefuse summary, or running their own firmware) can derive the key. Real protection
// needs flash encryption + secure boot (custom IDF sdkconfig, irreversible eFuse burn) — out of scope.
#pragma once
#include <string>

namespace x4::net {

class SecretBox {
 public:
  static std::string seal(const std::string& plain);            // → "v1:" base64(iv ‖ tag ‖ ct); "" on error
  static bool open(const std::string& sealed, std::string& out); // false = tampered / other device / junk
};

}  // namespace x4::net
