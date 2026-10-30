#!/usr/bin/env python3
"""x4flash.py backup -> flash -> restore against a fake esptool on a patterned 16 MB image (issue eink-ha-os#65, make test-tools).

The fake replaces subprocess.run: it parses the esptool command line x4flash.py builds and applies it to an in-memory
flash with the chip's semantics (write-flash erases every 4 KB sector a part touches, then writes it). No serial port,
no esptool install needed.
"""
import contextlib
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import x4flash  # noqa: E402

FLASH_SIZE = 0x1000000
SECTOR = 0x1000
REGIONS = [  # firmware/partitions.csv + bootloader and table; same as flasher/test/fakeChip.ts
  ("bootloader", 0x0, 0x8000),
  ("partition table", 0x8000, 0x9000),
  ("nvs", 0x9000, 0xE000),
  ("otadata", 0xE000, 0x10000),
  ("app0", 0x10000, 0x650000),
  ("app1", 0x650000, 0xC90000),
  ("www", 0xC90000, 0xFD0000),
  ("userdata", 0xFD0000, 0xFF0000),
  ("coredump", 0xFF0000, FLASH_SIZE),
]
SIZES = {"bootloader.bin": 0x5123, "partitions.bin": 0xC00, "boot_app0.bin": 0x2000, "firmware.bin": 0x20345,
         "www.bin": 0x8000}


