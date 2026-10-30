#!/usr/bin/env bash
# Glance mode (#10) with the REAL firmware (env:x4qemu) in QEMU. QEMU has no deep sleep: net/power.cpp keeps the RTC
# record, leaves a fake wake cause in RTC_NOINIT memory and calls esp_restart() after at most 8 s (any timer).
#   1. v1 boots, links to the fake HA (--tick 0: values only change when the test says so), API token, quiet hours off
#   2. POST /__qemu/power?source=battery&armed=1 (QEMU default is USB = always live; armed skips the first-boot count)
#      → after the live window: the sleep face (#356, one full refresh) → "deep sleep (glance)" → simulated wake "timer"
#      → no boot screen, the front light off (#357), one HA snapshot
#   3. a wake with nothing changed draws nothing ("0 region(s) changed · no refresh")
#   4. the fake HA changes sensor.home_power: not on the sleep face → the next wake draws nothing
#   5. USB → charger wake, live; upload v2 → PENDING_VERIFY: on battery it stays awake ("unconfirmed image") until
#      the health check passes, then it deep-sleeps again
#   6. fake HA down → the wake gives up after the 20 s cap, no refresh, next timer doubled (30 min)
#   (#331) emptyHouse = zone.home: the fake HA sets it to 0 → the next wake draws Nobody home and sleeps 2 h ("empty
#      house", one redraw); back to 1 → the next wake draws the sleep face and sleeps 15 min again; diagnostics counts
#      the sleeps
# Diagnostics: every wake is a DEEPSLEEP boot in the ring, never a crash, and wakes share one slot.
# Usage: sim/qemu/glance-test.sh [--no-build]   exit 0 = pass. Logs: sim/qemu/.state/glance/
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PIO="${PIO:-$ROOT/.venv/bin/pio}"
PORT="${SIM_HTTP_PORT:-8080}"
HA_PORT="${FAKE_HA_PORT:-8123}"
STATE="$HERE/.state/glance"
LOG="$STATE/qemu.log"
DEV="http://127.0.0.1:$PORT"
HA="http://127.0.0.1:$HA_PORT"
V1=0.0.0-qemu-glance V2=0.0.1-qemu-glance
mkdir -p "$STATE"

if [[ "${1:-}" != "--no-build" ]]; then
  echo "[glance] building v1 ($V1), v2 ($V2)"
  (cd "$ROOT/firmware" && export X4_FW_VERSION=$V1 PLATFORMIO_BUILD_DIR="$STATE/build-v1" && "$PIO" run -e x4qemu && "$PIO" run -e x4qemu -t buildfs) >"$STATE/build.log" 2>&1 || { tail -30 "$STATE/build.log"; exit 1; }
  (cd "$ROOT/firmware" && X4_FW_VERSION=$V2 PLATFORMIO_BUILD_DIR="$STATE/build-v2" "$PIO" run -e x4qemu) >>"$STATE/build.log" 2>&1 || { tail -30 "$STATE/build.log"; exit 1; }
fi
B1="$STATE/build-v1/x4qemu"; B2="$STATE/build-v2/x4qemu"
if command -v sha256sum >/dev/null 2>&1; then SHA256=(sha256sum); else SHA256=(shasum -a 256); fi
sha() { "${SHA256[@]}" "$1" | cut -d' ' -f1; }

pkill -9 -f "qemu-system-xtensa.*$STATE/flash.bin" 2>/dev/null || true
if curl -s -m 2 "$DEV/api/v1/console/state" | grep -q '"ip":"10.0.2.15"'; then
  echo "FAIL: another QEMU already serves $DEV — kill it (pgrep -fl qemu-system-xtensa) or set SIM_HTTP_PORT"; exit 1
