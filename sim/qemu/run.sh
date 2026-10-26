#!/usr/bin/env bash
# Boot an ESP32-S3 image in Espressif QEMU on macOS (arm64/x86_64) or Linux.
#
#   sim/qemu/run.sh                     # build sim/qemu smoke test (if needed), merge, boot
#   sim/qemu/run.sh --build             # force rebuild of the smoke test first
#   sim/qemu/run.sh --fw firmware/.pio/build/x4pro   # boot another PlatformIO build dir instead
#   sim/qemu/run.sh --fresh             # recreate the 16 MB flash image (wipes NVS/www/userdata/otadata)
#   sim/qemu/run.sh --no-refresh        # boot the persistent flash image as is (a power cycle; keeps both app slots)
#   SIM_TIMEOUT=30 sim/qemu/run.sh      # quit after N seconds (CI); default runs until Ctrl-A X
#   SIM_QEMU_ARGS="..."                 # extra QEMU args (debugging), e.g. a -monitor socket
#   SIM_STATE=dir                       # where flash.bin/efuse.bin live (default sim/qemu/.state); one per image kind
# A www.bin in the build dir (pio run -t buildfs) is written to the www partition (0xC90000) on --fresh; userdata
# (0xFD0000) starts blank and the firmware formats it, as on a real first flash.
#
# Serial (UART0) goes to stdout. Networking: QEMU slirp; guest 10.0.2.15, host is 10.0.2.2,
# guest :80 is forwarded to 127.0.0.1:${SIM_HTTP_PORT:-8080}.
# The flash image is persistent (sim/qemu/.state/flash.bin), so NVS/userdata/OTA state survive reboots
# and re-runs just like a real chip. Only the app and www partitions are refreshed on each run unless --fresh.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PIO="${PIO:-$ROOT/.venv/bin/pio}"
STATE="${SIM_STATE:-$HERE/.state}"
QEMU_VER="${QEMU_VER:-esp-develop-9.2.2-20260417}"
QEMU_DIR="${QEMU_DIR:-$HERE/.state/qemu}"
BUILD_DIR="$HERE/.pio/build/qemu"
HTTP_PORT="${SIM_HTTP_PORT:-8080}"
BUILD=0 FRESH=0 REFRESH=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) BUILD=1 ;;
    --fresh) FRESH=1 ;;
    --no-refresh) REFRESH=0 ;;
    --fw) BUILD_DIR="$(cd "$2" && pwd)"; shift ;;
    -h|--help) sed -n 2,16p "$0"; exit 0 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
  shift
done
mkdir -p "$STATE" "$QEMU_DIR"

# --- 1. QEMU binary (Espressif fork; upstream QEMU has no esp32s3 machine) ---------------------
QEMU="$(command -v qemu-system-xtensa || true)"
if [[ -z "$QEMU" ]]; then
  QEMU="$QEMU_DIR/qemu/bin/qemu-system-xtensa"
  if [[ ! -x "$QEMU" ]]; then
    case "$(uname -s)-$(uname -m)" in
      Darwin-arm64) triple=aarch64-apple-darwin ;;
      Darwin-x86_64) triple=x86_64-apple-darwin ;;
      Linux-x86_64) triple=x86_64-linux-gnu ;;
      Linux-aarch64) triple=aarch64-linux-gnu ;;
      *) echo "[sim] unsupported host $(uname -s)-$(uname -m): Espressif ships QEMU for macOS and Linux (x86_64/arm64)." >&2
         echo "[sim] On Windows, run this inside WSL2 (Ubuntu); see docs/ESP32_EMULATION.md." >&2
         exit 1 ;;
    esac
    ver="${QEMU_VER#esp-develop-}"; ver="esp_develop_${ver//-/_}"
    url="https://github.com/espressif/qemu/releases/download/$QEMU_VER/qemu-xtensa-softmmu-$ver-$triple.tar.xz"
    echo "[sim] downloading $url"
    mkdir -p "$QEMU_DIR"
    curl -fsSL "$url" | tar -xJ -C "$QEMU_DIR"
  fi
fi
if [[ "$(uname -s)" == Darwin ]] && ! "$QEMU" --version >/dev/null 2>&1; then
  echo "[sim] QEMU needs Homebrew dylibs: brew install libgcrypt glib pixman sdl2 libslirp" >&2
  exit 1
fi
if [[ "$(uname -s)" == Linux ]] && ! "$QEMU" --version >/dev/null 2>&1; then
  echo "[sim] QEMU needs shared libraries (Debian/Ubuntu/WSL2):" >&2
  echo "[sim]   sudo apt-get install -y libgcrypt20 libglib2.0-0 libpixman-1-0 libsdl2-2.0-0 libslirp0 xz-utils" >&2
  exit 1