def patterned_flash():
  """Different, position-dependent bytes per region; no sector is all 0xFF, so every erase shows up."""
  f = bytearray(FLASH_SIZE)
  for tag, (_, start, end) in enumerate(REGIONS):
    for s in range(start, end, SECTOR):
      base = (tag + 1) * 0x11 + (s >> 12) * 7
      f[s:s + SECTOR] = bytes((base + j) & 0x7F for j in range(256)) * (SECTOR // 256)
  f[0] = 0xE9
  return f


def erase_range(addr, length):
  return addr, -(-(addr + -(-length // 4) * 4) // SECTOR) * SECTOR


class FakeEsptool:
  """subprocess.run stand-in for `python -m esptool --chip esp32s3 -p P -b B <command> ...`."""

  def __init__(self, flash):
    self.flash = flash
    self.commands = []
    self.erased = []

  def __call__(self, cmd, capture_output=False, text=False):
    assert cmd[1:3] == ["-m", "esptool"], cmd
    i = 3
    while cmd[i].startswith("-"):  # --chip esp32s3 -p PORT -b BAUD
      i += 2
    op, args = cmd[i], cmd[i + 1:]
    self.commands.append(op)
    out = ""
    if op == "get-security-info":
      out = "Secure Boot: Disabled\nFlash Encryption: Disabled\n"
    elif op == "read-flash":
      addr, size, path = int(args[0], 0), int(args[1], 0), args[2]
      with open(path, "wb") as f:
        f.write(self.flash[addr:addr + size])
    elif op == "write-flash":
      assert not any(a.startswith("-") for a in args), "unexpected write-flash option in %s" % args
      assert len(args) % 2 == 0, args
      for a, path in zip(args[::2], args[1::2]):
        addr = int(a, 0)
        with open(path, "rb") as f:
          data = f.read()
        start, end = erase_range(addr, len(data))
        assert addr % SECTOR == 0 and end <= FLASH_SIZE, (a, path)
        self.erased.append((start, end))
        self.flash[start:end] = b"\xff" * (end - start)
        self.flash[addr:addr + len(data)] = data
    else:
      raise AssertionError("x4flash.py ran an unexpected esptool command: %s" % op)
    return subprocess.CompletedProcess(cmd, 0, out, "")


def changed_regions(a, b, allowed=()):
  """Names of the regions with a byte outside the `allowed` ranges that differs between a and b."""
  bad = []
  for name, start, end in REGIONS:
    at = start
    for s, e in sorted(allowed) + [(end, end)]:
      lo, hi = max(at, start), min(s, end)
      if lo < hi and a[lo:hi] != b[lo:hi]:
        bad.append(name)
        break
      at = max(at, e)
  return bad


class BackupFlashRestore(unittest.TestCase):
  def setUp(self):
    self.tmp = tempfile.TemporaryDirectory()
    self.addCleanup(self.tmp.cleanup)
    self.cwd = os.getcwd()
    os.chdir(self.tmp.name)
    self.addCleanup(os.chdir, self.cwd)
    self.files = {}
    for i, (name, size) in enumerate(SIZES.items()):
      self.files[name] = bytes((j * 7 + i) & 0xFF for j in range(size))
    self.write_release()
    self.original = bytes(patterned_flash())
    self.esptool = FakeEsptool(bytearray(self.original))

  def write_release(self):
    sums = ""
    for name, data in self.files.items():
      with open(name, "wb") as f:
        f.write(data)
      sums += "%s  %s\n" % (hashlib.sha256(data).hexdigest(), name)
    with open("SHA256SUMS", "w") as f:
      f.write(sums)
    with open("manifest.json", "w") as f:
      json.dump({"version": "0.4.0"}, f)

  def run_x4flash(self, *argv):
    with mock.patch.object(sys, "argv", ["x4flash.py", *argv, "--port", "/dev/fake", "--yes"]), \
        mock.patch.object(x4flash.subprocess, "run", self.esptool), \
        contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as err:
      try:
        x4flash.main()
      except SystemExit as e:
        if e.code:
          raise AssertionError("x4flash.py exited %s: %s" % (e.code, err.getvalue().strip()))

  def test_backup_flash_restore_round_trip(self):
    self.run_x4flash()
    self.assertEqual(self.esptool.commands, ["get-security-info", "read-flash", "write-flash"])

    # (a) the backup is the whole flash, byte for byte, with a matching sidecar
    backups = sorted(os.listdir("backups"))
    self.assertEqual(len(backups), 2, backups)  # x4pro_stock_YYYYMMDD.bin + .sha256, no .part left over
    path = os.path.join("backups", backups[0])
    with open(path, "rb") as f:
      self.assertTrue(f.read() == self.original, "backup differs from the flash")
    with open(path + ".sha256") as f:
      self.assertEqual(f.read().split(), [hashlib.sha256(self.original).hexdigest(), backups[0]])

    # (b) only the sectors of the five parts were erased; NVS, app1, userdata, coredump are untouched
    planned = [erase_range(off, len(self.files[name])) for off, name in x4flash.PARTS]
    self.assertEqual(planned, [(0x0, 0x6000), (0x8000, 0x9000), (0xE000, 0x10000), (0x10000, 0x31000),
                               (0xC90000, 0xC98000)])
    self.assertEqual(self.esptool.erased, planned)
    self.assertEqual(changed_regions(self.original, self.esptool.flash, planned), [])
    for off, name in x4flash.PARTS:
      data = self.files[name]
      self.assertTrue(self.esptool.flash[off:off + len(data)] == data, name)
    self.assertEqual(changed_regions(self.original, self.esptool.flash),
                     ["bootloader", "partition table", "otadata", "app0", "www"])

    # a second flash keeps the first backup instead of reading the (now HA Paper) flash again
    self.esptool.commands.clear()
    self.run_x4flash()
    self.assertEqual(self.esptool.commands, ["get-security-info", "write-flash"])

    # (c) restoring the backup gives the original image back
    self.run_x4flash("restore", path)
    self.assertTrue(bytes(self.esptool.flash) == self.original, "restored flash differs from the original")

  def test_www_reaching_userdata_writes_nothing(self):
    self.files["www.bin"] = b"\x00" * (0xFD0000 - 0xC90000 + 1)
    self.write_release()
    with self.assertRaisesRegex(AssertionError, "userdata"):
      self.run_x4flash("--skip-backup")
    self.assertEqual(self.esptool.commands, [])
    self.assertTrue(bytes(self.esptool.flash) == self.original)

  def test_damaged_backup_is_not_restored(self):
    os.makedirs("backups")
    path = os.path.join("backups", "x4pro_stock_20261016.bin")
    with open(path, "wb") as f:
      f.write(self.original)
    with open(path + ".sha256", "w") as f:
      f.write("%s  x4pro_stock_20261016.bin\n" % ("0" * 64))
    with self.assertRaisesRegex(AssertionError, "damaged"):
      self.run_x4flash("restore", path)
    self.assertEqual(self.esptool.commands, [])


if __name__ == "__main__":
  unittest.main()