fi
pids=() QEMU_PID="" HA_PID=""
cleanup() {
  for p in "${pids[@]}" $QEMU_PID; do kill -9 "$p" 2>/dev/null || true; done
  pkill -9 -f "qemu-system-xtensa.*$STATE/flash.bin" 2>/dev/null || true
}
trap cleanup EXIT
start_ha() { (cd "$ROOT/emulator" && exec node server/fake-ha-main.ts --port "$HA_PORT" --host 127.0.0.1 --tick 0) >>"$STATE/fake-ha.log" 2>&1 & HA_PID=$!; pids+=($HA_PID); sleep 1; }

MARK=0
mark() { MARK=$(wc -l <"$LOG"); }   # log checks below only look at lines after the mark
newlog() { tail -n +$((MARK + 1)) "$LOG"; }
wait_log() {   # wait_log <seconds> <fixed string> [min count]
  for _ in $(seq "$1"); do [[ $(newlog | grep -cF -- "$2") -ge ${3:-1} ]] && return 0; sleep 1; done
  echo "FAIL: timeout waiting for log line: $2"; newlog | tail -40; exit 1
}
up() { curl -sf -m 2 "$DEV/api/v1/console/state" | grep -q '"ip":"10.0.2.15"'; }
sim_power() {   # the device may be between a simulated sleep and its next boot (unreachable for ~10 s): retry
  for _ in $(seq 60); do curl -sf -m 3 -X POST "$DEV/__qemu/power?$1" >/dev/null && return 0; sleep 1; done
  echo "FAIL: POST /__qemu/power?$1"; exit 1
}
wake_line() { newlog | grep -F "glance wake ·" | sed -n "${1}p"; }   # n-th glance wake line after the mark
# #356: glance sleeps to the next transition (midnight / quiet start, ≤ 8 h), never the old 15 / 30 min cadence
glance_wait() { grep -oE "deep sleep \(glance\) · timer wake in [0-9]+ s" "${1:-$LOG}" | tail -1 | sed -E 's/.* in ([0-9]+) s/\1/'; }
transition_wait() { local n; n=$(glance_wait); (( n > 0 && n <= 28800 && n != 900 && n != 1800 )) || { echo "FAIL: glance wait $n s is not a transition (≤ 8 h, no 15 / 30 min)"; exit 1; }; echo "   glance sleeps $n s"; }

: >"$LOG"
start_ha
SIM_STATE="$STATE" SIM_HTTP_PORT="$PORT" "$HERE/run.sh" --fw "$B1" --fresh >>"$LOG" 2>&1 </dev/null & QEMU_PID=$!
for _ in $(seq 90); do up && break; sleep 1; done
up || { echo "FAIL: no boot"; tail -30 "$LOG"; exit 1; }

echo "== v1 up · sign in through the fake HA + API token · quiet hours off, glance, live 1 min"
SESSION=$(cd "$ROOT/emulator" && node scripts/device-signin.ts "$DEV" "$HA" "http://10.0.2.2:$HA_PORT")
TOKEN=$(curl -s -X POST -b "x4_session=$SESSION" -H "Origin: $DEV" -H 'Content-Type: application/json' -d '{"name":"glance-test","scope":"write"}' "$DEV/api/v1/tokens" | sed -E 's/.*"token":"([^"]+)".*/\1/')
[[ -n "$TOKEN" && "$TOKEN" != *"{"* ]] || { echo "FAIL: POST /tokens: $TOKEN"; exit 1; }
auth=(-H "Authorization: Bearer $TOKEN")
r=$(curl -s -m 5 "${auth[@]}" -X PUT -H 'Content-Type: application/json' -d '{"display":{"quiet":"off","powerSave":"glance","wakeEvery":15,"liveMin":1,"emptyHouse":"zone.home"}}' "$DEV/api/v1/settings")
[[ "$r" == *'"powerSave":"glance"'* ]] || { echo "FAIL: PUT settings: $r"; exit 1; }
for _ in $(seq 60); do curl -s -m 3 "${auth[@]}" "$DEV/api/v1/status" | grep -q '"home_assistant":"linked"' && break; sleep 1; done
curl -s -m 3 -X POST -H 'Content-Type: application/json' -d '{"entity_id":"sensor.home_power","state":"420","attributes":{"unit_of_measurement":"W"}}' "$HA/__fake/state" >/dev/null

