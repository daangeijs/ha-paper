#!/usr/bin/env python3
"""Line parser tests for monitor.py (make test-tools). No serial port, no pyserial."""
import io
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import monitor as m  # noqa: E402

VECTORS = os.path.join(HERE, "..", "..", "spec", "test-vectors", "improv.json")


class ParseLine(unittest.TestCase):
  def test_x4(self):
    self.assertEqual(m.parse_line("[W][HA] auth failed (401)"), ("W", "HA", "auth failed (401)"))

  def test_arduino_core(self):
    self.assertEqual(m.parse_line("[  1234][E][WiFiGeneric.cpp:1062] _eventCallback(): Reason: 201"),
                     ("E", "WiFiGeneric.cpp", "_eventCallback(): Reason: 201"))

  def test_idf(self):
    self.assertEqual(m.parse_line("\x1b[0;33mW (512) wifi: sta disconnected\x1b[0m"), ("W", "wifi", "sta disconnected"))

  def test_untagged(self):
    self.assertEqual(m.parse_line("rst:0xc (RTC_SW_CPU_RST),boot:0x2b"), (None, None, "rst:0xc (RTC_SW_CPU_RST),boot:0x2b"))


class Heap(unittest.TestCase):
  def test_health_line(self):
    h = m.heap_from("HEAP", "free 182344 min 150112 largest 90100 psram 7650000 · net stack 2208")
    self.assertEqual(h, {"free": 182344, "min": 150112, "largest": 90100, "psram": 7650000, "stack": 2208})

  def test_tls_guard(self):
    self.assertEqual(m.heap_from("HEAP", "largest free internal block 30000 B < 40000 B · skipping TLS to ha"),
                     {"largest": 30000})
    self.assertEqual(m.heap_from("HEAP", "largest free internal block back to 52000 B"), {"largest": 52000})

  def test_qemu_debug(self):
    h = m.heap_from("X4DBG", "heap ok · internal free 200000 min 180000 largest 110000 · 12 crit ops · "
                             "stack HWM (bytes): loopTask=3100 x4net=1800 IDLE0=900")
    self.assertEqual(h, {"free": 200000, "min": 180000, "largest": 110000, "stack": 900, "stack_task": "IDLE0"})

  def test_maintenance_and_boot(self):
    self.assertEqual(m.heap_from("NET", "maintenance restart: x (heap largest 31000 B, min 9000 B)"),
                     {"largest": 31000, "min": 9000})
    self.assertEqual(m.heap_from("MAIN", "PSRAM 8000 KB free · heap 250 KB free"), {"free": 256000})

  def test_not_heap(self):
    self.assertIsNone(m.heap_from("HA", "free 12"))
    self.assertIsNone(m.heap_from(None, "free 12 min 1 largest 3"))

  def test_summary(self):
    s = m.heap_summary({"free": 204800, "largest": 102400, "stack": 900, "stack_task": "IDLE0"}, 215040)
    self.assertEqual(s, "heap · free 200.0 KB (-10.0 KB since start) · largest 100.0 KB · stack headroom 900 B (IDLE0)")


class Improv(unittest.TestCase):
  def setUp(self):
    with open(VECTORS) as f:
      self.v = json.load(f)

  def test_spec_frames_are_one_event_each(self):
    for fr in self.v["frames"]:
      ev = m.Splitter().feed(bytes.fromhex(fr["hex"]))
      self.assertEqual(len(ev), 1, fr["name"])
      self.assertEqual(ev[0][0], "improv", fr["name"])
      self.assertNotIn("checksum", ev[0][1], fr["name"])

  def test_wifi_settings_rpc_hides_password(self):
    fr = next(f for f in self.v["frames"] if f["name"].startswith("Wi-Fi settings"))
    ev = m.Splitter().feed(bytes.fromhex(fr["hex"]))
    self.assertEqual(ev, [("improv", "rpc wifi settings")])

  def test_summaries(self):
    self.assertEqual(m.improv_summary(1, b"\x02"), "state ready")
    self.assertEqual(m.improv_summary(2, b"\x03"), "error unable to connect")
    p = b"\x05x4pro\x0bhttp://x4/"
    self.assertEqual(m.improv_summary(4, bytes([3, len(p)]) + p), "result get info: x4pro | http://x4/")

  def test_frame_between_log_lines_in_pieces(self):
    frame = bytes.fromhex("494d50524f5601010102e20a")
    stream = b"[I][NET] up\r\n" + frame + b"[I][IMPROV] join ok\n[W][HA] x"
    sp, ev = m.Splitter(), []
    for i in range(0, len(stream), 5):
      ev += sp.feed(stream[i:i + 5])
    ev += sp.flush()
    self.assertEqual(ev, [("line", "[I][NET] up"), ("improv", "state ready"), ("line", "[I][IMPROV] join ok"),
                          ("line", "[W][HA] x")])

  def test_frame_glued_to_log_text(self):
    ev = m.Splitter().feed(b"[I][X] partial" + bytes.fromhex("494d50524f5601020100e10a"))
    self.assertEqual(ev, [("line", "[I][X] partial"), ("improv", "error none")])

  def test_bad_checksum(self):
    ev = m.Splitter().feed(bytes.fromhex("494d50524f5601010102e30a") + b"[I][A] b\n")
    self.assertEqual(ev[0][0], "improv")
    self.assertIn("bad checksum", ev[0][1])
    self.assertEqual(ev[-1], ("line", "[I][A] b"))

  def test_flush_keeps_frame_prefix(self):
    sp = m.Splitter()
    self.assertEqual(sp.feed(b"IMPR"), [])
    self.assertEqual(sp.flush(), [])


class Output(unittest.TestCase):
  def test_tag_filter_csv(self):
    out = io.StringIO()
    with tempfile.TemporaryDirectory() as d:
      path = os.path.join(d, "heap.csv")
      mon = m.Monitor("ha, heap", path, stamp=False, color=False, out=out)
      mon.event("line", "[I][NET] wifi up")
      mon.event("line", "[W][HA] reconnect")
      mon.event("line", "[I][HEAP] free 1000 min 900 largest 800 psram 0 · net stack 2000")
      mon.event("improv", "state ready")
      mon.csv_file.close()
      with open(path) as f:
        rows = f.read().splitlines()
    self.assertEqual(out.getvalue().splitlines(), [
        "[W][HA] reconnect",
        "[I][HEAP] free 1000 min 900 largest 800 psram 0 · net stack 2000",
        "heap · free 1.0 KB (+0.0 KB since start) · min 0.9 KB · largest 0.8 KB · psram 0.0 KB · stack headroom 2000 B",
        "[IMPROV] state ready"])
    self.assertEqual(rows[0], "time,free,min,largest,psram,stack,source")
    self.assertTrue(rows[1].endswith(",1000,900,800,0,2000,HEAP"))


if __name__ == "__main__":
  unittest.main()
