"""Tests for endurance_check.py (make test-tools)."""
import contextlib
import csv
import datetime
import io
import json
import os
import tempfile
import unittest

import endurance_check
import soak
from soak import COLUMNS

T0 = datetime.datetime(2026, 10, 16, 9, 0, 0, tzinfo=datetime.timezone.utc)
CLEAN = {"boots": [{"reason": "POWERON", "crash": False}], "last_crash": None}


def rows(n, heap=lambda i: 180000, block=lambda i: 110000, boot_at=None, down_at=None):
    out = []
    for i in range(n):
        r = {k: "" for k in COLUMNS}
        r.update(time=(T0 + datetime.timedelta(minutes=i)).isoformat(), state="ok", free_heap=str(heap(i)),
                 heap_largest_block=str(block(i)), home_assistant="linked")
        if i == boot_at:
            r["new_boots"] = "PANIC"
        if i == down_at:
            r.update(state="down", free_heap="", heap_largest_block="")
        out.append(r)
    return out


EVENTS = [{"time": "t1", "kind": "ha-restart", "detail": "down 20 s", "recovered_s": "31", "result": "ok"},
          {"time": "t2", "kind": "ws-drop", "detail": "", "recovered_s": "6", "result": "ok"}]


def failed(checks):
    return [n for n, ok, _ in checks if not ok]


class Verdict(unittest.TestCase):
    def test_flat_clean_run_passes(self):
        noisy = lambda i: 180000 + (i % 5) * 900   # noqa: E731
        self.assertEqual(failed(endurance_check.verdict(rows(60, heap=noisy), EVENTS, CLEAN, 8192, 600)), [])

    def test_leak_fails_heap_only(self):
        leak = lambda i: 180000 - i * 400   # noqa: E731  400 B/min = 24 KB/h
        c = endurance_check.verdict(rows(60, heap=leak), EVENTS, CLEAN, 8192, 600)
        self.assertEqual(failed(c), ["free_heap flat"])
        self.assertIn("-24000 B/h", c[0][2])

    def test_fragmentation_fails_largest_block(self):
        frag = lambda i: 110000 if i < 30 else 90000   # noqa: E731
        self.assertEqual(failed(endurance_check.verdict(rows(60, block=frag), EVENTS, CLEAN, 8192, 600)),
                         ["heap_largest_block flat"])

    def test_warmup_drop_is_ignored(self):
        boot = lambda i: 220000 if i < 8 else 180000   # noqa: E731
        self.assertEqual(failed(endurance_check.verdict(rows(60, heap=boot), EVENTS, CLEAN, 8192, 600)), [])

    def test_reboot_and_panic_fail(self):
        diag = {"boots": [{"reason": "PANIC", "crash": True, "panic": "assert failed"}, {"reason": "POWERON"}],
                "last_crash": {"reason": "PANIC"}, "coredump": {"task": "loopTask"}}
        c = endurance_check.verdict(rows(60, boot_at=40), EVENTS, diag, 8192, 600)
        self.assertEqual(failed(c), ["no reboot", "no PANIC in /diagnostics"])
        self.assertIn("coredump in loopTask", dict((n, d) for n, _, d in c)["no PANIC in /diagnostics"])

    def test_unrecovered_fault_or_no_faults_fail(self):
        bad = EVENTS + [{"time": "t3", "kind": "link-drop", "detail": "45 s", "recovered_s": "", "result": "timeout"}]
        self.assertEqual(failed(endurance_check.verdict(rows(60), bad, CLEAN, 8192, 600)), ["HA relinked after every fault"])
        self.assertEqual(failed(endurance_check.verdict(rows(60), [], CLEAN, 8192, 600)), ["HA relinked after every fault"])

    def test_unanswered_poll_and_missing_diag_fail(self):
        c = endurance_check.verdict(rows(60, down_at=30), EVENTS, None, 8192, 600)
        self.assertEqual(failed(c), ["display answered", "no PANIC in /diagnostics"])

    def test_unanswered_poll_inside_a_link_drop_is_expected(self):
        drop = {"time": (T0 + datetime.timedelta(minutes=29, seconds=40)).isoformat(), "kind": "link-drop",
                "detail": "45 s", "recovered_s": "50", "result": "ok"}
        self.assertEqual(failed(endurance_check.verdict(rows(60, down_at=30), EVENTS + [drop], CLEAN, 8192, 600)), [])

    def test_too_short_fails(self):
        self.assertIn("free_heap flat", failed(endurance_check.verdict(rows(12), EVENTS, CLEAN, 8192, 600)))


    def test_unparsable_recovered_s_does_not_crash(self):
        # a link-drop row from before the detail was quoted: "off 45 s, new session yes" split the CSV
        odd = {"time": "2026-10-16T09:20:00+00:00", "kind": "link-drop", "detail": "off 45 s",
               "recovered_s": " new session yes", "result": "110"}
        c = endurance_check.verdict(rows(60), EVENTS + [odd], CLEAN, 8192, 600)
        self.assertEqual(failed(c), ["HA relinked after every fault"])