fi

# --- 2. Firmware ----------------------------------------------------------------------------
if [[ "$BUILD_DIR" == "$HERE/.pio/build/qemu" ]] && { [[ $BUILD == 1 ]] || [[ ! -f "$BUILD_DIR/firmware.bin" ]]; }; then
  (cd "$HERE" && "$PIO" run -e qemu)
fi
for f in bootloader.bin partitions.bin firmware.bin; do
  [[ -f "$BUILD_DIR/$f" ]] || { echo "missing $BUILD_DIR/$f" >&2; exit 1; }
done

# --- 3. Flash image (esptool merge-bin, 16 MB) ----------------------------------------------
ESPTOOL="${ESPTOOL:-$(command -v esptool || echo "$HOME/.platformio/penv/bin/esptool")}"
BOOT_APP0="$HOME/.platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin"
FLASH="$STATE/flash.bin"
if [[ $FRESH == 1 || ! -f "$FLASH" ]]; then
  fs=()
  [[ -f "$BUILD_DIR/www.bin" ]] && fs=(0xc90000 "$BUILD_DIR/www.bin")
  "$ESPTOOL" --chip esp32s3 merge-bin --fill-flash-size 16MB -o "$FLASH" \
    --flash-mode dio --flash-freq 80m --flash-size 16MB \
    0x0 "$BUILD_DIR/bootloader.bin" 0x8000 "$BUILD_DIR/partitions.bin" \
    0xe000 "$BOOT_APP0" 0x10000 "$BUILD_DIR/firmware.bin" ${fs[@]+"${fs[@]}"} >/dev/null
  echo "[sim] created fresh flash image $FLASH"
elif [[ $REFRESH == 1 ]]; then
  # keep NVS/userdata/otadata; refresh bootloader, partition table, app0 and the www console (build output, not
  # user data: an old www kept the console from the first --fresh run while the firmware moved on, 2026-10-17)
  dd if="$BUILD_DIR/bootloader.bin" of="$FLASH" bs=1 seek=0 conv=notrunc status=none
  dd if="$BUILD_DIR/partitions.bin" of="$FLASH" bs=1 seek=$((0x8000)) conv=notrunc status=none
  dd if="$BUILD_DIR/firmware.bin" of="$FLASH" bs=4096 seek=$((0x10000 / 4096)) conv=notrunc status=none
  [[ -f "$BUILD_DIR/www.bin" ]] && dd if="$BUILD_DIR/www.bin" of="$FLASH" bs=4096 seek=$((0xc90000 / 4096)) conv=notrunc status=none
  echo "[sim] refreshed app0 + www in persistent flash image $FLASH"
fi

# --- 4. eFuses (persistent, blank = like a fresh chip) --------------------------------------
EFUSE="$STATE/efuse.bin"
[[ -f "$EFUSE" ]] || dd if=/dev/zero of="$EFUSE" bs=1 count=1024 status=none

# --- 5. Boot --------------------------------------------------------------------------------
# -m 8M + is_octal=true emulates the N16R8's 8 MB octal PSRAM (default QEMU model is quad and
# the dio_opi Arduino libs then fail with "PSRAM chip is not connected, or wrong PSRAM line mode").
args=(-nographic -machine esp32s3 -m 8M
  -global driver=ssi_psram,property=is_octal,value=true
  -drive "file=$FLASH,if=mtd,format=raw"
  -drive "file=$EFUSE,if=none,format=raw,id=efuse"
  -global driver=nvram.esp32s3.efuse,property=drive,value=efuse
  -nic "user,model=open_eth,hostfwd=tcp:127.0.0.1:$HTTP_PORT-:80"
  -serial mon:stdio)
# extra QEMU args for debugging, e.g. SIM_QEMU_ARGS="-monitor tcp:127.0.0.1:4555,server,nowait"
[[ -n "${SIM_QEMU_ARGS:-}" ]] && read -r -a extra <<<"$SIM_QEMU_ARGS" && args+=("${extra[@]}")
echo "[sim] $QEMU ${args[*]}"
echo "[sim] quit: Ctrl-A then X"
if [[ -n "${SIM_TIMEOUT:-}" ]]; then
  "$QEMU" "${args[@]}" &
  pid=$!
  ( sleep "$SIM_TIMEOUT"; kill "$pid" 2>/dev/null ) &
  wait "$pid" || true
else
  exec "$QEMU" "${args[@]}"
fi
