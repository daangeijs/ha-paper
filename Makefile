# HA Paper — build, test, flash the Xteink X4 Pro. See docs/FLASHING.md.
#
#   make build                      firmware.bin + www.bin (web console) for env:x4pro
#   make test                       native core tests (PlatformIO) + emulator + browser flasher (vitest) + tools (python)
#   make chip-check PORT=…          chip id + security info (locked / secure boot?)
#                                   PORT: macOS /dev/cu.usbmodem*, Linux/WSL2 /dev/ttyACM0 (docs/FLASHING.md)
#   make backup     PORT=…          full 16 MB read of the stock firmware → backups/ (never overwrites)
#   make flash      PORT=…          bootloader + partitions + otadata + app + www (needs a backup first; keeps NVS + userdata)
#   make monitor    PORT=…          serial log: colours, ARGS="--tag HA,NET --csv heap.csv", Improv frames, reconnect
#   make monitor-pio PORT=…         PlatformIO monitor with the panic backtrace decoder
#   make soak       URL=…           X4_TOKEN=x4_… poll /status + /diagnostics every 5 min → soak/<host>/ CSV + daily summary
#                                   HOURS=… stop after (default: until Ctrl-C), INTERVAL=… seconds, OUT=… folder
#   make logs       URL=…           X4_TOKEN=x4_… the device log over Wi-Fi (GET /api/v1/logs, no cable, no reset, eink-ha-os#200)
#                                   FOLLOW=1 live tail, PREVIOUS=1 the boot before this one, LEVEL=W, TAG=HEAP,EPD
#   make restore    PORT=… FILE=backups/x4pro_stock_YYYYMMDD.bin
#   make dist                       release artifacts in dist/ (firmware, www, separate boot parts, manifests)
#   make flasher                    dist + browser flasher site in dist/flasher/ (upload the folder to any HTTPS host)
#                                   refuses a -dirty version unless ALLOW_DIRTY=1
#   make flasher-screens            re-render the UI and refresh the screen images on the flasher page (committed)
#   make gen / gen-check            regenerate the committed fonts + icons (firmware/src/app/gen) / fail if they drift
#   make deviations                 rewrite the index in firmware/ + emulator/DEVIATIONS.md from deviations/*.md
#                                   (one file per topic, eink-ha-os#117; make test fails when the index is stale)
#   make qemu                       real firmware (env:x4qemu) in Espressif QEMU → http://127.0.0.1:8080 (FRESH=1 wipes flash)
#   make qemu-contract              QEMU firmware + fake HA → emulator contract suite against the real firmware
#                                   QEMU_ENV=x4qemu_debug: same suite on the debug image (heap + spinlock checks)
#                                   CONTRACT_HA_TLS=1: the device links to the fake HA over https (TLS faults, eink-ha-os#87)
#   make qemu-ota                   QEMU firmware: OTA upload → PENDING_VERIFY → valid / rollback when HA is unreachable
#   make qemu-wdt                   QEMU firmware: confirmed image hangs loop() → task watchdog reset → reason TASK_WDT
#   make qemu-reflash               QEMU firmware: PUT screens.yaml, re-flash the five parts → userdata unchanged
#   make qemu-glance                QEMU firmware on "battery": simulated deep sleep, timer wakes redraw only on change,
#                                   an unconfirmed OTA image refuses to sleep, HA down → 20 s cap + backoff (eink-ha-os#10)
#   make qemu-linkdrop CYCLES=20    QEMU firmware: CYCLES monitor link drops (20-90 s off), each must recover (eink-ha-os#108)
#   make qemu-endurance HOURS=72    QEMU firmware + fake HA (big house) with a fault every 10 min, soak CSV → PASS/FAIL
#                                   (HA restarts, WebSocket/link drops, clock jumps, config pushes; sim/qemu/endurance.sh)
#   make worktree-setup N=115 BASE=<sha> PORTS=8100/8143
#                                   agent worktree .claude/worktrees/issue-N on branch issue-N at BASE (after a fetch):
#                                   submodules, node_modules + .venv linked from the main checkout (npm ci if the lock
#                                   differs), ports in .scratch-N/ports (env $(cat .scratch-N/ports) make qemu-contract)
#
# VERSION: 0.0.0-dev, except dist/flasher/flasher-site/flash, which stamp `git describe` (v0.4.0 → 0.4.0); VERSION=… wins.

