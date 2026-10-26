#!/usr/bin/env python3
"""Flash an HA Paper release onto an Xteink X4 Pro over USB. Shipped as x4flash.py with every GitHub release.

Run it from the folder with the downloaded release files (needs `pip install esptool`):

    python3 x4flash.py              chip check, back up the stock firmware (first time), flash
    python3 x4flash.py restore F    write a backup made by this script (or `make backup`) back
    python3 x4flash.py --port COM3  pick the port yourself (default: the one Espressif USB device found)

Writes the five parts at their own offsets and never touches NVS (0x9000): that keeps Wi-Fi, the Home Assistant link
and the OEM `hw_calib` panel id, which exists nowhere else. It never touches `userdata` (0xFD0000) either, so screens
and settings survive a re-flash. No erase-flash, no merged 0x0 image.
"""
import argparse
import datetime
import glob
import hashlib
import json
import os
import subprocess
import sys

PARTS = [  # (offset, file) — firmware/partitions.csv, flasher/src/layout.ts
    (0x0, "bootloader.bin"),
    (0x8000, "partitions.bin"),
    (0xE000, "boot_app0.bin"),
    (0x10000, "firmware.bin"),
    (0xC90000, "www.bin"),  # partition www ends at 0xFD0000
]
PROTECTED_TOP = (0xFD0000, 0x1000000)  # userdata + coredump: never written here
FLASH_SIZE = 16 * 1024 * 1024
ESPRESSIF_VID = 0x303A
BACKUPS = "backups"


def die(msg):
    print("\n" + msg, file=sys.stderr)
    sys.exit(1)


def esptool(port, *args, capture=False):
    # -b as in the Makefile: a UART bridge needs it for the ~3 min backup; native USB ignores it.
    cmd = [sys.executable, "-m", "esptool", "--chip", "esp32s3", "-p", port, "-b", "921600", *args]
    print("$ esptool " + " ".join(cmd[3:]))
    r = subprocess.run(cmd, capture_output=capture, text=True)
    if capture:
        print(r.stdout, end="")
        print(r.stderr, end="", file=sys.stderr)
    if r.returncode != 0:
        die("esptool failed. Replug USB and run this again. (Port busy? Close other serial monitors.)")
    return r.stdout if capture else ""


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def find_port():
    try:
        from serial.tools import list_ports  # pyserial, installed with esptool
    except ImportError:
        die("esptool is not installed: run `pip install esptool` (Windows: `py -m pip install esptool`). If pip says "
            "externally-managed-environment: `python3 -m venv x4env && x4env/bin/pip install esptool`, then run "
            "`x4env/bin/python x4flash.py`.")
    ports = [p.device for p in list_ports.comports() if p.vid == ESPRESSIF_VID]
    if len(ports) == 1:
        return ports[0]
    if not ports:
        die("No Espressif USB device found. Connect the X4 Pro with the pogo adapter and a data USB-C cable, or pass "
            "--port. No buttons needed; if it still isn't found, replug USB.")
    die("Several Espressif devices found (%s): pass --port." % ", ".join(ports))


def check_release():
    if not os.path.isfile("SHA256SUMS"):
        die("Run this from the folder with the release files (SHA256SUMS, *.bin, manifest.json).")
    sums = {}
    for line in open("SHA256SUMS"):
        digest, name = line.split()
        sums[name.lstrip("*")] = digest
    for _, name in PARTS:
        if not os.path.isfile(name):
            die("Missing %s: download all files of the release into this folder." % name)
        if sha256(name) != sums.get(name):
            die("%s does not match SHA256SUMS: download it again." % name)
    for offset, name in PARTS:
        end = offset + (os.path.getsize(name) + 0xFFF) // 0x1000 * 0x1000   # whole 4 KB sectors get erased
        if offset < PROTECTED_TOP[1] and end > PROTECTED_TOP[0]:
            die("%s would overwrite userdata + coredump (screens, settings): wrong release files? Nothing was written."
                % name)
    version = json.load(open("manifest.json"))["version"] if os.path.isfile("manifest.json") else "?"
    print("Release files OK (HA Paper %s)." % version)
    return version


