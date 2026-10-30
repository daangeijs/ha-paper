#!/usr/bin/env bash
# Endurance run with fault injection (eink-ha-os#48): the REAL firmware (env:x4qemu) in QEMU against the fake HA for HOURS,
# a fault every FAULT_EVERY seconds in rotation, recorded by firmware/tools/soak.py, judged by endurance_check.py.
#   ha-restart   fake HA closes every socket and refuses its port for 20-60 s (POST /__fake/restart), tokens kept
#   ws-drop      fake HA destroys the WebSocket's TCP connection without a close frame (POST /__fake/drop-ws)
#   clock-jump   guest wall clock +2 h, next time -2 h (POST /__qemu/clock?jump=); SNTP may pull it back
#   link-drop    QEMU monitor `set_link <nic> off` for 30-90 s, then on (a Wi-Fi drop: no packets either way)
#   config-push  GET /config → PUT /config (same YAML) and PUT /settings display.clock 12 ↔ 24
# After each fault the display must report home_assistant "linked" within RECOVER_S (ha-restart and ws-drop: over a
# new WebSocket session). Big house (HOUSE=big, default): demo + 1200 entities; the console's entity list
# (GET /api/v1/ha/entities, the firmware's cap of 800 entries, kMaxListed in net/ha_client.cpp, eink-ha-os#57) is fetched every ENTITIES_EVERY s.
# Usage: sim/qemu/endurance.sh [--no-build]     env: HOURS (72) INTERVAL (soak poll, 60) FAULT_EVERY (HOURS·3600/12,
#   clamped 60..600) ENTITIES_EVERY (600, short runs HOURS·3600/3) RECOVER_S (300) HOUSE (big) SIM_HTTP_PORT FAKE_HA_PORT
# exit 0 = PASS. Output: sim/qemu/.state/endurance/ (endurance.md, events.csv, soak/soak.csv, diag-final.json, logs)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PIO="${PIO:-$ROOT/.venv/bin/pio}"
PYTHON="${PYTHON:-$(test -x "$ROOT/.venv/bin/python" && echo "$ROOT/.venv/bin/python" || echo python3)}"
PORT="${SIM_HTTP_PORT:-8080}"
HA_PORT="${FAKE_HA_PORT:-8123}"
MON_PORT="${SIM_MON_PORT:-$((PORT + 1000))}"
STATE="$HERE/.state/endurance"
BUILD="$ROOT/firmware/.pio/build/x4qemu"
DEV="http://127.0.0.1:$PORT"
HA="http://127.0.0.1:$HA_PORT"
HOURS="${HOURS:-72}"
DUR=$(awk "BEGIN { printf \"%d\", $HOURS * 3600 }")
INTERVAL="${INTERVAL:-60}"
FAULT_EVERY="${FAULT_EVERY:-$(( DUR / 12 < 60 ? 60 : (DUR / 12 > 600 ? 600 : DUR / 12) ))}"
ENTITIES_EVERY="${ENTITIES_EVERY:-$(( DUR / 3 < 600 ? DUR / 3 : 600 ))}"
RECOVER_S="${RECOVER_S:-300}"
HOUSE="${HOUSE:-big}"
MIN_ENTITIES=$([[ $HOUSE == big ]] && echo 800 || echo 1)   # big: the firmware lists at most 800 (eink-ha-os#57)
export X4_FW_VERSION="${X4_FW_VERSION:-0.0.0-qemu}"
mkdir -p "$STATE"

if [[ "${1:-}" != "--no-build" ]]; then
  (cd "$ROOT/firmware" && "$PIO" run -e x4qemu && "$PIO" run -e x4qemu -t buildfs) >"$STATE/build.log" 2>&1 \
    || { tail -30 "$STATE/build.log"; exit 1; }
fi
(cd "$ROOT/emulator" && [ -d node_modules ] || npm ci >/dev/null)

