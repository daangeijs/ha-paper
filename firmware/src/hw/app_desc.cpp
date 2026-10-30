// Our esp_app_desc_t (eink-ha-os#242). The Arduino core's libesp_app_format.a defines `esp_app_desc` weak with its own
// project/version ("arduino-lib-builder", "ee57070"); this strong definition replaces it, so the bootloader log,
// esp_app_get_description() and the browser flasher (flasher/src/firmwareInfo.ts) see "ha-paper" + X4_FW_VERSION.
// app_elf_sha256 stays zero here: esptool elf2image fills it in (--elf-sha256-offset 0xb0).

#include <esp_app_desc.h>
#include <sdkconfig.h>

#ifndef X4_FW_VERSION
#define X4_FW_VERSION ""
#endif

namespace {

constexpr void copyStr(char* dst, size_t n, const char* src) {
  for (size_t i = 0; i + 1 < n && src[i] != '\0'; i++) dst[i] = src[i];
}

constexpr size_t len(const char* s) {
  size_t n = 0;
  while (s[n] != '\0') n++;
  return n;
}

constexpr uint8_t log2u(uint32_t v) {
  uint8_t r = 0;
  while (v > 1) { v >>= 1; r++; }
  return r;
}

static_assert(len(X4_FW_VERSION) < 32, "X4_FW_VERSION must fit esp_app_desc_t.version[32]");

// time/date stay empty (CONFIG_APP_COMPILE_TIME_DATE off behaviour): the same source gives the same image.
constexpr esp_app_desc_t makeDesc() {
  esp_app_desc_t d{};
  d.magic_word = ESP_APP_DESC_MAGIC_WORD;
  copyStr(d.version, sizeof d.version, X4_FW_VERSION[0] != '\0' ? X4_FW_VERSION : "0.0.0-dev");
  copyStr(d.project_name, sizeof d.project_name, "ha-paper");
  copyStr(d.idf_ver, sizeof d.idf_ver, IDF_VER);
  d.min_efuse_blk_rev_full = CONFIG_ESP_EFUSE_BLOCK_REV_MIN_FULL;
  d.max_efuse_blk_rev_full = CONFIG_ESP_EFUSE_BLOCK_REV_MAX_FULL;
  d.mmu_page_size = log2u(CONFIG_MMU_PAGE_SIZE);
  return d;
}

}  // namespace

extern "C" __attribute__((section(".rodata_desc"), used)) const esp_app_desc_t esp_app_desc = makeDesc();