class Injection(unittest.TestCase):
    def lost(self, n_lost, n_ok):
        ev = [{"time": "t%d" % i, "kind": "clock-jump", "detail": "-7200 s · HTTP 000 curl 52", "recovered_s": "",
               "result": "inject-failed"} for i in range(n_lost)]
        ev += [{"time": "u%d" % i, "kind": "ws-drop", "detail": "1 dropped", "recovered_s": "4", "result": "ok"}
               for i in range(n_ok)]
        ev.append({"time": "v", "kind": "entity-list", "detail": "800 entities", "recovered_s": "10", "result": "ok"})
        return dict((n, (ok, d)) for n, ok, d in endurance_check.verdict(rows(60), ev, CLEAN, 8192, 600))

    def test_one_lost_in_ten_is_tolerated_and_not_a_relink_failure(self):
        c = self.lost(1, 9)
        self.assertEqual(c["faults injected (<= 10% lost)"][0], True)
        self.assertIn("1 of 10 injections failed", c["faults injected (<= 10% lost)"][1])
        self.assertTrue(c["HA relinked after every fault"][0])

    def test_more_than_ten_percent_lost_fails(self):
        c = self.lost(2, 9)
        self.assertFalse(c["faults injected (<= 10% lost)"][0])
        self.assertTrue(c["HA relinked after every fault"][0])


FX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "endurance")


class ProofRun3(unittest.TestCase):
    """QEMU proof run 3 (433e247, big house): /status in bytes, internal heap starved after the first entity list."""

    def test_status_heap_is_copied_in_bytes(self):
        # shaped like web_server.cpp statusJson(); values of the 15:28:45 poll, log: "free 10676 min 2252 largest 468"
        with open(os.path.join(FX, "qemu_status_bighouse.json")) as f:
            status = json.load(f)
        r = soak.make_row(T0, status, None, None)
        self.assertEqual((r["free_heap"], r["heap_min_free"], r["heap_largest_block"], r["free_psram"]),
                         ("9096", "2252", "468", "7793256"))

    def test_starved_heap_fails_on_the_floor_not_the_trend(self):
        rows_ = soak.read_csv(os.path.join(FX, "qemu_bighouse_soak.csv"))
        with open(os.path.join(FX, "qemu_bighouse_events.csv"), newline="") as f:
            events = list(csv.DictReader(f))
        c = dict((n, (ok, d)) for n, ok, d in endurance_check.verdict(rows_, events, CLEAN, 8192, 180))
        self.assertTrue(c["heap_largest_block flat"][0])   # flat at ~400 B
        self.assertEqual(c["largest block >= 40960 (TLS floor)"], (False, "min 28 B over 13 polls"))
        self.assertFalse(c["HA relinked after every fault"][0])   # config-push HTTP 000
        self.assertIn("config-push", c["HA relinked after every fault"][1])


class Main(unittest.TestCase):
    def test_dir_to_report(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "soak"))
            with open(os.path.join(d, "soak", "soak.csv"), "w", newline="") as f:
                w = csv.DictWriter(f, fieldnames=COLUMNS)
                w.writeheader()
                w.writerows(rows(30))
            with open(os.path.join(d, "events.csv"), "w") as f:   # as endurance.sh event() writes them
                f.write("time,kind,detail,recovered_s,result\n")
                f.write('2026-10-16T09:05:00+00:00,ha-restart,"down 30 s",58,ok\n')
                f.write('2026-10-16T09:12:00+00:00,link-drop,"off 45 s, new session yes",110,ok\n')
            with open(os.path.join(d, "diag-final.json"), "w") as f:
                json.dump(CLEAN, f)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = endurance_check.main([d, "--warmup", "60"])
            self.assertEqual(rc, 0, out.getvalue())
            with open(os.path.join(d, "endurance.md")) as f:
                self.assertTrue(f.read().startswith("# Endurance run: PASS"))


if __name__ == "__main__":
    unittest.main()
