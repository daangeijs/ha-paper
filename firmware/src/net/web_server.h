// HTTP server (ESPAsyncWebServer): device web console SPA from the `www` LittleFS partition (gzipped), captive portal,
// HA sign-in (/link, /auth/start, /auth/callback) and the REST API under /api/v1 (spec/openapi.yaml).
#pragma once

#include "hw/platform.h"

namespace x4::net {

class WebServer {
 public:
  void begin();
};

WebServer& webServer();
void setRemoteInput(Board* board);   // POST /api/v1/debug/input pushes into board->pushInput() (#214)

}  // namespace x4::net