def chip_check(port):
    out = esptool(port, "get-security-info", capture=True)
    if "Secure Boot: Enabled" in out or "Flash Encryption: Enabled" in out:
        die("Secure boot or flash encryption is enabled on this unit: it cannot run HA Paper. Nothing was written.")
    if "Secure Boot: Disabled" not in out or "Flash Encryption: Disabled" not in out:
        die("Could not read the secure boot / flash encryption state from the output above. Nothing was written.")
    print("Chip check OK: no secure boot, no flash encryption.")


def backup(port):
    existing = sorted(glob.glob(os.path.join(BACKUPS, "x4pro_stock_*.bin")))
    if existing:
        print("Backup already here: %s (not reading the flash again)." % existing[-1])
        return
    os.makedirs(BACKUPS, exist_ok=True)
    out = os.path.join(BACKUPS, "x4pro_stock_%s.bin" % datetime.date.today().strftime("%Y%m%d"))
    print("Backing up the full 16 MB flash to %s (takes ~3 min) ..." % out)
    esptool(port, "read-flash", "0", str(FLASH_SIZE), out + ".part")
    if os.path.getsize(out + ".part") != FLASH_SIZE:
        die("Backup has the wrong size; nothing was written. Try again.")
    os.replace(out + ".part", out)
    with open(out + ".sha256", "w") as f:
        f.write("%s  %s\n" % (sha256(out), os.path.basename(out)))
    print("Backup OK: %s. Keep this file: it is the only way back to the stock firmware." % out)


def flash(port, version):
    args = ["write-flash"]
    for offset, name in PARTS:
        args += ["0x%x" % offset, name]
    esptool(port, *args)
    print("\nHA Paper %s flashed. The display restarts by itself. Replug USB if it doesn't start." % version)


def restore(port, path):
    if not os.path.isfile(path) or os.path.getsize(path) != FLASH_SIZE:
        die("%s is not a full 16 MB backup." % path)
    side = path + ".sha256"
    if os.path.isfile(side) and open(side).read().split()[0] != sha256(path):
        die("%s does not match %s: the backup is damaged." % (path, side))
    esptool(port, "write-flash", "0x0", path)
    print("\nStock firmware restored. Replug USB if it doesn't start.")


def confirm(question, yes):
    if yes:
        return
    if input(question + " [y/N] ").strip().lower() not in ("y", "yes"):
        die("Stopped. Nothing was written.")


def main():
    p = argparse.ArgumentParser(description="Flash HA Paper onto an Xteink X4 Pro (keeps NVS).")
    p.add_argument("command", nargs="?", default="flash", choices=["flash", "restore"])
    p.add_argument("file", nargs="?", help="restore: the backup to write")
    p.add_argument("--port", help="serial port, e.g. /dev/cu.usbmodem1101, /dev/ttyACM0, COM3")
    p.add_argument("--skip-backup", action="store_true", help="flash without a stock backup (not recommended)")
    p.add_argument("--yes", "-y", action="store_true", help="don't ask before writing")
    a = p.parse_args()

    if a.command == "restore":
        if not a.file:
            die("Usage: x4flash.py restore backups/x4pro_stock_YYYYMMDD.bin")
        port = a.port or find_port()
        confirm("Write %s to the display on %s? This replaces HA Paper." % (a.file, port), a.yes)
        restore(port, a.file)
        return

    version = check_release()
    port = a.port or find_port()
    print("Display on %s." % port)
    chip_check(port)
    if not a.skip_backup:
        backup(port)
    confirm("Flash HA Paper %s to %s? (Wi-Fi, HA link, screens, settings and the panel id are kept.)" % (version, port), a.yes)
    flash(port, version)


if __name__ == "__main__":
    main()