echo "== on USB (QEMU default): never sleeps"
mark
sleep 70   # past the 1 min live window
newlog | grep -qF "deep sleep (" && { echo "FAIL: slept on USB"; exit 1; }

echo "== on battery: live window over → deep sleep (glance) → timer wake without a boot screen"
mark
sim_power "source=battery&armed=1"
wait_log 90 "EPD clean refresh (sleep face)"
wait_log 30 "deep sleep (glance) · timer wake in"
transition_wait
wait_log 30 "simulated deep sleep over · wake timer"
wait_log 90 "wake: timer · glance (panel held, no boot screen)"
wait_log 30 "boot (timer) · front light off until a key or tap"
wait_log 60 "glance wake ·"
wait_log 60 "deep sleep (glance)" 2
newlog | grep -F "glance wake ·" | head -1

echo "== nothing changed in HA → a later wake draws nothing"
for _ in $(seq 120); do newlog | grep -F "glance wake ·" | grep -qF "0 region(s) changed · no refresh" && break; sleep 1; done
newlog | grep -F "glance wake ·" | grep -qF "0 region(s) changed · no refresh" || { echo "FAIL: no wake without a redraw"; newlog | grep -F "glance wake ·"; exit 1; }
up || true

echo "== sensor.home_power 420 → 3170 W in the fake HA: not on the sleep face (#356) → wakes draw nothing"
curl -sf -m 3 -X POST -H 'Content-Type: application/json' -d '{"entity_id":"sensor.home_power","state":"3170","attributes":{"unit_of_measurement":"W"}}' "$HA/__fake/state" >/dev/null
mark
for _ in $(seq 120); do [[ $(newlog | grep -cF "glance wake ·") -ge 2 ]] && break; sleep 1; done
for n in 1 2; do wake_line $n | grep -qF "0 region(s) changed · no refresh" || { echo "FAIL: the sleep face redrew for a dashboard value: $(wake_line $n)"; exit 1; }; done

echo "== nobody home (#331): zone.home 0 → Nobody home, 2 h; 1 again → the sleep face, to the next transition"
mark
curl -sf -m 3 -X POST -H 'Content-Type: application/json' -d '{"entity_id":"zone.home","state":"0"}' "$HA/__fake/state" >/dev/null
wait_re() { for _ in $(seq "$1"); do newlog | grep -qE -- "$2" && return 0; sleep 1; done; echo "FAIL: timeout waiting for /$2/"; newlog | tail -40; exit 1; }
wait_re 150 "deep sleep \(empty house\) · timer wake in (719[0-9]|7200) s"
newlog | grep -F "glance wake ·" | grep -qE "[1-9][0-9]* region\(s\) changed · changed" || { echo "FAIL: Nobody home not drawn"; newlog | grep -F "glance wake ·"; exit 1; }
[[ $(newlog | grep -cF "glance redraw · 1 full refresh (changed)") == 1 ]] || { echo "FAIL: not one redraw for one change"; newlog | grep -F "glance redraw"; exit 1; }
mark
for _ in $(seq 120); do [[ $(newlog | grep -cF "glance wake ·") -ge 1 ]] && break; sleep 1; done
wait_log 30 "deep sleep (empty house) · timer wake in"
mark
curl -sf -m 3 -X POST -H 'Content-Type: application/json' -d '{"entity_id":"zone.home","state":"1"}' "$HA/__fake/state" >/dev/null
wait_re 150 "deep sleep \(glance\) · timer wake in [0-9]+ s"
transition_wait
newlog | grep -F "glance wake ·" | grep -qE "[1-9][0-9]* region\(s\) changed · changed" || { echo "FAIL: sleep face not drawn after coming home"; newlog | grep -F "glance wake ·"; exit 1; }

