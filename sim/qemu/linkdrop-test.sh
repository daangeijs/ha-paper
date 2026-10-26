#!/usr/bin/env bash
# Link drops (#108) with the REAL firmware (env:x4qemu) in QEMU: CYCLES times `set_link <nic> off` for OFF_MIN..OFF_MAX
# s, then on. Every cycle must end, within RECOVER_S, with the guest having seen the link go down and come back
# (GET /__qemu/state eth.link_downs/link_ups +1), a fresh DHCP lease and home_assistant "linked". Each monitor command
# is checked against the monitor's own reply, so a lost `set_link on` shows up as a harness failure, not a device one.
# (72 h endurance run, 2026-10-16: the 5th drop never recovered; the driver's RX ring was out of step with QEMU's.)
# Usage: sim/qemu/linkdrop-test.sh [--no-build]   env: CYCLES (20) OFF_MIN (20) OFF_MAX (90) RECOVER_S (180)
#   SIM_HTTP_PORT FAKE_HA_PORT SIM_MON_PORT (SIM_HTTP_PORT+1000). exit 0 = all cycles recovered. Logs: .state/linkdrop/
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PIO="${PIO:-$ROOT/.venv/bin/pio}"
PORT="${SIM_HTTP_PORT:-8080}"
HA_PORT="${FAKE_HA_PORT:-8123}"
MON_PORT="${SIM_MON_PORT:-$((PORT + 1000))}"
CYCLES="${CYCLES:-20}" OFF_MIN="${OFF_MIN:-20}" OFF_MAX="${OFF_MAX:-90}" RECOVER_S="${RECOVER_S:-180}"
STATE="$HERE/.state/linkdrop"
LOG="$STATE/qemu.log"
BUILD="${X4_QEMU_BUILD:-$STATE/build/x4qemu}"   # own build dir (#118); another image: X4_QEMU_BUILD=<dir> --no-build
DEV="http://127.0.0.1:$PORT"
HA="http://127.0.0.1:$HA_PORT"
export X4_FW_VERSION="${X4_FW_VERSION:-0.0.0-qemu}"
mkdir -p "$STATE"

if [[ "${1:-}" != "--no-build" ]]; then
  (cd "$ROOT/firmware" && export PLATFORMIO_BUILD_DIR="$STATE/build" && "$PIO" run -e x4qemu && "$PIO" run -e x4qemu -t buildfs) >"$STATE/build.log" 2>&1 \
    || { tail -30 "$STATE/build.log"; exit 1; }
fi
(cd "$ROOT/emulator" && [ -d node_modules ] || npm ci >/dev/null)

pkill -9 -f "qemu-system-xtensa.*$STATE/flash.bin" 2>/dev/null || true
if curl -s -m 2 "$DEV/api/v1/console/state" | grep -q '"ip":"10.0.2.15"'; then
  echo "FAIL: another QEMU already serves $DEV — kill it (pgrep -fl qemu-system-xtensa) or set SIM_HTTP_PORT"; exit 1
fi
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; pkill -9 -f "qemu-system-xtensa.*$STATE/flash.bin" 2>/dev/null || true; }
trap cleanup EXIT
: >"$LOG"; : >"$STATE/fake-ha.log"

(cd "$ROOT/emulator" && exec node server/fake-ha-main.ts --port "$HA_PORT" --host 127.0.0.1 --tick 5000) >>"$STATE/fake-ha.log" 2>&1 &
pids+=($!)
SIM_STATE="$STATE" SIM_HTTP_PORT="$PORT" SIM_QEMU_ARGS="-monitor tcp:127.0.0.1:$MON_PORT,server,nowait" \
  "$HERE/run.sh" --fw "$BUILD" --fresh >>"$LOG" 2>&1 </dev/null &
pids+=($!)
for i in $(seq 120); do
  curl -sf -m 2 "$DEV/api/v1/console/state" | grep -q '"ip":"10.0.2.15"' && break
  [[ $i == 120 ]] && { echo "FAIL: firmware did not come up"; tail -40 "$LOG"; exit 1; }
  sleep 1
done