SHELL := /bin/bash
ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
PIO ?= $(ROOT)/.venv/bin/pio
ESPTOOL ?= $(ROOT)/.venv/bin/esptool
ENV ?= x4pro
QEMU_ENV ?= x4qemu
BAUD ?= 921600
# git describe only for what ships or lands on a device: test/build/qemu targets run no git and keep one build cache (eink-ha-os#116)
RELEASE_GOALS := dist flasher flasher-site flash
ifeq ($(origin VERSION),undefined)
ifneq ($(filter $(RELEASE_GOALS),$(MAKECMDGOALS)),)
VERSION := $(shell git -C $(ROOT) describe --tags --match 'v[0-9]*' --dirty 2>/dev/null | sed 's/^v//')
endif
endif
ifeq ($(strip $(VERSION)),)
VERSION := 0.0.0-dev
endif
# the firmware falls back to 0.0.0-dev itself: not exporting it keeps make and a bare `pio run` on the same build flags
ifneq ($(VERSION),0.0.0-dev)
export X4_FW_VERSION := $(VERSION)
endif

FW := $(ROOT)/firmware
BUILD := $(FW)/.pio/build/$(ENV)
DIST := $(ROOT)/dist
BACKUPS := $(ROOT)/backups
PLATFORMIO_CORE_DIR ?= $(HOME)/.platformio
BOOT_APP0 := $(PLATFORMIO_CORE_DIR)/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin
# firmware/partitions.csv: www (0xC90000, www.bin) is written by every flash; userdata (0xFD0000) and NVS never are
FLASH_SIZE_BYTES := 0x1000000
TODAY := $(shell date +%Y%m%d)
# sha256sum (GNU coreutils: Linux, WSL2) or shasum (macOS); same output and -c format
SHA256 := $(shell command -v sha256sum >/dev/null 2>&1 && echo sha256sum || echo 'shasum -a 256')
PYTHON ?= $(if $(wildcard $(ROOT)/.venv/bin/python),$(ROOT)/.venv/bin/python,python3)
# Committed generated sources: firmware/tools/fontgen.py + icongen.py
GEN_DIR := firmware/src/app/gen
GEN_FILES := $(GEN_DIR) emulator/src/plain-zero.css   # + the emulator's plain-zero @font-face (fontTools only)

.PHONY: help build firmware fs ui test test-native test-emulator test-flasher test-tools chip-check backup flash monitor monitor-pio soak logs restore dist flasher flasher-site flasher-screens gen gen-check deviations clean require-port qemu qemu-build qemu-contract qemu-ota qemu-wdt qemu-reflash qemu-glance qemu-linkdrop qemu-endurance worktree-setup

help:
	@sed -n '1,/^$$/p' $(firstword $(MAKEFILE_LIST)) | sed 's/^# \{0,1\}//'

require-port:
	@if [ -z "$(PORT)" ]; then \
	  p=$$(ls /dev/cu.usbmodem* /dev/ttyACM* /dev/ttyUSB* 2>/dev/null | head -1); \
	  echo "Set PORT, e.g. make $(MAKECMDGOALS) PORT=$${p:-/dev/ttyACM0}   (port names per OS: docs/FLASHING.md)"; exit 2; fi

build: firmware fs

firmware:
	cd $(FW) && $(PIO) run -e $(ENV)

# www.bin (partition `www`); scripts/build_ui.py runs `npm run build:device-ui` and gzips it into data/www
fs:
	cd $(FW) && $(PIO) run -e $(ENV) -t buildfs

ui:
	cd $(ROOT)/emulator && ( [ -d node_modules ] || npm ci ) && npm run build:device-ui

test: test-native test-emulator test-flasher test-tools

test-native:
	cd $(FW) && $(PIO) test -e native

test-emulator:
	cd $(ROOT)/emulator && ( [ -d node_modules ] || npm ci ) && npm test

# includes the backup -> install -> restore round trip on a patterned 16 MB image (flasher/test/roundtrip.test.ts)
test-flasher:
	cd $(ROOT)/flasher && ( [ -d node_modules ] || npm ci ) && npm test

test-tools:
	$(PYTHON) -m unittest discover -s $(FW)/tools -p 'test_*.py'

chip-check: require-port
	@echo "== chip-id =="; $(ESPTOOL) --chip esp32s3 -p $(PORT) chip-id
	@echo; echo "== security-info (look for: Secure Boot / Flash Encryption enabled, USB/JTAG disabled) =="
	@$(ESPTOOL) --chip esp32s3 -p $(PORT) get-security-info
	@echo; echo "If flash encryption or secure boot is ENABLED this unit cannot run HA Paper — do not flash it."

