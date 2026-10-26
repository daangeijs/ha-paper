// QEMU smoke test: exercises the platform pieces the X4 firmware depends on
// (boot, PSRAM, NVS, LittleFS, OTA + rollback, Ethernet/lwIP, HTTP server, outbound TCP)
// on Espressif QEMU `-machine esp32s3`. Display/touch/Wi-Fi are NOT emulated.
#include <Arduino.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <Update.h>
#include <WebServer.h>
#ifdef SIM_WIFI_PROBE
#include <WiFi.h>
#endif

#include "esp_chip_info.h"
#include "esp_ota_ops.h"
#include "qemu_eth.h"

#ifndef SIM_VERSION
#define SIM_VERSION "qemu-smoke-1"
#endif

static WebServer server(80);
static Preferences prefs;
static uint32_t bootCount;
static bool otaOk;

// Arduino auto-marks a PENDING_VERIFY image valid before setup() unless this returns true.
// The real firmware should do the same and confirm only after its own self-test.
extern "C" bool verifyRollbackLater() { return true; }

static const char *otaStateName(esp_ota_img_states_t s) {
  switch (s) {
    case ESP_OTA_IMG_NEW: return "NEW";
    case ESP_OTA_IMG_PENDING_VERIFY: return "PENDING_VERIFY";
    case ESP_OTA_IMG_VALID: return "VALID";
    case ESP_OTA_IMG_INVALID: return "INVALID";
    case ESP_OTA_IMG_ABORTED: return "ABORTED";
    default: return "UNDEFINED";
  }
}

static void checkOta() {
  const esp_partition_t *run = esp_ota_get_running_partition();
  esp_ota_img_states_t st = ESP_OTA_IMG_UNDEFINED;
  esp_ota_get_state_partition(run, &st);
  Serial.printf("[ota] running=%s @0x%06lx state=%s version=%s\n", run->label, (unsigned long)run->address,
                otaStateName(st), SIM_VERSION);
  if (st == ESP_OTA_IMG_PENDING_VERIFY) {
    if (prefs.getBool("fail_next", false)) {
      prefs.putBool("fail_next", false);
      Serial.println("[ota] self-test FAILED (simulated) -> esp_ota_mark_app_invalid_rollback_and_reboot()");
      Serial.flush();
      esp_ota_mark_app_invalid_rollback_and_reboot();
    }
    esp_ota_mark_app_valid_cancel_rollback();
    Serial.println("[ota] self-test passed -> marked VALID");
  }
}

static void checkPsram() {
  size_t sz = ESP.getPsramSize();
  Serial.printf("[psram] size=%u free=%u\n", (unsigned)sz, (unsigned)ESP.getFreePsram());
  if (!sz) return;
  const size_t n = 1024 * 1024;
  uint8_t *p = (uint8_t *)ps_malloc(n);
  if (!p) { Serial.println("[psram] ps_malloc FAILED"); return; }
  for (size_t i = 0; i < n; i++) p[i] = (uint8_t)(i * 31);
  size_t bad = 0;
  for (size_t i = 0; i < n; i++) bad += p[i] != (uint8_t)(i * 31);
  Serial.printf("[psram] 1MiB pattern test %s\n", bad ? "FAILED" : "ok");
  free(p);
}

static void checkLittleFs() {
  if (!LittleFS.begin(true, "/littlefs", 10, "userdata")) { Serial.println("[fs] mount FAILED"); return; }
  File f = LittleFS.open("/boots.txt", "a");
  f.printf("boot %lu\n", (unsigned long)bootCount);
  f.close();
  f = LittleFS.open("/boots.txt", "r");
  Serial.printf("[fs] LittleFS total=%u used=%u boots.txt=%u bytes\n", (unsigned)LittleFS.totalBytes(),
                (unsigned)LittleFS.usedBytes(), (unsigned)f.size());
  f.close();
}

