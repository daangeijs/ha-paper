#include "net/secret_box.h"

#include <esp_efuse.h>
#include <esp_efuse_table.h>
#include <esp_mac.h>
#include <mbedtls/gcm.h>
#include <mbedtls/md.h>

#include <cstring>
#include <vector>
#include <utility>

#include "net/util.h"

namespace x4::net {

namespace {

constexpr size_t kIv = 12, kTag = 16;

void deriveKey(uint8_t key[32]) {
  static uint8_t cached[32];
  static bool have = false;
  if (!have) {
    uint8_t material[6 + 16] = {0};
    esp_efuse_mac_get_default(material);
#if defined(CONFIG_IDF_TARGET_ESP32S3)
    // 128-bit factory-random unique id (may be all zero on some lots; MAC still differs per chip)
    esp_efuse_read_field_blob(ESP_EFUSE_OPTIONAL_UNIQUE_ID, material + 6, 128);
#endif
    static const char* info = "x4-home/secrets/v1";
    const mbedtls_md_info_t* md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    mbedtls_md_hmac(md, material, sizeof material, reinterpret_cast<const uint8_t*>(info), strlen(info), cached);
    memset(material, 0, sizeof material);
    have = true;
  }
  memcpy(key, cached, 32);
}

}  // namespace

std::string SecretBox::seal(const std::string& plain) {
  uint8_t key[32];
  deriveKey(key);
  std::vector<uint8_t> buf(kIv + kTag + plain.size());
  randomBytes(buf.data(), kIv);
  mbedtls_gcm_context gcm;
  mbedtls_gcm_init(&gcm);
  int rc = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, key, 256);
  if (rc == 0)
    rc = mbedtls_gcm_crypt_and_tag(&gcm, MBEDTLS_GCM_ENCRYPT, plain.size(), buf.data(), kIv, nullptr, 0,
                                   reinterpret_cast<const uint8_t*>(plain.data()), buf.data() + kIv + kTag, kTag,
                                   buf.data() + kIv);
  mbedtls_gcm_free(&gcm);
  memset(key, 0, sizeof key);
  if (rc != 0) return {};
  return "v1:" + base64Encode(buf.data(), buf.size());
}

bool SecretBox::open(const std::string& sealed, std::string& out) {
  if (sealed.rfind("v1:", 0) != 0) return false;
  std::vector<uint8_t> buf;
  if (!base64Decode(sealed.substr(3), buf) || buf.size() < kIv + kTag) return false;
  uint8_t key[32];
  deriveKey(key);
  const size_t n = buf.size() - kIv - kTag;
  std::string plain(n, '\0');
  mbedtls_gcm_context gcm;
  mbedtls_gcm_init(&gcm);
  int rc = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, key, 256);
  if (rc == 0)
    rc = mbedtls_gcm_auth_decrypt(&gcm, n, buf.data(), kIv, nullptr, 0, buf.data() + kIv, kTag,
                                  buf.data() + kIv + kTag, reinterpret_cast<uint8_t*>(&plain[0]));
  mbedtls_gcm_free(&gcm);
  memset(key, 0, sizeof key);
  if (rc != 0) return false;
  out = std::move(plain);
  return true;
}

}  // namespace x4::net