backup: require-port
	@mkdir -p $(BACKUPS)
	@out=$(BACKUPS)/x4pro_stock_$(TODAY).bin; \
	if [ -e "$$out" ]; then echo "Refusing to overwrite $$out (move it away first)."; exit 1; fi; \
	echo "Reading 16 MB from $(PORT) → $$out (takes ~3 min)"; \
	$(ESPTOOL) --chip esp32s3 -p $(PORT) -b $(BAUD) read-flash 0 $(FLASH_SIZE_BYTES) "$$out.part" && \
	mv "$$out.part" "$$out" && \
	$(SHA256) "$$out" | tee "$$out.sha256" && \
	chmod a-w "$$out" && echo "Backup OK: $$out"

flash: require-port
	@if ! ls $(BACKUPS)/x4pro_stock_*.bin >/dev/null 2>&1 && [ "$(FORCE)" != "1" ]; then \
	  echo "No stock backup in $(BACKUPS)/. Run 'make backup PORT=$(PORT)' first (or FORCE=1)."; exit 1; fi
	cd $(FW) && $(PIO) run -e $(ENV) -t upload --upload-port $(PORT)
	# uploadfs = www.bin into partition `www` (board_build.filesystem_partition); userdata is left alone
	cd $(FW) && $(PIO) run -e $(ENV) -t uploadfs --upload-port $(PORT)
	@echo "Flashed HA Paper $(VERSION). Replug USB if it doesn't start."

monitor: require-port
	$(PYTHON) $(FW)/tools/monitor.py $(PORT) $(ARGS)

monitor-pio: require-port
	cd $(FW) && $(PIO) device monitor -e $(ENV) -p $(PORT)

# firmware/tools/soak.py: one CSV row per poll + summary-YYYY-MM-DD.md (eink-ha-os#46). The token comes from X4_TOKEN only.
soak:
	@if [ -z "$(URL)" ]; then echo "Set URL, e.g. X4_TOKEN=x4_… make soak URL=http://ha-paper-a1b2.local [HOURS=168]"; exit 2; fi
	$(PYTHON) $(FW)/tools/soak.py --url "$(URL)" $(if $(IP),--ip $(IP),) $(if $(HOURS),--hours $(HOURS),) $(if $(INTERVAL),--interval $(INTERVAL),) --out "$(if $(OUT),$(OUT),$(ROOT)/soak/$(shell echo '$(URL)' | sed -E 's#^[a-z]+://##; s#/.*##; s#:#-#'))"

# firmware/tools/logs.py (eink-ha-os#200). The token comes from X4_TOKEN only.
logs:
	@if [ -z "$(URL)" ]; then echo "Set URL, e.g. X4_TOKEN=x4_… make logs URL=http://ha-paper-a1b2.local [FOLLOW=1] [PREVIOUS=1]"; exit 2; fi
	$(PYTHON) $(FW)/tools/logs.py --url "$(URL)" $(if $(FOLLOW),--follow,) $(if $(PREVIOUS),--previous,) $(if $(LEVEL),--level $(LEVEL),) $(if $(TAG),--tag $(TAG),)

restore: require-port
	@if [ -z "$(FILE)" ] || [ ! -f "$(FILE)" ]; then echo "Set FILE=backups/x4pro_stock_YYYYMMDD.bin"; exit 2; fi
	@size=$$(wc -c < "$(FILE)" | tr -d ' '); \
	if [ "$$size" != "16777216" ]; then echo "$(FILE) is $$size bytes, expected a full 16 MB dump."; exit 1; fi
	@if [ -f "$(FILE).sha256" ]; then $(SHA256) -c "$(FILE).sha256" || exit 1; fi
	$(ESPTOOL) --chip esp32s3 -p $(PORT) -b $(BAUD) write-flash 0x0 "$(FILE)"
	@echo "Stock firmware restored. Replug USB if it doesn't start."

