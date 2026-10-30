#!/usr/bin/env python3
"""Pass/fail verdict of an endurance run (sim/qemu/endurance.sh, eink-ha-os#48).

    python3 endurance_check.py DIR [--tolerance 8192] [--warmup 600]

DIR holds soak/soak.csv (soak.py), events.csv (one row per injected fault: time,kind,detail,recovered_s,result)
and diag-final.json (GET /api/v1/diagnostics at the end). Writes DIR/endurance.md and exits 1 on any failure:
  - free_heap and heap_largest_block flat: median of the last third ≥ median of the first third - tolerance
    (rows after the warm-up only; the slope per hour is reported, not judged)
  - heap_largest_block never below 40 KB (kTlsMinLargestBlock: a flat line at 400 B is flat, and broken)
  - no reboot during the run (soak.py new_boots), no crash in the /diagnostics boot ring, no last_crash, no coredump
  - every injected fault recovered (events.csv result ok): Home Assistant linked again within the harness timeout
  - at most 10 % of injections lost (result inject-failed: the control call failed twice; judged separately)
  - every poll answered, except inside a fault window (a link drop cuts the host off too)
Stdlib only.
"""
import argparse
import csv
import datetime
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from soak import CRASH, read_csv  # noqa: E402

TLS_MIN_BLOCK = 40 * 1024   # core/net_policy.h kTlsMinLargestBlock: below it the firmware refuses TLS
INJECT_LOSS_PCT = 10   # endurance.sh retries a control call once; more lost injections than this = a broken harness
RECOVER_S = 300     # endurance.sh RECOVER_S: the longest a fault window can last
FAULT_SLACK_S = 30   # a poll in flight when a fault window closes may still time out (soak.py --timeout 10)


def _secs(e):
    """recovered_s of an event row as float, None when empty or not a number (an older unquoted detail)."""
    try:
        return float(e.get("recovered_s") or "")
    except ValueError:
        return None


def _t(iso):
    return datetime.datetime.fromisoformat(iso).timestamp()


def trend(rows, col, warmup_s):
    """{"n", "first", "last", "slope_h"} of an int column over the ok rows after warmup_s, or None (< 6 rows)."""
    ok = [r for r in rows if r.get("state") == "ok" and (r.get(col) or "").lstrip("-").isdigit()]
    if not ok:
        return None
    t0 = _t(ok[0]["time"])
    pts = [(_t(r["time"]) - t0, int(r[col])) for r in ok if _t(r["time"]) - t0 >= warmup_s]
    if len(pts) < 6:
        return None
    k = len(pts) // 3
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    den = sum((x - mx) ** 2 for x in xs)
    slope = sum((x - mx) * (y - my) for x, y in pts) / den if den else 0.0
    return {"n": len(pts), "first": statistics.median(ys[:k]), "last": statistics.median(ys[-k:]),
            "slope_h": slope * 3600}