pkill -9 -f "qemu-system-xtensa.*$STATE/flash.bin" 2>/dev/null || true
if curl -s -m 2 "$DEV/api/v1/console/state" | grep -q '"ip":"10.0.2.15"'; then
  echo "FAIL: another QEMU already serves $DEV — kill it (pgrep -fl qemu-system-xtensa) or set SIM_HTTP_PORT"; exit 1
fi
rm -rf "$STATE/soak" "$STATE/events.csv" "$STATE/diag-final.json" "$STATE/endurance.md"
: >"$STATE/qemu.log"; : >"$STATE/fake-ha.log"
echo "time,kind,detail,recovered_s,result" >"$STATE/events.csv"

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; pkill -9 -f "qemu-system-xtensa.*$STATE/flash.bin" 2>/dev/null || true; }
trap cleanup EXIT

(cd "$ROOT/emulator" && exec node server/fake-ha-main.ts --port "$HA_PORT" --host 127.0.0.1 --tick 5000 --house "$HOUSE") >>"$STATE/fake-ha.log" 2>&1 &
pids+=($!)
SIM_STATE="$STATE" SIM_HTTP_PORT="$PORT" SIM_QEMU_ARGS="-monitor tcp:127.0.0.1:$MON_PORT,server,nowait" \
  "$HERE/run.sh" --fw "$BUILD" --fresh >>"$STATE/qemu.log" 2>&1 </dev/null &
pids+=($!)

for i in $(seq 120); do
  curl -sf -m 2 "$DEV/api/v1/console/state" | grep -q '"ip":"10.0.2.15"' && break
  [[ $i == 120 ]] && { echo "FAIL: firmware did not come up"; tail -40 "$STATE/qemu.log"; exit 1; }
  sleep 1
done

# During the run a failed request is a missed poll or a failed fault, never the end of the run: hcurl always returns 0
# (exit 52 empty reply, 7 refused, 28 timeout; -w '%{http_code}' then prints 000).
hcurl() { curl "$@" || true; }
mon() { printf '%s\n' "$1" | nc -w 2 127.0.0.1 "$MON_PORT" | tr -d '\r' || true; }
NIC=$(mon "info network" | sed -nE 's/^[^a-z_]*([A-Za-z0-9_.#-]+): index=[0-9]+,type=nic,model=open_eth.*/\1/p' | head -1)
[[ -n "$NIC" ]] || echo "[endurance] warning: no open_eth NIC on the QEMU monitor (:$MON_PORT): link-drop is skipped"

SESSION=$(cd "$ROOT/emulator" && node scripts/device-signin.ts "$DEV" "$HA" "http://10.0.2.2:$HA_PORT")
TOKEN=$(hcurl -s -X POST -b "x4_session=$SESSION" -H "Origin: $DEV" -H 'Content-Type: application/json' \
  -d '{"name":"endurance","scope":"write"}' "$DEV/api/v1/tokens" | sed -E 's/.*"token":"([^"]+)".*/\1/')
[[ -n "$TOKEN" && "$TOKEN" != *"{"* ]] || { echo "FAIL: POST /tokens"; exit 1; }
api() { hcurl -s -m 15 -H "Authorization: Bearer $TOKEN" "$@"; }
linked() { api "$DEV/api/v1/status" | grep -q '"home_assistant":"linked"'; }
sessions() { local n; n=$(hcurl -s -m 3 "$HA/__fake/state" | sed -nE 's/.*"sessions":([0-9]+).*/\1/p'); echo "${n:-0}"; }
now() { date +%s; }
iso() { date "+%Y-%m-%dT%H:%M:%S%z" | sed -E 's/([0-9]{2})([0-9]{2})$/\1:\2/'; }
event() { echo "$1,$2,\"${3//\"/\'}\",$4,$5" >>"$STATE/events.csv"; echo "[endurance] $(date +%H:%M:%S) $2 $3 → $5${4:+ in $4 s}"; }
# relink <start epoch> <sessions that must be exceeded, or empty>: echo seconds since start, or fail after RECOVER_S
relink() {
  while (( $(now) - $1 < RECOVER_S )); do
    if linked && { [[ -z "$2" ]] || (( $(sessions) > $2 )); }; then echo $(( $(now) - $1 )); return 0; fi
    sleep 2
  done
  return 1
}
for i in $(seq 90); do linked && break; [[ $i == 90 ]] && { echo "FAIL: not linked after sign-in"; exit 1; }; sleep 1; done
echo "[endurance] linked; house $HOUSE, ${HOURS} h, poll ${INTERVAL} s, fault every ${FAULT_EVERY} s, entity list every ${ENTITIES_EVERY} s"

