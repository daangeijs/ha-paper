#!/usr/bin/env bash
# OTA + rollback with the REAL firmware (env:x4qemu) in QEMU — the same code path as a display on the LAN:
#   1. v1 boots, links to the fake HA (OAuth2 + PKCE through the firmware), API token
#   2. fake HA stopped (updates must not depend on HA); POST /api/v1/ota/upload v2 (multipart firmware + manifest)
#      → reboot → PENDING_VERIFY → 60 s running with network → VALID
#   3. wrong SHA-256 → 422, nothing changed
#   4. upload a broken image (env:x4qemu_crashtest, raw body + ?sha256=): esp_restart() while PENDING_VERIFY
#      → the bootloader marks it ABORTED and boots v2 again
#   5. upload a hung image (env:x4qemu_hangtest): network up, loop() never runs → not confirmed → the OTA guard
#      restarts it after 30 s → bootloader rollback to v2
# Steps 4 and 5 power-cycle QEMU first: QEMU keeps translated code for a flash address across soft resets, so an image
# written over a slot that already ran in the same QEMU process executes stale code (docs/ESP32_EMULATION.md §5).
# Usage: sim/qemu/ota-fw-test.sh [--no-build]   exit 0 = pass. Logs: sim/qemu/.state/ota-fw/
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PIO="${PIO:-$ROOT/.venv/bin/pio}"
PORT="${SIM_HTTP_PORT:-8080}"
HA_PORT="${FAKE_HA_PORT:-8123}"
STATE="$HERE/.state/ota-fw"
LOG="$STATE/qemu.log"
DEV="http://127.0.0.1:$PORT"
V1=0.0.0-qemu V2=0.0.1-qemu V3=0.0.2-qemu-crash V4=0.0.3-qemu-hang
mkdir -p "$STATE"

if [[ "${1:-}" != "--no-build" ]]; then
  echo "[ota] building v1 ($V1), v2 ($V2), crash ($V3), hang ($V4)"
  # each version in its own build dir: a build with different flags makes PlatformIO wipe the others
  (cd "$ROOT/firmware" && export X4_FW_VERSION=$V1 PLATFORMIO_BUILD_DIR="$STATE/build-v1" && "$PIO" run -e x4qemu && "$PIO" run -e x4qemu -t buildfs) >"$STATE/build.log" 2>&1 || { tail -30 "$STATE/build.log"; exit 1; }
  (cd "$ROOT/firmware" && X4_FW_VERSION=$V2 PLATFORMIO_BUILD_DIR="$STATE/build-v2" "$PIO" run -e x4qemu) >>"$STATE/build.log" 2>&1 || { tail -30 "$STATE/build.log"; exit 1; }
  (cd "$ROOT/firmware" && X4_FW_VERSION=$V3 PLATFORMIO_BUILD_DIR="$STATE/build-v3" "$PIO" run -e x4qemu_crashtest) >>"$STATE/build.log" 2>&1 || { tail -30 "$STATE/build.log"; exit 1; }
  (cd "$ROOT/firmware" && X4_FW_VERSION=$V4 PLATFORMIO_BUILD_DIR="$STATE/build-v4" "$PIO" run -e x4qemu_hangtest) >>"$STATE/build.log" 2>&1 || { tail -30 "$STATE/build.log"; exit 1; }
fi
B1="$STATE/build-v1/x4qemu"; B2="$STATE/build-v2/x4qemu"; B3="$STATE/build-v3/x4qemu_crashtest"; B4="$STATE/build-v4/x4qemu_hangtest"
if command -v sha256sum >/dev/null 2>&1; then SHA256=(sha256sum); else SHA256=(shasum -a 256); fi   # Linux / macOS
sha() { "${SHA256[@]}" "$1" | cut -d' ' -f1; }

# A QEMU left over from an aborted run (or `make qemu`) would hold 127.0.0.1:$PORT with another flash image.
pkill -9 -f "qemu-system-xtensa.*$STATE/flash.bin" 2>/dev/null || true
if curl -s -m 2 "$DEV/api/v1/console/state" | grep -q '"ip":"10.0.2.15"'; then
  echo "FAIL: another QEMU already serves $DEV — kill it (pgrep -fl qemu-system-xtensa) or set SIM_HTTP_PORT"; exit 1
fi

pids=() QEMU_PID=""
cleanup() {
  for p in "${pids[@]}" $QEMU_PID; do kill -9 "$p" 2>/dev/null || true; done
  pkill -9 -f "qemu-system-xtensa.*$STATE/flash.bin" 2>/dev/null || true
}
trap cleanup EXIT
start_ha() { (cd "$ROOT/emulator" && exec node server/fake-ha-main.ts --port "$HA_PORT" --host 127.0.0.1 --tick 0) >>"$STATE/fake-ha.log" 2>&1 & HA_PID=$!; pids+=($HA_PID); sleep 1; }
# run.sh execs QEMU, so $! is the QEMU pid
start_qemu() { SIM_STATE="$STATE" SIM_HTTP_PORT="$PORT" "$HERE/run.sh" --fw "$B1" "$@" >>"$LOG" 2>&1 </dev/null & QEMU_PID=$!; }
wait_boot() {
  for i in $(seq 90); do curl -sf -m 2 "$DEV/api/v1/console/state" | grep -q '"ip":"10.0.2.15"' && return 0; sleep 1; done
  echo "FAIL: no boot"; tail -30 "$LOG"; exit 1
}
power_cycle() {   # kill QEMU and boot the same flash image again (like pulling the battery)
  kill -9 "$QEMU_PID" 2>/dev/null || true; wait "$QEMU_PID" 2>/dev/null || true
  echo "--- power cycle ---" >>"$LOG"
  start_qemu --no-refresh; wait_boot
}

