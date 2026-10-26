#!/usr/bin/env bash
# Renders every default screen + state of the real UI runtime to PNG (firmware/test/out/*.png) on the host.
# Usage: tools/render.sh   (from firmware/; needs clang++ or g++ and the QRCode + ArduinoJson libs from
# `pio pkg install -e native`)
set -euo pipefail
cd "$(dirname "$0")/.."
QR=.pio/libdeps/native/QRCode/src
AJ=.pio/libdeps/native/ArduinoJson/src
if [ ! -d "$QR" ] || [ ! -d "$AJ" ]; then ${PIO:-../.venv/bin/pio} pkg install -e native >/dev/null; fi
mkdir -p test/out .pio/render
CXX=${CXX:-clang++}
${CC:-cc} -O2 -c "$QR/qrcode.c" -I"$QR" -o .pio/render/qrcode.o
# a git-describe build name: the longest version the Updates and About pages show (#199)
VER=${RENDER_VERSION:-0.1.0-alpha.6-18-gbf929d4}
$CXX -std=c++17 -O1 -DX4_NATIVE=1 -DARDUINOJSON_STRING_LENGTH_SIZE=4 -DX4_FW_VERSION="\"$VER\"" -Isrc -Iinclude -I"$QR" -I"$AJ" \
  src/core/*.cpp src/app/*.cpp src/app/gfx/*.cpp src/app/gen/*.cpp tools/render_host.cpp .pio/render/qrcode.o \
  -o .pio/render/render_host
.pio/render/render_host test/out