# mon <command>: the monitor's reply. HMP greets with "(qemu)"; no greeting = the command never reached the monitor.
mon() { printf '%s\n' "$1" | nc -w 2 127.0.0.1 "$MON_PORT" 2>/dev/null | tr -d '\r' || true; }
monitor_ok() {   # monitor_ok <command>: up to 5 tries, each must be greeted and must not answer with an error
  local out try
  for try in 1 2 3 4 5; do
    out=$(mon "$1")
    if [[ "$out" == *"(qemu)"* && "$out" != *"not found"* && "$out" != *"rror"* ]]; then return 0; fi
    echo "[linkdrop] monitor \"$1\" try $try: $(tail -c 120 <<<"$out" | tr '\n' ' ')"
    sleep 2
  done
  return 1
}
NIC=$(mon "info network" | sed -nE 's/^[^a-z_]*([A-Za-z0-9_.#-]+): index=[0-9]+,type=nic,model=open_eth.*/\1/p' | head -1)
[[ -n "$NIC" ]] || { echo "FAIL: no open_eth NIC on the QEMU monitor (:$MON_PORT)"; exit 1; }

SESSION=$(cd "$ROOT/emulator" && node scripts/device-signin.ts "$DEV" "$HA" "http://10.0.2.2:$HA_PORT")
TOKEN=$(curl -s -X POST -b "x4_session=$SESSION" -H "Origin: $DEV" -H 'Content-Type: application/json' \
  -d '{"name":"linkdrop","scope":"write"}' "$DEV/api/v1/tokens" | sed -E 's/.*"token":"([^"]+)".*/\1/')
[[ -n "$TOKEN" && "$TOKEN" != *"{"* ]] || { echo "FAIL: POST /tokens"; exit 1; }
linked() { curl -s -m 5 -H "Authorization: Bearer $TOKEN" "$DEV/api/v1/status" | grep -q '"home_assistant":"linked"'; }
eth() { curl -s -m 5 "$DEV/__qemu/state" | sed -nE "s/.*\"eth\":\{[^}]*\"$1\":\"?([^,\"}]*).*/\1/p"; }
num() { local v; v=$(eth "$1"); echo "${v:-0}"; }   # unreachable device → 0
for i in $(seq 90); do linked && break; [[ $i == 90 ]] && { echo "FAIL: not linked after sign-in"; exit 1; }; sleep 1; done
echo "[linkdrop] linked · NIC $NIC · $CYCLES cycles, off ${OFF_MIN}-${OFF_MAX} s, recover within $RECOVER_S s"

fails=0 worst=0
for c in $(seq "$CYCLES"); do
  downs=$(num link_downs) ups=$(num link_ups) leases=$(num leases)
  off=$(( OFF_MIN + RANDOM % (OFF_MAX - OFF_MIN + 1) ))
  monitor_ok "set_link $NIC off" || { echo "FAIL: cycle $c: set_link off not accepted (harness)"; exit 1; }
  sleep "$off"
  monitor_ok "set_link $NIC on" || { echo "FAIL: cycle $c: set_link on not accepted (harness)"; exit 1; }
  t0=$(date +%s) ok=0
  while (( $(date +%s) - t0 < RECOVER_S )); do
    if [[ "$(eth link)" == true && "$(eth ip)" == 10.0.2.15 && $(num link_downs) -gt $downs && $(num link_ups) -gt $ups \
          && $(num leases) -gt $leases ]] && linked; then ok=1; break; fi
    sleep 2
  done
  r=$(( $(date +%s) - t0 ))
  if (( ok )); then
    (( r > worst )) && worst=$r
    echo "[linkdrop] cycle $c/$CYCLES: off $off s → recovered in $r s (RX ring realigned from $(eth rx_skew))"
  else
    fails=$((fails + 1))
    echo "[linkdrop] cycle $c/$CYCLES: off $off s → NOT recovered after $RECOVER_S s · state $(curl -s -m 5 "$DEV/__qemu/state" || echo unreachable)"
    grep -E "QEMU-ETH|errno|refresh failed" "$LOG" | tail -8
  fi
done
grep -qE "Guru Meditation|abort\(\)|Backtrace:" "$LOG" && { echo "FAIL: crash in the QEMU log"; grep -m3 -E "Guru|abort|Backtrace" "$LOG"; exit 1; }
(( fails == 0 )) || { echo "FAIL: $fails of $CYCLES link drops did not recover"; exit 1; }
echo "PASS: $CYCLES link drops, all recovered (slowest $worst s)"