entity_list() {   # the console's entity picker: the first GET asks HA again (list > 5 min old), the next one shows it
  local t0 n=0 at
  t0=$(now); at=$(iso)
  api "$DEV/api/v1/ha/entities" >/dev/null
  while (( $(now) - t0 < 120 )); do
    sleep 10
    n=$(api "$DEV/api/v1/ha/entities" | "$PYTHON" -c 'import json,sys; d=json.load(sys.stdin); print(len(d["entities"]) if d.get("ready") else 0)' 2>/dev/null || echo 0)
    (( n >= MIN_ENTITIES )) && { event "$at" entity-list "$n entities" $(( $(now) - t0 )) ok; return; }
  done
  event "$at" entity-list "$n entities" "" fail
}

# inject <curl args…>: a fault-injection control call (fake HA /__fake/*, /__qemu/clock). Retried once after 2 s;
# the body lands in $INJECT_BODY, else returns 1 with "HTTP <code> curl <exit>" in $INJECT_ERR (call it directly, not
# in $(…), so the globals survive). A failed injection is a harness problem (event result inject-failed).
INJECT_BODY="" INJECT_ERR=""
inject() {
  local out try
  for try in 1 2; do
    out=$(hcurl -s -m 10 -w '\n%{http_code} curl %{exitcode}' "$@")
    [[ "${out##*$'\n'}" == "200 curl 0" ]] && { INJECT_BODY="${out%$'\n'*}"; return 0; }
    INJECT_ERR="HTTP ${out##*$'\n'}"
    [[ $try == 1 ]] && sleep 2
  done
  return 1
}
# monitor <command>: QEMU monitor command, retried once after 2 s. Success = the monitor greeted with "(qemu)" and did
# not answer with an error; nc's exit code alone also says 0 when the monitor never read the line (eink-ha-os#108).
monitor_once() { local out; out=$(mon "$1"); [[ "$out" == *"(qemu)"* && "$out" != *"not found"* && "$out" != *"rror"* ]]; }
monitor() { monitor_once "$1" && return 0; sleep 2; monitor_once "$1"; }

