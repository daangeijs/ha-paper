#!/usr/bin/env bash
# Re-flash keeps screens and settings (issue #16), with the REAL firmware (env:x4qemu) in QEMU:
#   1. v1 boots on a fresh flash image (userdata blank → formatted), links to the fake HA, write token
#   2. PUT /api/v1/config (one entity changed to sensor.reflash_marker) + PUT /api/v1/settings (warmth 37)
#   3. QEMU off; the five release parts of v2 are written into the flash image at the offsets in x4flash.py PARTS,
#      the way esptool write-flash does it (erase every 4 KB sector a part touches, then write). userdata
#      (0xFD0000-0xFEFFFF) must come out byte-identical, and no erased sector may touch NVS or userdata.
#   4. v2 boots from that image: /status says v2, GET /config is the stored YAML byte for byte, warmth is still 37,
#      the console is served from the new www partition, and userdata was mounted, not formatted.
# Usage: sim/qemu/reflash-test.sh [--no-build]   exit 0 = pass. Logs: sim/qemu/.state/reflash/
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PIO="${PIO:-$ROOT/.venv/bin/pio}"
PORT="${SIM_HTTP_PORT:-8080}"
HA_PORT="${FAKE_HA_PORT:-8123}"
STATE="$HERE/.state/reflash"
LOG="$STATE/qemu.log"
DEV="http://127.0.0.1:$PORT"
FLASH="$STATE/flash.bin"
V1=0.0.0-qemu V2=0.0.1-qemu-reflash
UD_START=$((0xFD0000)) UD_END=$((0xFF0000)) NVS_START=$((0x9000)) NVS_END=$((0xE000))
mkdir -p "$STATE"

if [[ "${1:-}" != "--no-build" ]]; then
  echo "[reflash] building v1 ($V1) and v2 ($V2), each with www.bin"
  for v in 1 2; do
    ver=V$v
    (cd "$ROOT/firmware" && export X4_FW_VERSION=${!ver} PLATFORMIO_BUILD_DIR="$STATE/build-v$v" && "$PIO" run -e x4qemu && "$PIO" run -e x4qemu -t buildfs) \
      >>"$STATE/build.log" 2>&1 || { tail -30 "$STATE/build.log"; exit 1; }
  done
fi
B1="$STATE/build-v1/x4qemu"; B2="$STATE/build-v2/x4qemu"
BOOT_APP0="$HOME/.platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin"

# The release folder of v2, named like the GitHub release assets; offsets come from x4flash.py itself.
REL="$STATE/release-v2"
rm -rf "$REL" && mkdir -p "$REL"
cp "$B2/bootloader.bin" "$B2/partitions.bin" "$B2/firmware.bin" "$B2/www.bin" "$REL/"
cp "$BOOT_APP0" "$REL/boot_app0.bin"
PARTS=$(cd "$ROOT/firmware/tools" && python3 -B -c 'import x4flash; print("\n".join("%d %s" % p for p in x4flash.PARTS))')
(( $(wc -l <<<"$PARTS") == 5 )) || { echo "FAIL: x4flash.py PARTS is not five parts: $PARTS"; exit 1; }
grep -q " www.bin$" <<<"$PARTS" || { echo "FAIL: x4flash.py does not flash www.bin"; exit 1; }

pkill -9 -f "qemu-system-xtensa.*$FLASH" 2>/dev/null || true
if curl -s -m 2 "$DEV/api/v1/console/state" | grep -q '"ip":"10.0.2.15"'; then
  echo "FAIL: another QEMU already serves $DEV — kill it (pgrep -fl qemu-system-xtensa) or set SIM_HTTP_PORT"; exit 1
fi

pids=() QEMU_PID=""
cleanup() {
  for p in "${pids[@]}" $QEMU_PID; do kill -9 "$p" 2>/dev/null || true; done
  pkill -9 -f "qemu-system-xtensa.*$FLASH" 2>/dev/null || true
}
trap cleanup EXIT
start_qemu() { SIM_STATE="$STATE" SIM_HTTP_PORT="$PORT" "$HERE/run.sh" "$@" >>"$LOG" 2>&1 </dev/null & QEMU_PID=$!; }
stop_qemu() { kill "$QEMU_PID" 2>/dev/null || true; wait "$QEMU_PID" 2>/dev/null || true; QEMU_PID=""; }
wait_boot() {
  for _ in $(seq 90); do curl -sf -m 2 "$DEV/api/v1/console/state" | grep -q '"ip":"10.0.2.15"' && return 0; sleep 1; done
  echo "FAIL: no boot"; tail -30 "$LOG"; exit 1
}
api() { curl -s -m 10 -H "Authorization: Bearer $TOKEN" "$@"; }
MARK=0
mark() { MARK=$(wc -l <"$LOG"); }
newlog() { tail -n +$((MARK + 1)) "$LOG"; }
region() { dd if="$FLASH" bs=4096 skip=$(($1 / 4096)) count=$((($2 - $1) / 4096)) status=none; }   # <start> <end>

: >"$LOG"
(cd "$ROOT/emulator" && { [ -d node_modules ] || npm ci >/dev/null; })
(cd "$ROOT/emulator" && exec node server/fake-ha-main.ts --port "$HA_PORT" --host 127.0.0.1 --tick 0) >"$STATE/fake-ha.log" 2>&1 &
pids+=($!)
sleep 1

