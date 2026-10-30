#!/usr/bin/env bash
# Task watchdog on a confirmed image with the REAL firmware (env:x4qemu_wdttest) in QEMU:
#   1. fresh flash → the image is not PENDING_VERIFY (no OTA guard armed), first boot logs "reset reason POWERON"
#   2. 20 s after boot loop() hangs (X4_TEST_WDT_HANG): the TWDT hardware is armed (30 s, stage 0 interrupt) with
#      loopTask subscribed, and 31 s later the TWDT's own bookkeeping names loopTask as the task blocking the feed
#      → the image takes the reset the TWDT interrupt takes under QEMU (TASK_WDT hint, software reset)
#   3. the next boot logs "reset reason TASK_WDT" (net/diag.h boot ring), logs the task-watchdog record naming loopTask (eink-ha-os#241),
#      skips the hang and keeps serving the web console
# QEMU's ESP32-S3 timer-group watchdog never counts, so the TWDT interrupt itself cannot fire here (a bare MWDT1 set to
# reset after 3 s did nothing in 8 s; docs/ESP32_EMULATION.md). The timer firing, the ISR and the panic + core dump
# path are hardware-only.
# Usage: sim/qemu/wdt-test.sh [--no-build]   exit 0 = pass. Logs: sim/qemu/.state/wdt/
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PIO="${PIO:-$ROOT/.venv/bin/pio}"
PORT="${SIM_HTTP_PORT:-8080}"
STATE="$HERE/.state/wdt"
LOG="$STATE/qemu.log"
DEV="http://127.0.0.1:$PORT"
VER=0.0.0-qemu-wdt
mkdir -p "$STATE"

if [[ "${1:-}" != "--no-build" ]]; then
  echo "[wdt] building env:x4qemu_wdttest ($VER)"
  (cd "$ROOT/firmware" && X4_FW_VERSION=$VER PLATFORMIO_BUILD_DIR="$STATE/build" "$PIO" run -e x4qemu_wdttest) >"$STATE/build.log" 2>&1 || { tail -30 "$STATE/build.log"; exit 1; }
fi
BUILD="$STATE/build/x4qemu_wdttest"

pkill -9 -f "qemu-system-xtensa.*$STATE/flash.bin" 2>/dev/null || true
if curl -s -m 2 "$DEV/api/v1/console/state" | grep -q '"ip":"10.0.2.15"'; then
  echo "FAIL: another QEMU already serves $DEV — kill it (pgrep -fl qemu-system-xtensa) or set SIM_HTTP_PORT"; exit 1
fi
QEMU_PID=""
cleanup() {
  [[ -n "$QEMU_PID" ]] && kill -9 "$QEMU_PID" 2>/dev/null || true
  pkill -9 -f "qemu-system-xtensa.*$STATE/flash.bin" 2>/dev/null || true
}
trap cleanup EXIT

wait_log() {   # wait_log <seconds> <fixed string> [min count]
  for _ in $(seq "$1"); do [[ $(grep -cF -- "$2" "$LOG") -ge ${3:-1} ]] && return 0; sleep 1; done
  echo "FAIL: timeout waiting for log line: $2"; tail -40 "$LOG"; exit 1
}
up() { curl -sf -m 2 "$DEV/api/v1/console/state" | grep -q '"ip":"10.0.2.15"'; }

: >"$LOG"
SIM_STATE="$STATE" SIM_HTTP_PORT="$PORT" "$HERE/run.sh" --fw "$BUILD" --fresh >>"$LOG" 2>&1 </dev/null &
QEMU_PID=$!

echo "== boot 1: fresh flash, image not pending → no OTA guard"
wait_log 90 "HA Paper $VER"
wait_log 30 "reset reason "
grep -qF "rollback guard armed" "$LOG" && { echo "FAIL: OTA guard armed on a fresh flash (image is pending)"; exit 1; }
for _ in $(seq 60); do up && break; sleep 1; done
up || { echo "FAIL: web console not up"; tail -30 "$LOG"; exit 1; }

echo "== loop() hangs at 20 s → task watchdog after 30 s → reset"
wait_log 60 "X4_TEST_WDT_HANG · loop task hangs now"
t0=$(date +%s)
wait_log 10 "[qemu] TWDT armed: en=1 stage0=1 timeout 30000 ms · loopTask subscribed"
wait_log 60 "[qemu] TWDT after 31 s, not reset:"
grep -F "[qemu] TWDT after 31 s, not reset:" "$LOG" | grep -qF "loopTask" || { echo "FAIL: TWDT does not report loopTask"; tail -20 "$LOG"; exit 1; }
wait_log 10 "[qemu] task watchdog fired"
echo "   reset $(( $(date +%s) - t0 )) s after the hang"

echo "== boot 2: reset reason TASK_WDT, no second hang"
wait_log 90 "HA Paper $VER" 2
wait_log 30 "reset reason TASK_WDT"
for _ in $(seq 60); do up && break; sleep 1; done
up || { echo "FAIL: web console not up after the watchdog reset"; tail -30 "$LOG"; exit 1; }
# eink-ha-os#241: the TWDT interrupt's RTC record names the starved task; the boot after it logs it with the last log line
grep -F "[DIAG] task watchdog at" "$LOG" | grep -qF "loopTask" || { echo "FAIL: no [DIAG] task watchdog line naming loopTask"; exit 1; }
grep -F "reset reason TASK_WDT (hw " "$LOG" | grep -qF "task_wdt: loopTask" || { echo "FAIL: TASK_WDT boot has no task_wdt panic text"; exit 1; }
sleep 40   # past the 20 s hang point plus a full watchdog period
[[ $(grep -cF "HA Paper $VER" "$LOG") == 2 ]] || { echo "FAIL: rebooted again"; tail -30 "$LOG"; exit 1; }
up || { echo "FAIL: web console gone"; exit 1; }
echo "PASS (log: $LOG)"