status() { curl -s -m 3 -H "Authorization: Bearer $TOKEN" "$DEV/api/v1/status" || true; }
wait_for() {   # wait_for <seconds> <grep -E pattern on GET /status>
  for _ in $(seq "$1"); do status | grep -Eq "$2" && return 0; sleep 1; done
  echo "FAIL: timeout waiting for /status ~ $2 (last: $(status))"; tail -30 "$LOG"; exit 1
}
MARK=0
mark() { MARK=$(wc -l <"$LOG"); }                        # log checks below only look at lines after the mark
newlog() { tail -n +$((MARK + 1)) "$LOG"; }
wait_log() {   # wait_log <seconds> <fixed string> [min count]
  for _ in $(seq "$1"); do [[ $(newlog | grep -cF -- "$2") -ge ${3:-1} ]] && return 0; sleep 1; done
  echo "FAIL: timeout waiting for log line: $2"; newlog | tail -30; exit 1
}
upload_raw() {   # upload_raw <firmware.bin> → expects "rebooting"
  local r
  r=$(curl -s -m 300 --limit-rate 300k -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/octet-stream' --data-binary "@$1" "$DEV/api/v1/ota/upload?sha256=$(sha "$1")")
  echo "   $r"; [[ "$r" == *'"status":"rebooting"'* ]] || { echo "FAIL: upload $1"; exit 1; }
}
expect_rollback() {   # expect_rollback <version of the broken image> <its failure log line>
  wait_log 120 "HA Paper $1"
  wait_log 30 "running v$1 from app0 · ESP_OTA_IMG_PENDING_VERIFY"
  wait_log 90 "$2"
  wait_log 60 "HA Paper $V2"
  wait_for 60 "\"firmware\":\"$V2\""
  sleep 2
  [[ $(newlog | grep -cF "HA Paper $1") == 1 ]] || { echo "FAIL: $1 booted again (no rollback)"; exit 1; }
  ! newlog | grep -qF "running v$V2 from app1 · ESP_OTA_IMG_PENDING_VERIFY" || { echo "FAIL: v2 not VALID after rollback"; exit 1; }
}

: >"$LOG"
start_ha
start_qemu --fresh
wait_boot

echo "== v1 up · sign in through the fake HA (links the display) + API token"
SESSION=$(cd "$ROOT/emulator" && node scripts/device-signin.ts "$DEV" "http://127.0.0.1:$HA_PORT" "http://10.0.2.2:$HA_PORT")
TOKEN=$(curl -s -X POST -b "x4_session=$SESSION" -H "Origin: $DEV" -H 'Content-Type: application/json' -d '{"name":"ota-test","scope":"write"}' "$DEV/api/v1/tokens" | sed -E 's/.*"token":"([^"]+)".*/\1/')
[[ -n "$TOKEN" && "$TOKEN" != *"{"* ]] || { echo "FAIL: POST /tokens: $TOKEN"; exit 1; }
wait_for 60 "\"firmware\":\"$V1\".*\"home_assistant\":\"linked\""

echo "== HA down · upload v2 (multipart firmware + manifest) → reboot → 60 s with network → marked valid"
kill "$HA_PID"; sleep 1
printf '{"version":"%s","sha256":"%s","size":%s,"notes":[]}' "$V2" "$(sha "$B2/firmware.bin")" "$(wc -c <"$B2/firmware.bin" | tr -d ' ')" >"$STATE/manifest.json"
mark
r=$(curl -s -m 300 --limit-rate 300k -H "Authorization: Bearer $TOKEN" -F "firmware=@$B2/firmware.bin" -F "manifest=@$STATE/manifest.json" "$DEV/api/v1/ota/upload")
echo "   $r"; [[ "$r" == *'"status":"rebooting"'* ]] || { echo "FAIL: upload v2"; exit 1; }
wait_for 120 "\"firmware\":\"$V2\""
wait_log 10 "running v$V2 from app1 · ESP_OTA_IMG_PENDING_VERIFY"
wait_log 120 "health check passed (running 60 s with network)"

echo "== wrong SHA-256 → 422, nothing changed"
code=$(curl -s --limit-rate 300k -o "$STATE/bad.json" -w '%{http_code}' -m 300 -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/octet-stream' \
  --data-binary "@$B1/firmware.bin" "$DEV/api/v1/ota/upload?sha256=$(printf 'f%.0s' $(seq 64))")
[[ $code == 422 ]] || { echo "FAIL: expected 422, got $code $(cat "$STATE/bad.json")"; exit 1; }
wait_for 10 "\"firmware\":\"$V2\""

echo "== power cycle · upload an image that resets before confirming → bootloader rolls back to v2"
power_cycle
mark
upload_raw "$B3/firmware.bin"
expect_rollback "$V3" "X4_TEST_CRASH_ON_BOOT"

echo "== power cycle · upload an image that hangs (network up, no UI) → guard restarts after 30 s → rollback to v2"
power_cycle
mark
upload_raw "$B4/firmware.bin"
expect_rollback "$V4" "new image not confirmed after 30 s"
newlog | grep -qF "health check passed" && { echo "FAIL: hung image was confirmed"; exit 1; }
echo "PASS (log: $LOG)"