static void handleStatus() {
  const esp_partition_t *run = esp_ota_get_running_partition();
  esp_ota_img_states_t st = ESP_OTA_IMG_UNDEFINED;
  esp_ota_get_state_partition(run, &st);
  char buf[320];
  snprintf(buf, sizeof buf,
           "{\"version\":\"%s\",\"boot_count\":%lu,\"partition\":\"%s\",\"ota_state\":\"%s\","
           "\"heap_free\":%u,\"psram\":%u,\"uptime_ms\":%lu}",
           SIM_VERSION, (unsigned long)bootCount, run->label, otaStateName(st), (unsigned)ESP.getFreeHeap(),
           (unsigned)ESP.getPsramSize(), (unsigned long)millis());
  server.send(200, "application/json", buf);
}

// curl -F firmware=@firmware.bin 'http://localhost:8080/api/ota[?fail=1]'
static void handleOtaDone() {
  if (server.hasArg("fail")) prefs.putBool("fail_next", true);
  server.send(otaOk ? 200 : 500, "text/plain", otaOk ? "OK, rebooting\n" : (String(Update.errorString()) + "\n"));
  if (otaOk) { delay(200); ESP.restart(); }
}

static void handleOtaUpload() {
  HTTPUpload &up = server.upload();
  if (up.status == UPLOAD_FILE_START) {
    Serial.printf("[ota] upload start %s\n", up.filename.c_str());
    otaOk = Update.begin(UPDATE_SIZE_UNKNOWN);
  } else if (up.status == UPLOAD_FILE_WRITE) {
    if (otaOk && Update.write(up.buf, up.currentSize) != up.currentSize) otaOk = false;
  } else if (up.status == UPLOAD_FILE_END) {
    otaOk = otaOk && Update.end(true);
    Serial.printf("[ota] upload end %u bytes -> %s\n", (unsigned)up.totalSize, otaOk ? "ok" : Update.errorString());
  }
}

static void outboundProbe() {
  // 10.0.2.2 = the macOS host under QEMU slirp; run e.g. `python3 -m http.server 8123` to see a 200.
  HTTPClient http;
  http.setConnectTimeout(2000);
  http.begin("http://10.0.2.2:8123/");
  int code = http.GET();
  Serial.printf("[net] outbound GET http://10.0.2.2:8123/ -> %d\n", code);
  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(50);
  esp_chip_info_t ci;
  esp_chip_info(&ci);
  Serial.printf("\n[boot] X4 QEMU smoke %s | %s rev%d cores=%d | reset=%d | flash=%luMB | IDF %s\n", SIM_VERSION,
                ESP.getChipModel(), ci.revision, ci.cores, (int)esp_reset_reason(),
                (unsigned long)(ESP.getFlashChipSize() >> 20), esp_get_idf_version());

  prefs.begin("sim", false);
  bootCount = prefs.getUInt("boots", 0) + 1;
  prefs.putUInt("boots", bootCount);
  Serial.printf("[nvs] boot_count=%lu (persisted in NVS)\n", (unsigned long)bootCount);

  checkOta();
  checkPsram();
  checkLittleFs();

#ifdef SIM_WIFI_PROBE
  // Documents what the real firmware's Wi-Fi path does under QEMU (Wi-Fi is not emulated).
  Serial.println("[wifi] probe: WiFi.mode(WIFI_STA) ...");
  bool ok = WiFi.mode(WIFI_STA);
  Serial.printf("[wifi] mode -> %d, begin...\n", ok);
  WiFi.begin("probe", "probe-password");
  delay(3000);
  Serial.printf("[wifi] status after 3s = %d\n", (int)WiFi.status());
#endif
  if (!qemu_eth_start()) { Serial.println("[net] open_eth start FAILED"); return; }
  uint32_t ip = qemu_eth_wait_ip(10000);
  Serial.printf("[net] ip=%s\n", ip ? IPAddress(ip).toString().c_str() : "none (DHCP timeout)");
  if (!ip) return;

  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/ota", HTTP_POST, handleOtaDone, handleOtaUpload);
  server.begin();
  Serial.println("[http] listening on :80 (host: http://127.0.0.1:8080)");
  outboundProbe();
}

void loop() {
  server.handleClient();
  delay(2);
}
