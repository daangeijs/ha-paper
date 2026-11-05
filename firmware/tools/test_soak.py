"""Tests for soak.py (make test-tools). Fixtures: fixtures/soak/sim_*.json, recorded from `npm run device-sim`."""
import contextlib
import copy
import datetime
import http.server
import io
import json
import os
import tempfile
import threading
import unittest

import soak

FX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "soak")
TZ = datetime.timezone(datetime.timedelta(hours=2))
T0 = datetime.datetime(2026, 10, 16, 9, 0, 0, tzinfo=TZ)


def fx(name):
    with open(os.path.join(FX, "sim_" + name + ".json")) as f:
        return json.load(f)


def at(minutes):
    return T0 + datetime.timedelta(minutes=minutes)


def with_uptime(status, diag, uptime):
    s, d = copy.deepcopy(status), copy.deepcopy(diag)
    s["uptime_s"] = d["uptime_s"] = uptime
    return s, d


def prev_of(when, status, diag):
    return {"t": when.timestamp(), "uptime": status["uptime_s"], "boots": diag["boots"]}


class Rows(unittest.TestCase):
    def test_first_poll(self):
        r = soak.make_row(T0, fx("status_boot"), fx("diag_boot"), None)
        self.assertEqual(list(r), soak.COLUMNS)
        self.assertEqual((r["state"], r["uptime_s"], r["firmware"], r["battery"], r["source"], r["charging"]),
                         ("ok", "28", "0.3.0", "76", "battery", "0"))
        self.assertEqual((r["free_heap"], r["heap_min_free"], r["heap_largest_block"]), ("182344", "141020", "110592"))
        self.assertEqual((r["home_assistant"], r["ha_report"], r["reset_reason"]), ("linked", "not_admin", "POWERON"))
        self.assertEqual((r["new_boots"], r["rssi"], r["next_wake_epoch"], r["power_mode"]), ("", "", "", "awake"))
        self.assertEqual(r["time"], "2026-10-16T09:00:00+02:00")

    def test_same_boot(self):
        s, d = fx("status_boot"), fx("diag_boot")
        s2, d2 = with_uptime(s, d, 28 + 300)
        self.assertEqual(soak.make_row(at(5), s2, d2, prev_of(T0, s, d))["new_boots"], "")

    def test_panic_with_empty_ring_before(self):
        s, d = fx("status_boot"), fx("diag_boot")
        r = soak.make_row(at(1), fx("status_after_panic"), fx("diag_after_panic"), prev_of(T0, s, d))
        self.assertEqual((r["new_boots"], r["reset_reason"]), ("PANIC", "PANIC"))

    def test_deepsleep_wake_found_in_ring(self):
        s, d = fx("status_after_panic"), fx("diag_after_panic")
        r = soak.make_row(at(15), fx("status_after_deepsleep"), fx("diag_after_deepsleep"), prev_of(T0, s, d))
        self.assertEqual(r["new_boots"], "DEEPSLEEP")

    def test_reboot_missed_by_uptime_alone(self):
        # 2 h unanswered, then uptime is larger than before but the boot time moved: a reboot in between
        s, d = fx("status_boot"), fx("diag_after_panic")
        s1, d1 = with_uptime(s, d, 600)
        s2, d2 = with_uptime(s, d, 1800)
        d2["boots"][0]["uptime_s"] = 1800
        r = soak.make_row(at(120), s2, d2, prev_of(T0, s1, d1))
        self.assertEqual(r["new_boots"], "PANIC")   # ring head is the same entry shape; fallback takes boots[0]

    def test_several_boots_oldest_first(self):
        s, d = with_uptime(fx("status_boot"), fx("diag_boot"), 500)
        d["boots"] = [{"reason": "SW", "version": "0.3.0", "uptime_s": 490, "last_seen": None}]
        s2, d2 = with_uptime(s, d, 20)
        d2["boots"] = [{"reason": "TASK_WDT", "version": "0.3.0", "uptime_s": 20},
                       {"reason": "PANIC", "version": "0.3.0", "uptime_s": 60},
                       {"reason": "SW", "version": "0.3.0", "uptime_s": 700}]
        self.assertEqual(soak.make_row(at(5), s2, d2, prev_of(T0, s, d))["new_boots"], "PANIC;TASK_WDT")

    def test_ring_cleared_falls_back_to_reset_reason(self):
        s, d = with_uptime(fx("status_boot"), fx("diag_boot"), 500)
        s2, d2 = with_uptime(s, d, 10)
        d2["reset_reason"] = "SW"
        self.assertEqual(soak.make_row(at(5), s2, d2, prev_of(T0, s, d))["new_boots"], "SW")

    def test_unreachable(self):
        st = fx("status_boot")
        self.assertEqual(soak.unreachable_row(at(5), "timed out", st)["state"], "down")
        st["power"]["nextWakeEpoch"] = int(at(15).timestamp())
        self.assertEqual(soak.unreachable_row(at(5), "timed out", st)["state"], "asleep")
        self.assertEqual(soak.unreachable_row(at(60), "timed out", st)["state"], "down")   # past wake + 10 min
        self.assertEqual(soak.unreachable_row(at(5), "x", None)["state"], "down")