CLOCK=7200 CLOCK_FMT=24
fault() {
  local kind=$1 t0 at s0 r detail="" code
  t0=$(now); at=$(iso); s0=$(sessions)
  case $kind in
    ha-restart)
      local down=$(( 20 + RANDOM % 41 )); detail="down $down s"
      inject -X POST -d "{\"down_s\":$down}" "$HA/__fake/restart" || { event "$at" "$kind" "$detail · $INJECT_ERR" "" inject-failed; return; }
      sleep "$down"; r=$(relink "$t0" "$s0") || r="" ;;
    ws-drop)
      inject -X POST "$HA/__fake/drop-ws" || { event "$at" "$kind" "$INJECT_ERR" "" inject-failed; return; }
      detail="$(sed -nE 's/.*"dropped":([0-9]+).*/\1/p' <<<"$INJECT_BODY") dropped"
      r=$(relink "$t0" "$s0") || r="" ;;
    clock-jump)
      detail="$CLOCK s"
      inject -X POST "$DEV/__qemu/clock?jump=$CLOCK" || { event "$at" "$kind" "$detail · $INJECT_ERR" "" inject-failed; return; }
      CLOCK=$(( -CLOCK ))
      sleep 20; r=$(relink "$t0" "") || r="" ;;
    link-drop)
      [[ -n "$NIC" ]] || return 0
      local off=$(( 30 + RANDOM % 61 ))
      monitor "set_link $NIC off" || { event "$at" "$kind" "set_link off: no monitor" "" inject-failed; return; }
      sleep "$off"
      local on=0
      for _ in 1 2 3 4 5; do monitor "set_link $NIC on" && { on=1; break; }; sleep 5; done   # the link must come back
      (( on )) || { event "$at" "$kind" "off $off s · set_link on: no monitor" "" inject-failed; return; }
      r=$(relink "$t0" "") || r=""
      detail="off $off s · new session $( (( $(sessions) > s0 )) && echo yes || echo no)" ;;
    config-push)
      CLOCK_FMT=$([[ $CLOCK_FMT == 24 ]] && echo 12 || echo 24)
      api "$DEV/api/v1/config" -o "$STATE/config.yaml"
      # "<http> curl <exit>": 000 curl 52 = connection closed without an answer, 000 curl 28 = timeout
      code=$(api -o /dev/null -w '%{http_code} curl %{exitcode}' -X PUT -H 'Content-Type: application/yaml' --data-binary "@$STATE/config.yaml" "$DEV/api/v1/config")
      code="$code / $(api -o /dev/null -w '%{http_code} curl %{exitcode}' -X PUT -H 'Content-Type: application/json' -d "{\"display\":{\"clock\":\"$CLOCK_FMT\"}}" "$DEV/api/v1/settings")"
      detail="config/settings HTTP $code · $(wc -c <"$STATE/config.yaml" | tr -d ' ') B YAML · clock $CLOCK_FMT"
      [[ $code == "200 curl 0 / 200 curl 0" ]] && { r=$(relink "$t0" "") || r=""; } || r="" ;;
  esac
  event "$at" "$kind" "$detail" "$r" "$([[ -n "$r" ]] && echo ok || echo fail)"
}

X4_TOKEN="$TOKEN" "$PYTHON" "$ROOT/firmware/tools/soak.py" --url "$DEV" --interval "$INTERVAL" --hours "$HOURS" \
  --out "$STATE/soak" >"$STATE/soak.log" 2>&1 &
SOAK=$!; pids+=($SOAK)

set +e   # from here on nothing may end a 72 h run early; failures land in events.csv and soak.csv
START=$(now)
KINDS=(ha-restart ws-drop clock-jump link-drop config-push)
k=0 next_fault=$(( START + FAULT_EVERY )) next_list=$START
while (( $(now) - START < DUR )); do
  if (( $(now) >= next_list )); then entity_list; next_list=$(( $(now) + ENTITIES_EVERY )); fi
  # a fault only when its longest window (link-drop 90 s + RECOVER_S) ends before the run does
  if (( $(now) >= next_fault && $(now) + 90 + RECOVER_S < START + DUR )); then
    fault "${KINDS[k % ${#KINDS[@]}]}"; k=$(( k + 1 )); next_fault=$(( $(now) + FAULT_EVERY ))
  fi
  sleep 5
done
wait "$SOAK" || true
api "$DEV/api/v1/diagnostics" -o "$STATE/diag-final.json" || true
if grep -q "Guru Meditation\|abort() was called" "$STATE/qemu.log"; then
  echo "[endurance] panic in qemu.log:"; grep -m5 "Guru Meditation\|abort() was called" "$STATE/qemu.log"
fi
"$PYTHON" "$ROOT/firmware/tools/endurance_check.py" "$STATE" --warmup "$(( DUR / 5 < 600 ? DUR / 5 : 600 ))"
