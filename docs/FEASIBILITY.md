# Feasibility (researched 2026-10-13)

Hardware: X4 Pro = ESP32-S3, 16 MB flash, 8 MB PSRAM, SSD1677 800x480, GT911 touch, front light
(source: CrossPoint reader `platformio.ini` `[env:x4pro]`). Base X4 = ESP32-C3, no touch, no front light — not targeted.

| Feature | Verdict | Approach |
|---|---|---|
| Web server + REST API + SPA | Feasible | ESPAsyncWebServer, gzipped SPA from LittleFS, mDNS `ha-paper-XXXX.local` |
| SoftAP + captive portal | Feasible | DNSServer wildcard, probe URLs 302 → /setup |
| HA sign-in from device | Feasible | OAuth2 auth-code + PKCE; client_id/redirect_uri built from browser `Host` header (same host ⇒ HA fetches nothing). Refresh token: 90 days idle expiry, renewed on use. Admin check via WS `auth/current_user`. Long-lived token paste as fallback. |
| HA live data | Feasible | WebSocket `subscribe_entities` filtered; ws:// on LAN, wss:// fine on S3 (PSRAM) |
| OTA from GitHub Releases | Feasible | HTTPClient + cert bundle, stream to Update, SHA-256 vs manifest; rollback via `verifyRollbackLater()` + `esp_ota_mark_app_valid_cancel_rollback()` after HA connects |
| OTA via web upload | Feasible | `POST /api/v1/ota/upload`, rw token |
| Encrypted NVS | Caveat | Not in precompiled Arduino core; app-level AES-GCM of secrets with key derived from eFuse/chip id, or custom sdkconfig |

Deviations from the original handoff ARCHITECTURE.md (removed; commit c7393ae): client_id may be the IP (HA only string-compares client_id on refresh); use Host header.