echo "== diagnostics: wakes are DEEPSLEEP boots in one slot, no crash"
for _ in $(seq 60); do up && break; sleep 1; done
sim_power "source=usb"   # charger wake: live, stays up for the API
for _ in $(seq 60); do up && curl -s -m 3 "${auth[@]}" "$DEV/api/v1/status" | grep -q '"firmware"' && break; sleep 1; done
D=$(curl -s -m 5 "${auth[@]}" "$DEV/api/v1/diagnostics")
[[ "$D" == *'"last_crash":null'* ]] || { echo "FAIL: a crash was recorded: $D"; exit 1; }
[[ "$D" == *'"reason":"DEEPSLEEP"'* ]] || { echo "FAIL: no DEEPSLEEP boot in the ring: $D"; exit 1; }
[[ $(grep -o '"reason":"DEEPSLEEP"' <<<"$D" | wc -l) -le 2 ]] || { echo "FAIL: DEEPSLEEP wakes take more than one slot each run: $D"; exit 1; }
[[ "$D" == *'"deep_sleep":{"armed":'* ]] || { echo "FAIL: diagnostics has no deep_sleep: $D"; exit 1; }
grep -qE '"empty_house_sleeps":[2-9]' <<<"$D" || { echo "FAIL: empty_house_sleeps < 2: $D"; exit 1; }

echo "== upload v2 → PENDING_VERIFY → on battery it refuses to sleep until the health check passes"
printf '{"version":"%s","sha256":"%s","size":%s,"notes":[]}' "$V2" "$(sha "$B2/firmware.bin")" "$(wc -c <"$B2/firmware.bin" | tr -d ' ')" >"$STATE/manifest.json"
mark
r=$(curl -s -m 300 --limit-rate 300k "${auth[@]}" -F "firmware=@$B2/firmware.bin" -F "manifest=@$STATE/manifest.json" "$DEV/api/v1/ota/upload")
[[ "$r" == *'"status":"rebooting"'* ]] || { echo "FAIL: upload v2: $r"; exit 1; }
wait_log 120 "HA Paper $V2"
wait_log 30 "ESP_OTA_IMG_PENDING_VERIFY"
for _ in $(seq 60); do up && break; sleep 1; done
sim_power "source=battery&armed=1"
wait_log 60 "stays awake: unconfirmed image"
wait_log 120 "health check passed"
pre=$(newlog | grep -nF "health check passed" | head -1 | cut -d: -f1)
newlog | head -n "$pre" | grep -qF "deep sleep (" && { echo "FAIL: slept with an unconfirmed image"; exit 1; }
wait_log 120 "deep sleep (glance)"

echo "== fake HA down → the wake gives up after 20 s, keeps the panel, no backoff (#356: the same transition)"
prev=$(glance_wait)
mark
kill "$HA_PID" 2>/dev/null || true
for _ in $(seq 150); do newlog | grep -F "glance wake ·" | grep -qF "HA unreachable" && break; sleep 1; done
wake=$(newlog | grep -F "glance wake ·" | grep -F "HA unreachable" | head -1)
[[ -n "$wake" ]] || { echo "FAIL: no unreachable wake"; newlog | tail -30; exit 1; }
echo "   $wake"
[[ "$wake" == *"no refresh"* ]] || { echo "FAIL: redrew while HA was unreachable"; exit 1; }
ms=$(sed -E 's/.*glance wake · ([0-9]+) ms.*/\1/' <<<"$wake")
(( ms >= 20000 && ms < 23000 )) || { echo "FAIL: cap not 20 s ($ms ms)"; exit 1; }
for _ in $(seq 10); do newlog | grep -qF "deep sleep (glance) · timer wake in" && break; sleep 1; done
now=$(newlog | glance_wait /dev/stdin)
(( now <= prev && prev - now < 900 )) || { echo "FAIL: wait changed after an unreachable wake ($prev → $now s)"; exit 1; }
echo "PASS (log: $LOG)"