def day_rows():
    """09:00 boot on battery, HA drop at 10:00, 3 polls unanswered then a DEEPSLEEP wake, unanswered then PANIC."""
    s, d = fx("status_boot"), fx("diag_after_panic")   # ring [PANIC]: the DEEPSLEEP wake finds it again
    rows, prev = [], None

    def ok(m, uptime, battery, ha="linked", status=None, diag=None, heap=None):
        nonlocal prev
        st, dg = with_uptime(status or s, diag or d, uptime)
        st["battery"], st["home_assistant"] = battery, ha
        if heap:
            st["free_heap"], st["heap_largest_block"] = heap
        rows.append(soak.make_row(at(m), st, dg, prev))
        prev = prev_of(at(m), st, dg)
        return st

    last = None
    for i in range(12):                           # 09:00–09:55
        last = ok(5 * i, 28 + 300 * i, 80 - i // 4)
    last = ok(60, 28 + 3600, 77, ha="offline", heap=(150000, 90000))
    last = ok(65, 28 + 3900, 77)
    for m in (70, 75, 80):
        rows.append(soak.unreachable_row(at(m), "timed out", last))
    ok(85, 30, 76, status=fx("status_after_deepsleep"), diag=fx("diag_after_deepsleep"))
    rows.append(soak.unreachable_row(at(90), "connection refused", last))
    ok(95, 4, 76, status=fx("status_after_panic"), diag=fx("diag_after_panic"))
    return rows


class Summary(unittest.TestCase):
    def test_day(self):
        rows = day_rows()
        self.assertEqual((rows[17]["new_boots"], rows[19]["new_boots"]), ("DEEPSLEEP", "PANIC"))
        md = soak.summarize(rows, "2026-10-16")
        self.assertIn("20 polls 09:00 → 10:35: 16 ok, 4 unanswered, 0 HTTP error. Firmware: 0.3.0.", md)
        self.assertIn("| DEEPSLEEP | 1 |  |", md)
        self.assertIn("| PANIC | 1 | crash |", md)
        self.assertIn("| 06–12 | 150000 | 141020 | 90000 |", md)
        self.assertIn("80 % → 76 % (min 76 %)", md)
        self.assertIn("Disconnects (linked → other): 1; not linked for ~5m00s.", md)
        self.assertIn("| 10:10:00 | 10:25:00 | 15m00s | asleep |", md)   # woke with DEEPSLEEP: a sleep, not an outage
        self.assertIn("| 10:30:00 | 10:35:00 | 5m00s | down |", md)     # came back after a PANIC

    def test_battery_rate(self):
        rows = []
        for h in range(5):                        # 1 %/h on battery, then an hour on USB that must not count
            s, d = with_uptime(fx("status_boot"), fx("diag_boot"), 28 + 3600 * h)
            s["battery"] = 80 - h
            rows.append(soak.make_row(T0 + datetime.timedelta(hours=h), s, d, None))
        rows.append(dict(rows[-1], time=(T0 + datetime.timedelta(hours=5)).isoformat(), source="usb", battery="90"))
        self.assertIn("80 % → 90 % (min 76 %), 24.0 %/day over 4h00m on battery. Source: battery, usb.",
                      soak.summarize(rows, "2026-10-16"))

    def test_other_day_and_still_unreachable(self):
        rows = day_rows()[:18] + [soak.unreachable_row(at(90), "timed out", None)]
        self.assertEqual(soak.summarize(rows, "2026-10-17"), "# Soak 2026-10-17\n\nNo polls.\n")
        self.assertIn("| 10:30:00 | (still) | 0m00s+ | down |", soak.summarize(rows, "2026-10-16"))

    def test_csv_roundtrip_and_summarize_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "soak.csv")
            import csv
            with open(p, "w", newline="") as f:
                w = csv.DictWriter(f, fieldnames=soak.COLUMNS)
                w.writeheader()
                w.writerows(day_rows())
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(soak.main(["--summarize", p]), 0)
            self.assertEqual(out.getvalue(), soak.summarize(day_rows(), "2026-10-16"))


