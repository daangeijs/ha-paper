#!/usr/bin/env python3
"""Device log over the network (GET /api/v1/logs, eink-ha-os#200): no cable, no reset.

    X4_TOKEN=x4_… python3 logs.py --url http://ha-paper-a1b2.local [--follow] [--previous] [--level W] [--tag HEAP,EPD]

Prints `  uptime_s L [TAG] message` lines (the console's Download format). --follow polls every 2 s with since = the
last seq and starts over when the display restarted. --previous prints the last 2 KB of the boot before this one.
The token comes from the X4_TOKEN environment variable only (a read token is enough); it is never printed.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def line_text(l):
    """Same as the emulator's logText (src/core/logs.ts)."""
    return "%10.3f %s [%s] %s" % (l["ms"] / 1000.0, l["level"], l["tag"], l["msg"])


def fetch(base, token, since=0, previous=False, level=None, tag=None, timeout=15):
    q = {"limit": "1000"}
    if since:
        q["since"] = str(since)
    if previous:
        q["boot"] = "previous"
    if level:
        q["level"] = level
    if tag:
        q["tag"] = tag
    req = urllib.request.Request(base + "/api/v1/logs?" + urllib.parse.urlencode(q), headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def step(have_seq, have_ms, resp):
    """One poll → (lines to print, new seq, new last ms, restarted). Mirrors the console (src/webconsole/logsView.ts)."""
    lines = resp.get("lines", [])
    if resp["seq"] < have_seq or (have_ms is not None and lines and lines[0]["ms"] < have_ms):
        return [], 0, None, True
    return lines, resp["seq"], lines[-1]["ms"] if lines else have_ms, False


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--url", required=True)
    ap.add_argument("--follow", action="store_true")
    ap.add_argument("--previous", action="store_true")
    ap.add_argument("--level", choices=["E", "W", "I", "e", "w", "i"])
    ap.add_argument("--tag")
    a = ap.parse_args(argv)
    token = os.environ.get("X4_TOKEN", "").strip()
    if not token:
        print("logs: set X4_TOKEN to a read API token (web console › Advanced › API)", file=sys.stderr)
        return 2
    base = a.url.rstrip("/")
    if "://" not in base:
        base = "http://" + base
    seq, ms = 0, None
    while True:
        try:
            more = True
            while more:
                r = fetch(base, token, seq, a.previous, a.level, a.tag)
                if r.get("dropped"):
                    print("logs: some lines were overwritten before they were read", file=sys.stderr)
                lines, seq, ms, restarted = step(seq, ms, r)
                if restarted:
                    print("logs: --- the display restarted ---", file=sys.stderr)
                for l in lines:
                    print(line_text(l), flush=True)
                more = r.get("more") or restarted
        except urllib.error.HTTPError as e:
            print("logs: %s answered %d %s" % (base, e.code, e.read().decode(errors="replace")[:200]), file=sys.stderr)
            if e.code in (401, 403, 422):
                return 1
        except (urllib.error.URLError, OSError) as e:
            print("logs: %s unreachable (%s)" % (base, e), file=sys.stderr)
            if not a.follow:
                return 1
        if not a.follow or a.previous:
            return 0
        time.sleep(2)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