echo "== v1 on a fresh flash image · userdata formatted on first mount"
mark
start_qemu --fw "$B1" --fresh
wait_boot
newlog | grep -F "userdata formatted" >/dev/null || { echo "FAIL: blank userdata was not formatted on first boot"; newlog | grep STORE; exit 1; }
SESSION=$(cd "$ROOT/emulator" && node scripts/device-signin.ts "$DEV" "http://127.0.0.1:$HA_PORT" "http://10.0.2.2:$HA_PORT")
TOKEN=$(curl -s -X POST -b "x4_session=$SESSION" -H "Origin: $DEV" -H 'Content-Type: application/json' -d '{"name":"reflash-test","scope":"write"}' "$DEV/api/v1/tokens" | sed -E 's/.*"token":"([^"]+)".*/\1/')
[[ -n "$TOKEN" && "$TOKEN" != *"{"* ]] || { echo "FAIL: POST /tokens: $TOKEN"; exit 1; }
api "$DEV/api/v1/status" | grep -F "\"firmware\":\"$V1\"" >/dev/null || { echo "FAIL: v1 not running / token rejected"; exit 1; }

echo "== write screens.yaml + settings.json through the API"
api "$DEV/api/v1/config" >"$STATE/orig.yaml"
grep -q 'entity: sensor\.' "$STATE/orig.yaml" || { echo "FAIL: no sensor entity in the default config"; exit 1; }
awk '!d && sub(/entity: sensor\.[a-z0-9_]+/, "entity: sensor.reflash_marker") { d = 1 } 1' "$STATE/orig.yaml" >"$STATE/new.yaml"
r=$(api -X PUT -H 'Content-Type: application/yaml' --data-binary "@$STATE/new.yaml" "$DEV/api/v1/config")
[[ "$r" == *'"status":"applied"'* ]] || { echo "FAIL: PUT /config: $r"; exit 1; }
r=$(api -X PUT -H 'Content-Type: application/json' -d '{"display":{"warmth":37}}' "$DEV/api/v1/settings")
[[ "$r" == *'"warmth":37'* ]] || { echo "FAIL: PUT /settings: $r"; exit 1; }
api "$DEV/api/v1/config" >"$STATE/stored.yaml"
grep -qF "sensor.reflash_marker" "$STATE/stored.yaml" || { echo "FAIL: GET /config does not have the new entity"; exit 1; }
sleep 3   # files are written by the handlers; give LittleFS time to close them before power-off
stop_qemu

region $UD_START $UD_END >"$STATE/userdata-before.bin"
grep -aqF "sensor.reflash_marker" "$STATE/userdata-before.bin" || { echo "FAIL: screens.yaml is not in the userdata partition"; exit 1; }
grep -aqF '"warmth":37' "$STATE/userdata-before.bin" || { echo "FAIL: settings.json is not in the userdata partition"; exit 1; }

echo "== re-flash the five parts of v2 like x4flash.py / esptool write-flash (sector erase + write)"
while read -r off name; do
  size=$(wc -c <"$REL/$name" | tr -d ' ')
  end=$(( (off + size + 4095) / 4096 * 4096 ))
  (( off < UD_END && end > UD_START )) && { echo "FAIL: $name ($off-$end) would erase userdata"; exit 1; }
  (( off < NVS_END && end > NVS_START )) && { echo "FAIL: $name ($off-$end) would erase NVS"; exit 1; }
  head -c $((end - off)) /dev/zero | LC_ALL=C tr '\0' '\377' | dd of="$FLASH" bs=4096 seek=$((off / 4096)) conv=notrunc status=none
  dd if="$REL/$name" of="$FLASH" bs=4096 seek=$((off / 4096)) conv=notrunc status=none
  printf '   0x%06x-0x%06x %s\n' "$off" "$end" "$name"
done <<<"$PARTS"
region $UD_START $UD_END >"$STATE/userdata-after.bin"
cmp -s "$STATE/userdata-before.bin" "$STATE/userdata-after.bin" || { echo "FAIL: userdata bytes changed by the re-flash"; exit 1; }
region $((0x10000)) $((0x650000)) >"$STATE/app0-after.bin"
grep -aqF "$V2" "$STATE/app0-after.bin" || { echo "FAIL: app0 does not hold v2 after the re-flash"; exit 1; }
echo "   userdata 0xfd0000-0xff0000 byte-identical"

# grep without -q below: under pipefail, -q exiting early would SIGPIPE the writer and fail the pipeline
echo "== v2 boots from the re-flashed image · same screens.yaml and settings"
mark
start_qemu --fw "$B2" --no-refresh
wait_boot
api "$DEV/api/v1/status" | grep -F "\"firmware\":\"$V2\"" >/dev/null || { echo "FAIL: v2 not running after the re-flash (or the token is gone)"; exit 1; }
newlog | grep -F "userdata mount failed" >/dev/null && { echo "FAIL: userdata did not mount after the re-flash (formatted)"; exit 1; }
newlog | grep -F "console from the www partition" >/dev/null || { echo "FAIL: web console not served from the re-flashed www partition"; newlog | grep WEB; exit 1; }
api "$DEV/api/v1/config" >"$STATE/after.yaml"
cmp -s "$STATE/stored.yaml" "$STATE/after.yaml" || { echo "FAIL: screens.yaml changed across the re-flash"; diff "$STATE/stored.yaml" "$STATE/after.yaml" | head -20; exit 1; }
api "$DEV/api/v1/settings" | grep -F '"warmth":37' >/dev/null || { echo "FAIL: settings.json lost across the re-flash"; exit 1; }
echo "PASS (log: $LOG)"
