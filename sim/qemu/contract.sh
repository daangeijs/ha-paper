#!/usr/bin/env bash
# Contract suite (emulator/server/contract.test.ts) against the REAL firmware (env:x4qemu) in Espressif QEMU.
#   fake HA (npm run fake-ha, :8123 on the host = http://10.0.2.2:8123 for the guest) + fresh flash image + QEMU
#   → DEVICE_URL=http://127.0.0.1:8080 X4_FAKE_HA=… npm run test:contract (the suite signs in through the fake HA:
#     the firmware does the real OAuth2 + PKCE exchange, auth/current_user and subscribe_entities over its WebSocket).
#   The fake HA also listens over https on FAKE_HA_TLS_PORT (default FAKE_HA_PORT+1) with sim/qemu/tls's test CA, which
#   only x4qemu images trust: the suite's address check runs one real TLS handshake on the device (#79).
#   CONTRACT_HA_TLS=1: the device links to that https address instead, so sign-in, WebSocket and the HA-dependent tests
#   run over TLS, plus a TLS reset + hung-handshake relink test (#87). The suite keeps controlling the fake HA over http.
# Usage: sim/qemu/contract.sh [--no-build]     exit code = vitest's. Logs: sim/qemu/.state/contract{,-tls}/{qemu,fake-ha}.log
# X4_QEMU_ENV=x4qemu_debug: run the suite against the debug image (heap/spinlock checks, docs/ESP32_EMULATION.md).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PIO="${PIO:-$ROOT/.venv/bin/pio}"
PORT="${SIM_HTTP_PORT:-8080}"
HA_PORT="${FAKE_HA_PORT:-8123}"
HOUSE="${FAKE_HA_HOUSE:-demo}"   # fake HA house; not demo = only the first sign-in + seed check makes sense (#82):
# FAKE_HA_HOUSE=dutch X4_VITEST_ARGS="-t status" sim/qemu/contract.sh
read -ra VITEST_ARGS <<< "${X4_VITEST_ARGS:-}"
HA_TLS_PORT="${FAKE_HA_TLS_PORT:-$((HA_PORT + 1))}"   # the same fake HA over https (sim/qemu/tls test CA, #79)
STATE="$HERE/.state/contract"
HA_DEV="http://10.0.2.2:$HA_PORT"
if [[ "${CONTRACT_HA_TLS:-0}" == 1 ]]; then STATE="$HERE/.state/contract-tls"; HA_DEV="https://10.0.2.2:$HA_TLS_PORT"; fi
ENV="${X4_QEMU_ENV:-x4qemu}"
# own PlatformIO build dir (shared with the -tls run): a `pio run` in firmware/ can't swap the image under the suite (#118)
BUILD_ROOT="$HERE/.state/contract/build"
BUILD="$BUILD_ROOT/$ENV"
mkdir -p "$STATE"
export X4_FW_VERSION="${X4_FW_VERSION:-0.0.0-qemu}"

if [[ "${1:-}" != "--no-build" ]]; then
  (cd "$ROOT/firmware" && export PLATFORMIO_BUILD_DIR="$BUILD_ROOT" && "$PIO" run -e "$ENV" && "$PIO" run -e "$ENV" -t buildfs) >"$STATE/build.log" 2>&1 \
    || { tail -30 "$STATE/build.log"; exit 1; }
fi
[[ -f "$BUILD/firmware.bin" ]] || { echo "no image in $BUILD: run once without --no-build"; exit 1; }
(cd "$ROOT/emulator" && [ -d node_modules ] || npm ci >/dev/null)

pkill -f "qemu-system-xtensa.*$STATE/flash.bin" 2>/dev/null || true
if curl -s -m 2 "http://127.0.0.1:$PORT/api/v1/console/state" | grep -q '"ip":"10.0.2.15"'; then
  echo "FAIL: another QEMU already serves :$PORT, the suite would test that one — kill it (pgrep -fl qemu-system-xtensa) or set SIM_HTTP_PORT"; exit 1
fi

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; pkill -f "qemu-system-xtensa.*$STATE/flash.bin" 2>/dev/null || true; }
trap cleanup EXIT

(cd "$ROOT/emulator" && exec node server/fake-ha-main.ts --port "$HA_PORT" --tls-port "$HA_TLS_PORT" --host 127.0.0.1 --tick 0 --house "$HOUSE") >"$STATE/fake-ha.log" 2>&1 &
pids+=($!)
SIM_STATE="$STATE" SIM_HTTP_PORT="$PORT" "$HERE/run.sh" --fw "$BUILD" --fresh >"$STATE/qemu.log" 2>&1 </dev/null &
pids+=($!)

echo "[contract] waiting for the firmware web server (QEMU boot ~10 s)…"
for i in $(seq 120); do
  curl -sf -m 2 "http://127.0.0.1:$PORT/api/v1/console/state" | grep -q '"ip":"10.0.2.15"' && break
  [[ $i == 120 ]] && { echo "firmware did not come up"; tail -40 "$STATE/qemu.log"; exit 1; }
  sleep 1
done
# token last_used / created are local time strings: empty until SNTP (over slirp) has set the clock
for i in $(seq 60); do
  t=$(curl -s -m 2 "http://127.0.0.1:$PORT/__qemu/state" | sed -nE 's/.*"time":([0-9]+).*/\1/p')
  [[ -n "$t" && "$t" -gt 1700000000 ]] && break
  [[ $i == 60 ]] && echo "[contract] warning: guest clock not set by SNTP (no Internet?) — token time stamps stay empty"
  sleep 1
done
echo "[contract] firmware up; running the contract suite (device → HA: $HA_DEV)"
set +e
(cd "$ROOT/emulator" && DEVICE_URL="http://127.0.0.1:$PORT" X4_FAKE_HA="http://127.0.0.1:$HA_PORT" X4_FAKE_HA_DEVICE="$HA_DEV" \
  X4_FAKE_HA_DEVICE_TLS="https://10.0.2.2:$HA_TLS_PORT" \
  npx vitest run server/contract.test.ts "${VITEST_ARGS[@]+"${VITEST_ARGS[@]}"}")
rc=$?
set -e
[[ $rc == 0 ]] || { echo "--- qemu.log (tail)"; tail -60 "$STATE/qemu.log"; }
exit $rc