# Release artifacts (also used by .github/workflows/release.yml). No merged 0x0 image on purpose: merge-bin pads
# the NVS gap at 0x9000 with 0xFF, so writing it would wipe the OEM hw_calib panel id.
# Own build dir, so a parallel `pio run` in firmware/.pio/build can't delete its objects. The old dist/ goes first and
# the new one is staged and moved into place last: a failed build leaves no dist/ rather than a stale one.
DIST_BUILD := $(FW)/.pio/dist-build
DIST_STAGE := $(FW)/.pio/dist-stage
dist:
	rm -rf $(DIST) $(DIST_STAGE)
	cd $(FW) && PLATFORMIO_BUILD_DIR=$(DIST_BUILD) $(PIO) run -e $(ENV)
	cd $(FW) && PLATFORMIO_BUILD_DIR=$(DIST_BUILD) $(PIO) run -e $(ENV) -t buildfs
	mkdir -p $(DIST_STAGE)
	cd $(DIST_BUILD)/$(ENV) && cp firmware.bin www.bin bootloader.bin partitions.bin $(DIST_STAGE)/
	cp "$(BOOT_APP0)" $(DIST_STAGE)/boot_app0.bin
	cp $(FW)/tools/x4flash.py $(DIST_STAGE)/
	python3 $(FW)/scripts/release_manifest.py --version $(VERSION) --dist $(DIST_STAGE) $(if $(NOTES),--notes-file $(NOTES),)
	python3 $(FW)/scripts/release_manifest.py --check --version $(VERSION) --dist $(DIST_STAGE)
	mv $(DIST_STAGE) $(DIST)
	@ls -la $(DIST)

# Browser flasher (flasher/, Web Serial): the static page plus the five parts, manifest.json and SHA256SUMS in
# dist/flasher/firmware/. The page fetches them by relative URL, so the folder works under any path on any HTTPS host.
# flasher-site packages an existing dist/ without rebuilding it (release.yml uses that after writing SHA256SUMS).
FLASHER_OUT := $(DIST)/flasher
FLASHER_FILES := bootloader.bin partitions.bin boot_app0.bin firmware.bin www.bin manifest.json

flasher: dist
	$(MAKE) flasher-site VERSION=$(VERSION)

# The site is labelled $(VERSION): it refuses a dist/ built from another commit, and a -dirty version unless
# ALLOW_DIRTY=1 (local test).
flasher-site:
	@for f in $(FLASHER_FILES); do [ -f "$(DIST)/$$f" ] || { echo "Missing $(DIST)/$$f: run 'make dist' first."; exit 1; }; done
	@case "$(VERSION)" in *-dirty) [ "$(ALLOW_DIRTY)" = 1 ] || { echo "Refusing to package $(VERSION): uncommitted changes. Commit them, or set ALLOW_DIRTY=1 for a local test."; exit 1; };; esac
	@python3 $(FW)/scripts/release_manifest.py --check --version $(VERSION) --dist $(DIST)
	cd $(ROOT)/flasher && ( [ -d node_modules ] || npm ci ) && npm run build -- --outDir $(FLASHER_OUT) --emptyOutDir
	rm -rf $(FLASHER_OUT)/firmware && mkdir -p $(FLASHER_OUT)/firmware
	cd $(DIST) && cp $(FLASHER_FILES) $(FLASHER_OUT)/firmware/
	cd $(FLASHER_OUT)/firmware && $(SHA256) *.bin > SHA256SUMS
	@echo "Browser flasher ($(VERSION)) in $(FLASHER_OUT)/: upload that folder to an HTTPS host."

# The landing page shows four host renders (firmware/tools/render.sh) as 2-bit PNGs in flasher/src/screens/.
flasher-screens:
	cd $(ROOT)/firmware && tools/render.sh
	$(PYTHON) $(ROOT)/flasher/screens.py

# Fonts + icons are rendered from firmware/assets/fonts and firmware/assets/icons.json and committed (needs Pillow + fontTools at the
# versions in firmware/requirements.txt; another version may rasterise differently). gen-check fails on any drift.
# fontgen.py pins Pillow's BASIC layout: RAQM (picked when libfribidi is installed, e.g. on GitHub ubuntu-24.04)
# shifts advances by a pixel and blanks U+00AD. On drift in CI, the gen-linux artifact of the failed run has the output.
deviations:
	$(PYTHON) $(FW)/tools/deviations.py

gen:
	cd $(FW) && $(PYTHON) tools/fontgen.py && $(PYTHON) tools/icongen.py

gen-check: gen
	@git -C $(ROOT) diff --exit-code --stat -- $(GEN_FILES) || \
	  { git -C $(ROOT) diff -U0 -- $(GEN_FILES) | head -40; \
	    echo "$(GEN_DIR) is out of date: run 'make gen' and commit the result."; exit 1; }
	@new=$$(git -C $(ROOT) ls-files --others --exclude-standard -- $(GEN_FILES)); \
	if [ -n "$$new" ]; then echo "Untracked generated files (commit them): $$new"; exit 1; fi

