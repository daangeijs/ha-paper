#!/usr/bin/env bash
# End-to-end check under QEMU: REST API, outbound TCP to host, OTA upload, rollback, re-OTA.
# Usage: sim/qemu/ota-test.sh   (exit 0 = pass). Log: sim/qemu/.state/ota-test.log
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PIO="${PIO:-$ROOT/.venv/bin/pio}"
PORT="${SIM_HTTP_PORT:-8080}"
STATE="$HERE/.state"; mkdir -p "$STATE"
LOG="$STATE/ota-test.log"
API="http://127.0.0.1:$PORT/api"

(cd "$HERE" && "$PIO" run -e qemu >/dev/null)
(cd "$HERE" && PLATFORMIO_BUILD_DIR="$STATE/build-v2" PLATFORMIO_BUILD_FLAGS='-DSIM_VERSION=\"qemu-smoke-2\"' "$PIO" run -e qemu >/dev/null)
V2="$STATE/build-v2/qemu/firmware.bin"

python3 -m http.server 8123 --bind 127.0.0.1 >/dev/null 2>&1 & HTTPD=$!
SIM_TIMEOUT=240 "$HERE/run.sh" --fresh >"$LOG" 2>&1 </dev/null & SIM=$!
trap 'kill $HTTPD $SIM 2>/dev/null; pkill -f "qemu-system-xtensa.*$STATE/flash.bin" 2>/dev/null || true' EXIT

wait_for() { for _ in $(seq 60); do s=$(curl -s -m 2 "$API/status" || true); [[ "$s" == *"$1"* ]] && { echo "$s"; return 0; }; sleep 1; done; echo "timeout waiting for $1" >&2; return 1; }
check() { echo "== $1"; }

check "boot + REST";            wait_for '"partition":"app0"'
check "OTA v2, failing self-test -> rollback to app0"
curl -sf -m 120 -F "firmware=@$V2" "$API/ota?fail=1"; sleep 3
wait_for '"version":"qemu-smoke-1"'
grep -q "self-test FAILED" "$LOG"
check "OTA v2, healthy -> app1 VALID"
curl -sf -m 120 -F "firmware=@$V2" "$API/ota"; sleep 3
wait_for '"ota_state":"VALID"' | grep -q qemu-smoke-2
grep -q "outbound GET http://10.0.2.2:8123/ -> 200" "$LOG"
echo "PASS (log: $LOG)"
