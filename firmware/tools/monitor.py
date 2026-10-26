#!/usr/bin/env python3
"""HA Paper serial log monitor (make monitor PORT=…).

Usage:  monitor.py PORT [--tag HA,NET] [--csv heap.csv] [--no-time] [--no-color] [--baud 115200]

- Colours by level: [E] red, [W] yellow, [I] default. Also understands ESP-IDF (`E (123) tag: …`) and Arduino core
  (`[   123][E][file.cpp:12] fn(): …`) lines.
- --tag: only lines with one of these tags (case-insensitive); heap summaries and Improv frames always show.
- Improv Wi-Fi frames (`IMPROV` + version, type, length, data, checksum; firmware core/improv) are shown as one line.
- Heap lines ([I][HEAP] free … every 60 s from net/health, the [X4DBG] line of env:x4qemu_debug, the HEAP/NET warnings,
  the MAIN boot line) print a one-line summary; --csv appends free/min/largest internal heap to a file (soak tests).
- Reconnects when the USB-Serial/JTAG port disappears (reset, re-flash, cable) and comes back.

Needs only pyserial (installed with esptool / PlatformIO). Panic backtraces are not decoded: use `make monitor-pio`.
"""
import argparse
import csv
import os
import re
import sys
import time

COLORS = {"E": "\033[31m", "W": "\033[33m", "SUM": "\033[36m", "IMPROV": "\033[35m"}
RESET = "\033[0m"

_X4 = re.compile(r"^\[([EWID])\]\[([^\]]+)\]\s?(.*)$")
_ARDUINO = re.compile(r"^\[\s*\d+\]\[([EWIDV])\]\[([^\]:]+)(?::\d+)?\]\s?(.*)$")
_IDF = re.compile(r"^(?:\x1b\[[0-9;]*m)?([EWIDV]) \(\d+\) ([^:]+): (.*?)(?:\x1b\[0m)?$")


def parse_line(text):
  """→ (level, tag, message); level/tag None for untagged lines (ROM boot output, panics)."""
  for rx in (_X4, _ARDUINO, _IDF):
    m = rx.match(text)
    if m:
      return m.group(1), m.group(2).strip(), m.group(3)
  return None, None, text


def _num(rx, s):
  m = re.search(rx, s)
  return int(m.group(1)) if m else None


def heap_from(tag, msg):
  """Heap figures (bytes) from a log line, or None. Keys: free, min, largest, psram, stack (only those present)."""
  if tag is None:
    return None
  t = tag.upper()
  h = {}
  if t == "HEAP" and msg.startswith("free "):   # net/health, every 60 s
    h = {k: _num(r"\b%s (\d+)" % k, msg) for k in ("free", "min", "largest", "psram")}
    h["stack"] = _num(r"net stack (\d+)", msg)
  elif t == "HEAP":   # TLS guard: "largest free internal block N B …"
    h = {"largest": _num(r"block (?:back to )?(\d+) B", msg)}
  elif t == "X4DBG" and "heap ok" in msg:   # env:x4qemu_debug
    h = {"free": _num(r"internal free (\d+)", msg), "min": _num(r" min (\d+)", msg),
         "largest": _num(r"largest (\d+)", msg)}
    hwm = re.findall(r"(\S+)=(\d+)", msg.split("stack HWM", 1)[-1])
    if hwm:
      h["stack"] = min(int(v) for _, v in hwm)
      h["stack_task"] = min(hwm, key=lambda kv: int(kv[1]))[0]
  elif t == "NET" and "maintenance restart" in msg:
    h = {"largest": _num(r"largest (\d+) B", msg), "min": _num(r"min (\d+) B", msg)}
  elif t == "MAIN" and "heap" in msg:
    kb = _num(r"heap (\d+) KB", msg)
    h = {"free": kb * 1024 if kb is not None else None}
  h = {k: v for k, v in h.items() if v is not None}
  return h or None


def _kb(v):
  return "%.1f KB" % (v / 1024.0)