clean:
	cd $(FW) && $(PIO) run -e $(ENV) -t clean
	rm -rf $(DIST) $(DIST_BUILD) $(DIST_STAGE)

# ---- Espressif QEMU (docs/ESP32_EMULATION.md §5) ---------------------------------------------------------------
# Debug hooks of the x4qemu image: GET /__qemu/framebuffer.pgm (what the panel shows), POST /__qemu/input?tap=x,y|key=next,
# GET /__qemu/state. HA: run `cd emulator && npm run fake-ha` (the guest reaches it at http://10.0.2.2:8123) or a real one.
# Own build dir under the state dir, like the sim/qemu/*.sh suites: a `pio run` in firmware/ can't swap the image (eink-ha-os#118)
QEMU_STATE := $(ROOT)/sim/qemu/.state/x4qemu
qemu-build:
	cd $(FW) && export PLATFORMIO_BUILD_DIR=$(QEMU_STATE)/build && $(PIO) run -e x4qemu && $(PIO) run -e x4qemu -t buildfs

qemu: qemu-build
	SIM_STATE=$(QEMU_STATE) $(ROOT)/sim/qemu/run.sh --fw $(QEMU_STATE)/build/x4qemu $(if $(FRESH),--fresh,)

qemu-contract:
	PIO=$(PIO) X4_FW_VERSION=0.0.0-qemu X4_QEMU_ENV=$(QEMU_ENV) $(ROOT)/sim/qemu/contract.sh

qemu-ota:
	PIO=$(PIO) $(ROOT)/sim/qemu/ota-fw-test.sh

qemu-wdt:
	PIO=$(PIO) $(ROOT)/sim/qemu/wdt-test.sh

qemu-reflash:
	PIO=$(PIO) $(ROOT)/sim/qemu/reflash-test.sh

qemu-glance:
	PIO=$(PIO) $(ROOT)/sim/qemu/glance-test.sh

qemu-linkdrop:
	PIO=$(PIO) $(if $(CYCLES),CYCLES=$(CYCLES),) $(ROOT)/sim/qemu/linkdrop-test.sh

qemu-endurance:
	PIO=$(PIO) $(if $(HOURS),HOURS=$(HOURS),) $(ROOT)/sim/qemu/endurance.sh

# ---- Agent worktrees (CLAUDE.md "How we work") -------------------------------------------------------------------
# Run from any checkout; the worktree always goes under the main checkout. Refuses an existing directory or branch.
worktree-setup:
	@[[ "$(N)" =~ ^[0-9]+$$ && -n "$(BASE)" && "$(PORTS)" =~ ^[0-9]+/[0-9]+$$ ]] || \
	  { echo "Usage: make worktree-setup N=<issue> BASE=<sha> PORTS=<http>/<ha>, e.g. N=115 BASE=b98bff8 PORTS=8100/8143"; exit 2; }
	@set -euo pipefail; \
	common=$$(git -C $(ROOT) rev-parse --path-format=absolute --git-common-dir); main=$$(cd "$$common/.." && pwd); \
	wt=$$main/.claude/worktrees/issue-$(N); \
	[ ! -e "$$wt" ] || { echo "$$wt already exists"; exit 1; }; \
	git -C "$$main" fetch --quiet origin; \
	git -C "$$main" worktree add -b issue-$(N) "$$wt" "$(BASE)"; \
	git -C "$$wt" submodule update --init --recursive; \
	for d in emulator flasher; do \
	  if [ -d "$$main/$$d/node_modules" ] && cmp -s "$$main/$$d/package-lock.json" "$$wt/$$d/package-lock.json"; then \
	    ln -s "$$main/$$d/node_modules" "$$wt/$$d/node_modules"; \
	  else (cd "$$wt/$$d" && npm ci --silent); fi; \
	done; \
	[ ! -d "$$main/.venv" ] || ln -s "$$main/.venv" "$$wt/.venv"; \
	mkdir -p "$$wt/.scratch-$(N)"; \
	p="$(PORTS)"; echo "SIM_HTTP_PORT=$${p%/*} FAKE_HA_PORT=$${p#*/}" > "$$wt/.scratch-$(N)/ports"; \
	echo "issue-$(N) at $$(git -C "$$wt" rev-parse --short HEAD): $$wt (ports: $$(cat "$$wt/.scratch-$(N)/ports"))"
