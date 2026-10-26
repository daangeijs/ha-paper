# Xteink X4 Pro hardware (from freeink-sdk BoardConfig `XTEINK_X4_PRO`, verified on hardware by its authors)

Source: https://github.com/Free-Ink/freeink-sdk (docs/xteink-x4pro-support.md, libs/hardware/BoardConfig/include/BoardConfig.h), CrossPoint Reader `[env:x4pro]`.

| Block | Detail |
|---|---|
| MCU | ESP32-S3, 16 MB flash (DIO), 8 MB octal PSRAM (`esp32-s3-devkitc1-n16r8`, `memory_type=dio_opi`) |
| USB | native USB-Serial/JTAG GPIO19/20, via magnetic pogo → USB-C adapter (data capable) |
| Display | 4.3" 800×480 landscape. Controller SSD1677 (early) or UC8179/UC8279 (later), auto-detected. SPI: SCLK 12, MOSI 11, CS 13, DC 18, RST 14, BUSY 6 (busy HIGH). SSD1677 full `0x22=0xF7`, fast `0x22=0xFC`. 4-gray via two RAM planes |
| Touch | GT911 I2C 0x5D (alt 0x14), SDA 39, SCL 38, 400 kHz, INT 10, RST 4. GPIO2 LOW + GPIO1 HIGH = touch power. swapXY. Home key = GT911 reg 0x814E bit 0x10 |
| Keys | active-low INPUT_PULLUP: Left/Prev GPIO0 (boot strap), Right/Next GPIO7, Power GPIO3. Reset (chip reset, not readable) is the small button on the top edge next to the microSD slot: on USB it reboots, on battery it switches the board off (the GPIO1 latch drops). Recovery (Xteink FAQ): Reset, then hold Power. Positions (portrait): Power = small button at the top of the right side, Next below it, Prev on the left, Home = touch key at the bottom |
| Front light | cool GPIO8, warm GPIO9, LEDC 25 kHz 10-bit, active HIGH |
| Battery | CW2017 fuel gauge I2C 0x63 (needs 80-byte BATINFO profile), SoC reg 0x04, voltage 0x02/0x03; charging GPIO21 high |
| RTC | BM8563 I2C 0x51 |
| microSD | SDMMC 1-bit CLK 41 CMD 42 DAT0 40; GPIO5 power enable active LOW |

## Flashing
Unlock: units bought at xteink.com are unlocked. Third-party (AliExpress) X3/X4 units can be USB-locked by eFuse; X4 Pro lock status undocumented — check with `esptool chip-id` first.

1. Connect pogo → USB-C adapter. No buttons: esptool resets the chip into the ROM bootloader over USB-Serial/JTAG
   (verified with `make flash` and the browser flasher, 2026-10-26). Won't connect: replug USB and retry.
2. Back up stock firmware (16 MB):  `make backup PORT=/dev/cu.usbmodemXXXX`
3. Flash full image (bootloader + partitions + otadata erase + app + www; never NVS or userdata): `make flash PORT=...`
   Stock firmware boots app1; full flash resets otadata so ours boots.
4. Restore stock: `esptool --chip esp32s3 -p PORT write-flash 0x0 backups/x4pro_stock.bin`