def heap_summary(h, first_free=None):
  parts = []
  if "free" in h:
    d = "" if first_free is None else " (%+.1f KB since start)" % ((h["free"] - first_free) / 1024.0)
    parts.append("free " + _kb(h["free"]) + d)
  for k in ("min", "largest", "psram"):
    if k in h:
      parts.append("%s %s" % (k, _kb(h[k])))
  if "stack" in h:
    parts.append("stack headroom %u B%s" % (h["stack"], " (" + h["stack_task"] + ")" if "stack_task" in h else ""))
  return "heap · " + " · ".join(parts)


# --- Improv Wi-Fi serial (https://www.improv-wifi.com/serial/) ---
_HDR = b"IMPROV"
_STATES = {0: "stopped", 1: "awaiting authorization", 2: "ready", 3: "provisioning", 4: "provisioned"}
_ERRORS = {0: "none", 1: "invalid RPC", 2: "unknown RPC", 3: "unable to connect", 4: "not authorized",
           5: "bad hostname", 0xFF: "unknown"}
_CMDS = {1: "wifi settings", 2: "get state", 3: "get info", 4: "get networks", 5: "hostname", 6: "device name",
         7: "network state"}


def _strings(b):
  out, i = [], 0
  while i < len(b):
    n = b[i]
    out.append(b[i + 1:i + 1 + n].decode("utf-8", "replace"))
    i += 1 + n
  return out


def improv_summary(ftype, data):
  if ftype == 0x01 and data:
    return "state " + _STATES.get(data[0], "0x%02x" % data[0])
  if ftype == 0x02 and data:
    return "error " + _ERRORS.get(data[0], "0x%02x" % data[0])
  if ftype in (0x03, 0x04) and data:
    cmd = _CMDS.get(data[0], "0x%02x" % data[0])
    if ftype == 0x03:
      return "rpc " + cmd   # host → device; only seen on a loopback. Payload not shown (wifi settings hold the password)
    s = _strings(data[2:2 + data[1]]) if len(data) > 1 else []
    return "result " + cmd + (": " + " | ".join(s) if s else "")
  return "type 0x%02x, %d B" % (ftype, len(data))


class Splitter:
  """Bytes in → ("line", str) and ("improv", summary) events. Improv frames are binary and end in "\\n"; they can
  start mid-buffer (another task's log line ends just before)."""

  def __init__(self):
    self.buf = bytearray()

  def _frame_start(self):
    """First "IMPROV" followed by version 1 and a known type (or too few bytes to tell); log text such as
    "[I][IMPROV] join ok" is not a frame."""
    i = self.buf.find(_HDR)
    while i >= 0:
      if len(self.buf) < i + 8 or (self.buf[i + 6] == 1 and 1 <= self.buf[i + 7] <= 4):
        return i
      i = self.buf.find(_HDR, i + 1)
    return -1

  def feed(self, data):
    self.buf += data
    out = []
    while True:
      i = self._frame_start()
      nl = self.buf.find(b"\n")
      if i < 0 or (0 <= nl < i):
        if nl < 0:
          break
        line = bytes(self.buf[:nl])
        del self.buf[:nl + 1]
        out.append(("line", line.rstrip(b"\r").decode("utf-8", "replace")))
        continue
      if len(self.buf) < i + 9:   # not sure yet that this is a frame: keep the text before it too
        break
      if i > 0:   # text before the frame on the same line
        pre = bytes(self.buf[:i]).rstrip(b"\r")
        if pre.strip():
          out.append(("line", pre.decode("utf-8", "replace")))
        del self.buf[:i]
      n = self.buf[8]
      end = 9 + n + 1
      if len(self.buf) < end:
        break
      frame = bytes(self.buf[:end])
      if sum(frame[:-1]) & 0xFF != frame[-1]:
        out.append(("improv", "bad checksum (type 0x%02x, %d B)" % (frame[7], n)))
        del self.buf[:len(_HDR)]
        continue
      del self.buf[:end]
      if self.buf[:1] == b"\n":
        del self.buf[:1]
      out.append(("improv", improv_summary(frame[7], frame[9:9 + n])))
    return out

  def flush(self):
    """Partial line after a quiet period (prompt, panic without newline). Keeps a possible frame start."""
    if not self.buf or self._frame_start() >= 0 or any(self.buf.endswith(_HDR[:k]) for k in range(1, len(_HDR))):
      return []
    line = bytes(self.buf).decode("utf-8", "replace")
    self.buf.clear()
    return [("line", line)]