class Collector(unittest.TestCase):
    """End to end against a stub display: bearer checked, token never in the output."""
    TOKEN = "x4_soaktesttokenxxxxxxxxxxxxxxxx"

    def test_broken_answers_are_down_not_a_crash(self):
        """Empty reply (curl exit 52) and a body cut short: a down row, the collector keeps running."""
        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/api/v1/status":
                    self.close_connection = True   # no status line at all
                    return
                self.send_response(200); self.send_header("Content-Length", "1000"); self.end_headers()
                self.wfile.write(b'{"boots": [')

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = "http://127.0.0.1:%d" % srv.server_address[1]
        try:
            self.assertEqual(soak.poll(base, self.TOKEN, 5)[2][0], "down")
            self.assertEqual(soak.poll(base + "/x", self.TOKEN, 5)[2][0], "down")   # 200 with a cut-short body
        finally:
            srv.shutdown()

    def test_two_polls(self):
        token, seen = self.TOKEN, []

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append((self.path, self.headers.get("Authorization")))
                if self.headers.get("Authorization") != "Bearer " + token:
                    self.send_response(401); self.end_headers(); return
                body = json.dumps(fx("status_boot" if self.path == "/api/v1/status" else "diag_boot")).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        url = "127.0.0.1:%d" % srv.server_address[1]
        old = os.environ.get("X4_TOKEN")
        try:
            with tempfile.TemporaryDirectory() as tmp:
                out = io.StringIO()
                os.environ["X4_TOKEN"] = token
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                    rc = soak.main(["--url", url, "--interval", "1", "--hours", str(1.5 / 3600), "--out", tmp])
                self.assertEqual(rc, 0)
                rows = soak.read_csv(os.path.join(tmp, "soak.csv"))
                self.assertEqual([r["state"] for r in rows], ["ok", "ok"])
                files = [os.path.join(tmp, f) for f in os.listdir(tmp)]
                self.assertTrue(any(f.endswith(".md") for f in files))
                for f in files:
                    with open(f) as fh:
                        self.assertNotIn(token, fh.read())
                self.assertNotIn(token, out.getvalue())
                self.assertEqual(seen[0], ("/api/v1/status", "Bearer " + token))

                os.environ["X4_TOKEN"] = "x4_wrong"
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                    self.assertEqual(soak.main(["--url", url, "--out", tmp]), 2)   # rejected on the first poll
                self.assertNotIn("x4_wrong", out.getvalue())
        finally:
            srv.shutdown()
            srv.server_close()
            if old is None:
                os.environ.pop("X4_TOKEN", None)
            else:
                os.environ["X4_TOKEN"] = old


class Probe(unittest.TestCase):
    """eink-ha-os#227: the name and the IP are checked separately; a dead name with a live IP is its own finding."""

    def test_name_and_ip(self):
        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *a):
                pass

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        port = srv.server_address[1]
        try:
            c, ip = soak.probe("http://localhost:%d" % port, "x4_t", 3, None)
            self.assertEqual(ip, "127.0.0.1")
            self.assertTrue(c["name_dns"].startswith("ok "))
            self.assertRegex(c["name_any"], r"^ok \d+ v4")   # AF_UNSPEC: timed in its own column (ha-paper#20)
            self.assertEqual((c["ip_tcp"], c["ip_http"], c["name_http"]), ("ok", "200", "200"))
            c, ip = soak.probe("http://x4-gone.invalid:%d" % port, "x4_t", 3, "127.0.0.1")   # last good IP
            self.assertTrue(c["name_dns"].startswith("fail "))
            self.assertTrue(c["name_any"].startswith("fail "))
            self.assertEqual((ip, c["ip_tcp"], c["ip_http"], c["name_http"]), ("127.0.0.1", "ok", "200", "dns"))
            rows = [dict(soak.unreachable_row(T0, "dns", None), **c)]
            self.assertIn("name gone while the IP answered: 1.", soak.summarize(rows, "2026-10-16"))
            slow = [dict(rows[0], name_any=v) for v in ("ok 5012 v4", "ok 3 v4+v6", "ok 4 v4+v6")]
            self.assertIn("AF_UNSPEC lookup: median 4 ms, max 5012 ms, 1 of 3 at or over 1000 ms.",
                          soak.summarize(slow, "2026-10-16"))
            c, _ = soak.probe("http://127.0.0.1:%d" % port, "x4_t", 3, None)   # an IP in --url: no name columns
            self.assertEqual((c["name_dns"], c["name_any"], c["name_http"], c["ip_http"]), ("", "", "", "200"))
        finally:
            srv.shutdown()
            srv.server_close()
        c, _ = soak.probe("http://127.0.0.1:%d" % port, "x4_t", 3, None)   # closed now
        self.assertEqual((c["ip_tcp"], c["ip_http"]), ("refused", "refused"))


if __name__ == "__main__":
    unittest.main()
