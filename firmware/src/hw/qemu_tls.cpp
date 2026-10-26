// x4qemu only: TLS also trusts the test CA of sim/qemu/tls (#79), so the contract suite's https fake HA at
// https://10.0.2.2 runs a real handshake, certificate check included. `-Wl,--wrap=esp_crt_bundle_attach`
// (platformio.ini) routes NetworkClientSecure's bundle attach here: the IDF bundle as usual, then a verify callback
// that accepts a certificate signed by the test CA and hands everything else to the bundle's own callback.
#if X4_QEMU
#include <esp_crt_bundle.h>
#include <mbedtls/ssl.h>
#include <mbedtls/x509_crt.h>

#include <cstring>

#include "hw/qemu_test_ca.h"

extern "C" esp_err_t __real_esp_crt_bundle_attach(void* conf);

namespace {

using VerifyFn = int (*)(void*, mbedtls_x509_crt*, int, uint32_t*);
VerifyFn g_bundleVerify = nullptr;   // the same static IDF callback for every connection

mbedtls_x509_crt* testCa() {
  static mbedtls_x509_crt ca;
  static bool parsed = false;
  if (!parsed) {
    mbedtls_x509_crt_init(&ca);
    if (mbedtls_x509_crt_parse(&ca, reinterpret_cast<const unsigned char*>(kQemuTestCa), sizeof kQemuTestCa) != 0)
      return nullptr;
    parsed = true;
  }
  return &ca;
}

int verify(void* ctx, mbedtls_x509_crt* crt, int depth, uint32_t* flags) {
  if (*flags & MBEDTLS_X509_BADCERT_NOT_TRUSTED) {
    mbedtls_x509_crt* ca = testCa();
    uint32_t f = 0;
    if (ca && mbedtls_x509_crt_verify(crt, ca, nullptr, nullptr, &f, nullptr, nullptr) == 0) {
      *flags &= ~uint32_t(MBEDTLS_X509_BADCERT_NOT_TRUSTED);   // name and dates were checked by mbedTLS already
      return 0;
    }
  }
  return g_bundleVerify ? g_bundleVerify(ctx, crt, depth, flags) : 0;
}

}  // namespace

extern "C" esp_err_t __wrap_esp_crt_bundle_attach(void* conf) {
  esp_err_t err = __real_esp_crt_bundle_attach(conf);
  if (err != ESP_OK) return err;
  auto* c = static_cast<mbedtls_ssl_config*>(conf);
  g_bundleVerify = c->MBEDTLS_PRIVATE(f_vrfy);
  mbedtls_ssl_conf_verify(c, verify, c->MBEDTLS_PRIVATE(p_vrfy));
  return ESP_OK;
}
#endif