class Monitor:
  def __init__(self, tags=None, csv_path=None, stamp=True, color=True, out=sys.stdout):
    self.tags = {t.strip().upper() for t in tags.split(",") if t.strip()} if tags else None
    self.stamp, self.color, self.out = stamp, color, out
    self.first_free = None
    self.csv_file = self.csv = None
    if csv_path:
      new = not os.path.exists(csv_path) or os.path.getsize(csv_path) == 0
      self.csv_file = open(csv_path, "a", newline="")
      self.csv = csv.writer(self.csv_file)
      if new:
        self.csv.writerow(["time", "free", "min", "largest", "psram", "stack", "source"])
      self.csv_file.flush()

  def _emit(self, text, color_key=None):
    pre = time.strftime("%H:%M:%S") + ".%03d " % (int(time.time() * 1000) % 1000) if self.stamp else ""
    if self.color and color_key in COLORS:
      text = COLORS[color_key] + text + RESET
    self.out.write(pre + text + "\n")
    self.out.flush()

  def event(self, kind, text):
    if kind == "improv":
      self._emit("[IMPROV] " + text, "IMPROV")
      return
    level, tag, msg = parse_line(text)
    if self.tags is None or (tag and tag.upper() in self.tags):
      self._emit(text, level)
    h = heap_from(tag, msg)
    if h:
      if self.first_free is None and "free" in h and tag.upper() == "HEAP":
        self.first_free = h["free"]
      self._emit(heap_summary(h, self.first_free), "SUM")
      if self.csv and ("free" in h or "largest" in h):
        self.csv.writerow([time.strftime("%Y-%m-%dT%H:%M:%S")] +
                          [h.get(k, "") for k in ("free", "min", "largest", "psram", "stack")] + [tag])
        self.csv_file.flush()

  def info(self, text):
    self._emit("-- " + text, "W")


def run(port, baud, mon):
  import serial   # pyserial; imported here so the parser tests run without it

  sp = Splitter()
  waiting = False
  while True:
    try:
      s = serial.Serial()
      s.port, s.baudrate, s.timeout = port, baud, 0.2
      s.dtr = s.rts = False   # USB-Serial/JTAG: DTR/RTS toggles on open would reset the chip
      s.open()
    except (serial.SerialException, OSError):
      if not waiting:
        mon.info("waiting for %s" % port)
        waiting = True
      time.sleep(0.5)
      continue
    mon.info("connected to %s" % port)
    waiting = False
    try:
      while True:
        data = s.read(4096)
        evs = sp.feed(data) if data else sp.flush()
        for kind, text in evs:
          mon.event(kind, text)
    except (serial.SerialException, OSError):
      for kind, text in sp.flush():
        mon.event(kind, text)
      mon.info("%s gone (reset or re-enumeration), reconnecting" % port)
      waiting = True
    finally:
      try:
        s.close()
      except Exception:
        pass


def main(argv=None):
  ap = argparse.ArgumentParser(description="HA Paper serial log monitor")
  ap.add_argument("port", help="e.g. /dev/cu.usbmodem1101 (macOS), /dev/ttyACM0 (Linux)")
  ap.add_argument("--baud", type=int, default=115200)
  ap.add_argument("--tag", help="comma-separated tags to show, e.g. HA,NET")
  ap.add_argument("--csv", help="append heap samples to this CSV file")
  ap.add_argument("--no-time", action="store_true", help="no host timestamps")
  ap.add_argument("--no-color", action="store_true")
  a = ap.parse_args(argv)
  color = not a.no_color and sys.stdout.isatty() and "NO_COLOR" not in os.environ
  mon = Monitor(a.tag, a.csv, not a.no_time, color)
  try:
    run(a.port, a.baud, mon)
  except KeyboardInterrupt:
    pass
  finally:
    if mon.csv_file:
      mon.csv_file.close()


if __name__ == "__main__":
  main()