def verdict(rows, events, diag, tolerance, warmup_s):
    """[(check, ok, detail)]"""
    out = []
    for col in ("free_heap", "heap_largest_block"):
        tr = trend(rows, col, warmup_s)
        if tr is None:
            out.append((col + " flat", False, "fewer than 6 answered polls after the warm-up"))
            continue
        ok = tr["last"] >= tr["first"] - tolerance
        out.append((col + " flat", ok, "first third %d, last third %d (tolerance %d), %+.0f B/h over %d polls" % (
            tr["first"], tr["last"], tolerance, tr["slope_h"], tr["n"])))
    lb = [int(r["heap_largest_block"]) for r in rows if r.get("state") == "ok" and r.get("heap_largest_block", "").isdigit()]
    lb = lb[1:] if len(lb) > 1 else lb   # the first poll is before Home Assistant data arrives
    out.append(("largest block >= %d (TLS floor)" % TLS_MIN_BLOCK, bool(lb) and min(lb) >= TLS_MIN_BLOCK,
                "min %s B over %d polls" % (min(lb) if lb else "-", len(lb))))
    boots = [(r["time"], r["new_boots"]) for r in rows if r.get("new_boots")]
    out.append(("no reboot", not boots, "; ".join("%s %s" % b for b in boots) or "none"))
    windows = []   # a link drop also cuts the host off: unanswered polls inside a fault window are expected
    for e in events:
        try:
            t = _t(e["time"])
        except (KeyError, ValueError):
            continue
        windows.append((t, t + (_secs(e) or RECOVER_S) + FAULT_SLACK_S))
    down = [r for r in rows if r.get("state") != "ok"]
    unexpected = [r for r in down if not any(a <= _t(r["time"]) <= b for a, b in windows)]
    out.append(("display answered", not unexpected, "%d of %d polls unanswered outside fault windows (%d inside)" % (
        len(unexpected), len(rows), len(down) - len(unexpected))))
    crashes = []
    if diag is None:
        crashes.append("no /diagnostics at the end")
    else:
        for b in diag.get("boots") or []:
            if b.get("crash") or b.get("reason") in CRASH:
                crashes.append("boot %s %s" % (b.get("reason"), b.get("panic") or ""))
        lc = diag.get("last_crash")
        if lc and lc.get("reason"):
            crashes.append("last_crash %s %s" % (lc.get("reason"), lc.get("panic") or ""))
        if diag.get("coredump"):
            crashes.append("coredump in %s" % diag["coredump"].get("task"))
    out.append(("no PANIC in /diagnostics", not crashes, "; ".join(c.strip() for c in crashes) or "none"))
    # inject-failed: the control call never reached the fake HA / QEMU hook (a harness problem, not the display's)
    lost = [e for e in events if e.get("result") == "inject-failed"]
    tried = [e for e in events if e.get("kind") != "entity-list"]
    out.append(("faults injected (<= %d%% lost)" % INJECT_LOSS_PCT,
                len(lost) * 100 <= INJECT_LOSS_PCT * len(tried),
                "%d of %d injections failed%s" % (len(lost), len(tried),
                                                   "".join("; %s %s %s" % (e["time"], e["kind"], e.get("detail", ""))
                                                           for e in lost[:5]))))
    events = [e for e in events if e.get("result") != "inject-failed"]
    bad = [e for e in events if e.get("result") != "ok"]
    kinds = {}
    for e in events:
        kinds[e["kind"]] = kinds.get(e["kind"], 0) + 1
    rec = [_secs(e) for e in events if e.get("result") == "ok" and _secs(e) is not None]
    out.append(("HA relinked after every fault", bool(events) and not bad,
                "%d faults (%s), %d failed%s%s" % (
                    len(events), ", ".join("%s %d" % kv for kv in sorted(kinds.items())), len(bad),
                    ", recovery max %.0f s" % max(rec) if rec else "",
                    "".join("; %s %s %s" % (e["time"], e["kind"], e.get("detail", "")) for e in bad[:10]))))
    return out


def report(checks, rows):
    span = ""
    if rows:
        span = " · %s → %s, %d polls" % (rows[0]["time"], rows[-1]["time"], len(rows))
    lines = ["# Endurance run: %s%s" % ("PASS" if all(c[1] for c in checks) else "FAIL", span), "",
             "| check | result | detail |", "|---|---|---|"]
    lines += ["| %s | %s | %s |" % (n, "ok" if ok else "**FAIL**", d.replace("|", "/")) for n, ok, d in checks]
    return "\n".join(lines) + "\n"


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("dir")
    p.add_argument("--tolerance", type=int, default=8192, help="bytes the heap may lose, last vs first third (default 8192)")
    p.add_argument("--warmup", type=float, default=600, help="seconds after the first poll left out of the heap trend")
    a = p.parse_args(argv)
    rows = read_csv(os.path.join(a.dir, "soak", "soak.csv"))
    ev_path = os.path.join(a.dir, "events.csv")
    events, diag = [], None
    if os.path.exists(ev_path):
        with open(ev_path, newline="") as f:
            events = list(csv.DictReader(f))
    dg_path = os.path.join(a.dir, "diag-final.json")
    if os.path.exists(dg_path):
        with open(dg_path) as f:
            diag = json.load(f)
    checks = verdict(rows, events, diag, a.tolerance, a.warmup)
    md = report(checks, rows)
    with open(os.path.join(a.dir, "endurance.md"), "w") as f:
        f.write(md)
    print(md, end="")
    return 0 if all(c[1] for c in checks) else 1


if __name__ == "__main__":
    sys.exit(main())
