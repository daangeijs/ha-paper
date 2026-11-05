#!/usr/bin/env python3
"""Soak collector: poll an HA Paper display, one CSV row per poll, a markdown summary per day (eink-ha-os#46).

    X4_TOKEN=x4_… python3 soak.py --url http://ha-paper-a1b2.local [--ip 192.168.1.40] [--interval 300] [--hours 168] [--out DIR]
    python3 soak.py --summarize DIR/soak.csv [--day 2026-10-16]     summary from an existing CSV to stdout

Reads GET /api/v1/status and /api/v1/diagnostics with a read API token (web console › API access) from
the X4_TOKEN environment variable; the token is never printed or written. Works against the device, `make qemu`
and `npm run device-sim`. Stdlib only.

Reboots: uptime went backwards (or the boot time moved forward); the reasons come from the boot ring in
/diagnostics. Unreachable polls are `asleep` when the display said it would sleep (power.nextWakeEpoch, mode) or
woke with reset reason DEEPSLEEP afterwards, otherwise `down`.

Inbound path (eink-ha-os#227: one night the .local name stopped resolving on the Mac while the display kept pushing to HA).
With a name in --url every poll checks the name and the IP separately, one column each:
  name_dns   ok <ms> | fail <error>               getaddrinfo(AF_INET) of the name (mDNS on macOS); an ok updates the IP
  name_any   ok <ms> v4|v4+v6 | fail <error>      getaddrinfo(AF_UNSPEC), what browsers and curl do; timed only
             (ha-paper#20: no AAAA answer made every one ~5 s while AF_INET was instant)
  ip         the address used: this resolve, else the last good one, else --ip
  ip_tcp     ok | timeout | refused | unreachable | <errno name>   bare TCP connect to ip:port
  ip_http    200 | HTTP <code> | <same failure words>   GET /api/v1/status by IP
  name_http  200 | HTTP <code> | dns | <same failure words>   GET /api/v1/status by name
Status and diagnostics are read by IP when it answers, else by name. name_dns fail + ip_http 200 = the device is
fine and only the name is gone; ip_tcp fail = nothing reaches it. With an IP in --url only the ip_* columns are filled.
The display's own view is in the web_* / mdns_* / bssid / idle_* columns (/diagnostics web, mdns, wifi).
"""
import argparse
import csv
import datetime
import errno
import http.client
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

COLUMNS = ["time", "state", "error", "uptime_s", "firmware", "battery", "source", "charging", "free_heap",
           "heap_min_free", "heap_largest_block", "free_psram", "rssi", "home_assistant", "ha_report",
           "ha_report_last_push", "reset_reason", "new_boots", "power_mode", "next_wake_epoch", "refreshes",
           "name_dns", "ip", "ip_tcp", "ip_http", "name_http", "web_served", "web_refused_503", "web_last_req_s",
           "mdns_up", "mdns_restarts", "mdns_reason", "bssid", "idle_checks", "idle_reconnects", "name_any"]
PROBE = ("name_dns", "ip", "ip_tcp", "ip_http", "name_http", "name_any")
SLOW_LOOKUP_MS = 1000  # name_any at or above this counts as a slow lookup in the summary
CRASH = {"PANIC", "INT_WDT", "TASK_WDT", "WDT", "BROWNOUT", "CPU_LOCKUP"}
BOOT_SLACK_S = 120     # boot time (poll time - uptime) may drift this much without counting as a reboot
WAKE_GRACE_S = 600     # after nextWakeEpoch the display should answer again within this


def _get(d, *path):
    for k in path:
        if not isinstance(d, dict):
            return None
        d = d.get(k)
    return d


def _cell(v):
    if v is None:
        return ""
    if isinstance(v, bool):
        return "1" if v else "0"
    return str(v)


def _int(s):
    try:
        return int(s)
    except (TypeError, ValueError):
        return None


def _epoch(iso):
    return datetime.datetime.fromisoformat(iso).timestamp()


def new_boots(prev, t, status, diag):
    """Reset reasons of the boots since the previous good poll, oldest first ([] = same boot).

    prev: {"t": epoch, "uptime": s, "boots": ring or None} of the previous good poll, or None."""
    uptime = _get(status, "uptime_s")
    if prev is None or uptime is None or prev.get("uptime") is None:
        return []
    shift = (t - uptime) - (prev["t"] - prev["uptime"])
    if uptime >= prev["uptime"] and shift <= BOOT_SLACK_S:
        return []
    boots = _get(diag, "boots") or []
    pb = (prev.get("boots") or [None])[0]
    if pb:
        for k in range(1, len(boots)):
            b = boots[k]
            if b.get("reason") == pb.get("reason") and b.get("version") == pb.get("version") and \
                    (b.get("uptime_s") or 0) >= (pb.get("uptime_s") or 0):
                return [x.get("reason") or "UNKNOWN" for x in reversed(boots[:k])]
    later = [b.get("reason") or "UNKNOWN" for b in boots if (b.get("last_seen") or 0) > prev["t"]]
    if later:
        return list(reversed(later))
    return [(boots[0].get("reason") if boots else None) or _get(diag, "reset_reason") or "UNKNOWN"]


def make_row(when, status, diag, prev):
    """CSV row (dict of strings) for an answered poll. when: aware datetime."""
    rssi = _get(status, "rssi")
    if rssi is None:
        rssi = _get(status, "wifi_rssi")
    rr = _get(diag, "reset_reason")
    if rr is None:
        rr = ((_get(diag, "boots") or [{}])[0] or {}).get("reason")
    r = {
        "time": when.isoformat(timespec="seconds"), "state": "ok", "error": "",
        "uptime_s": _get(status, "uptime_s"), "firmware": _get(status, "firmware"), "battery": _get(status, "battery"),
        "source": _get(status, "power", "source"), "charging": _get(status, "power", "charging"),
        "free_heap": _get(status, "free_heap"), "heap_min_free": _get(status, "heap_min_free"),
        "heap_largest_block": _get(status, "heap_largest_block"), "free_psram": _get(status, "free_psram"), "rssi": rssi,
        "home_assistant": _get(status, "home_assistant"), "ha_report": _get(status, "ha_report", "state"),
        "ha_report_last_push": _get(status, "ha_report", "last_push_epoch"), "reset_reason": rr,
        "new_boots": ";".join(new_boots(prev, when.timestamp(), status, diag)),
        "power_mode": _get(status, "power", "mode"), "next_wake_epoch": _get(status, "power", "nextWakeEpoch"),
        "refreshes": _get(status, "refreshes"),
        "web_served": _get(diag, "web", "served"), "web_refused_503": _get(diag, "web", "refused_503"),
        "web_last_req_s": _get(diag, "web", "last_request_age_s"), "mdns_up": _get(diag, "mdns", "up"),
        "mdns_restarts": _get(diag, "mdns", "restarts"), "mdns_reason": _get(diag, "mdns", "last_restart_reason"),
        "bssid": _get(diag, "wifi", "bssid"), "idle_checks": _get(diag, "wifi", "idle_checks"),
        "idle_reconnects": _get(diag, "wifi", "idle_reconnects"),
    }
    if isinstance(r["refreshes"], dict):
        r["refreshes"] = json.dumps(r["refreshes"], separators=(",", ":"), sort_keys=True)
    return {k: _cell(r.get(k)) for k in COLUMNS}   # PROBE cells: collect()


def unreachable_row(when, error, last_status):
    """Row for a poll that got no answer: asleep when the last answer announced a sleep, else down."""
    nxt = _get(last_status, "power", "nextWakeEpoch")
    mode = _get(last_status, "power", "mode")
    asleep = (nxt is not None and when.timestamp() <= nxt + WAKE_GRACE_S) or (mode not in (None, "awake"))
    r = {k: "" for k in COLUMNS}
    r.update(time=when.isoformat(timespec="seconds"), state="asleep" if asleep else "down", error=error)
    return r


# ------------------------------------------------------------------ summary

def _gaps(rows):
    """Runs of unanswered polls: (start_row, end_row_or_None, kind). end = first answered poll after the run."""
    out, i = [], 0
    while i < len(rows):
        if rows[i]["state"] not in ("asleep", "down"):
            i += 1
            continue
        j = i
        while j < len(rows) and rows[j]["state"] in ("asleep", "down"):
            j += 1
        end = rows[j] if j < len(rows) else None
        boots = (end or {}).get("new_boots", "").split(";") if end else []
        if any(b in CRASH for b in boots):
            kind = "down"
        elif "DEEPSLEEP" in boots or all(r["state"] == "asleep" for r in rows[i:j]):
            kind = "asleep"
        else:
            kind = "down"
        out.append((rows[i], end, kind))
        i = j
    return out


def _dur(s):
    s = int(s)
    return "%dh%02dm" % (s // 3600, s % 3600 // 60) if s >= 3600 else "%dm%02ds" % (s // 60, s % 60)


def summarize(rows, day):
    """Markdown summary of the rows whose local date (time column) is day (YYYY-MM-DD)."""
    idx = [i for i, r in enumerate(rows) if r["time"][:10] == day]
    if not idx:
        return "# Soak %s\n\nNo polls.\n" % day
    dr = rows[idx[0]:idx[-1] + 1]
    ok = [r for r in dr if r["state"] == "ok"]
    n = {s: sum(1 for r in dr if r["state"] == s) for s in ("ok", "asleep", "down", "error")}
    fw = sorted({r["firmware"] for r in ok if r["firmware"]})
    L = ["# Soak %s" % day, "", "%d polls %s → %s: %d ok, %d unanswered, %d HTTP error. Firmware: %s." % (
        len(dr), dr[0]["time"][11:16], dr[-1]["time"][11:16], n["ok"], n["asleep"] + n["down"], n["error"],
        ", ".join(fw) or "?"), ""]

    L += ["## Resets", ""]
    resets = [(r["time"], b) for r in dr if r["state"] == "ok" and r["new_boots"] for b in r["new_boots"].split(";")]
    if resets:
        by = {}
        for _, b in resets:
            by[b] = by.get(b, 0) + 1
        L += ["| reason | count | |", "|---|---|---|"]
        L += ["| %s | %d | %s |" % (b, c, "crash" if b in CRASH else "")
              for b, c in sorted(by.items(), key=lambda x: -x[1])]
        L += ["", "Seen at: " + ", ".join("%s %s" % (t[11:16], b) for t, b in resets) + "."]
    else:
        L += ["None."]
    L.append("")

    L += ["## Heap (internal RAM, bytes)", "", "| hours | min free | lowest since boot | min largest block |",
          "|---|---|---|---|"]
    for h in range(0, 24, 6):
        q = [r for r in ok if h <= int(r["time"][11:13]) < h + 6]
        if q:
            def mn(c):
                v = [_int(r[c]) for r in q if _int(r[c]) is not None]
                return str(min(v)) if v else "?"
            L.append("| %02d–%02d | %s | %s | %s |" % (h, h + 6, mn("free_heap"), mn("heap_min_free"),
                                                     mn("heap_largest_block")))
    L.append("")

    L += ["## Battery", ""]
    bat = [(r, _int(r["battery"])) for r in ok if _int(r["battery"]) is not None]
    if bat:
        drop, secs = 0, 0.0
        for (a, ba), (b, bb) in zip(bat, bat[1:]):
            if a["source"] == "battery" and b["source"] == "battery":
                drop += ba - bb
                secs += _epoch(b["time"]) - _epoch(a["time"])
        rate = "%.1f %%/day over %s on battery" % (drop / secs * 86400, _dur(secs)) if secs >= 3600 else \
            "rate n/a (under 1 h on battery)"
        src = sorted({r["source"] for r, _ in bat if r["source"]})
        L.append("%d %% → %d %% (min %d %%), %s. Source: %s." % (
            bat[0][1], bat[-1][1], min(b for _, b in bat), rate, ", ".join(src) or "?"))
    else:
        L.append("No readings.")
    L.append("")

    L += ["## Home Assistant", ""]
    drops, off = 0, 0.0
    for a, b in zip(ok, ok[1:]):
        if a["home_assistant"] == "linked" and b["home_assistant"] != "linked":
            drops += 1
        if a["home_assistant"] != "linked":
            off += _epoch(b["time"]) - _epoch(a["time"])
    states = {}
    for r in ok:
        states[r["home_assistant"] or "?"] = states.get(r["home_assistant"] or "?", 0) + 1
    rep = {}
    for r in ok:
        if r["ha_report"]:
            rep[r["ha_report"]] = rep.get(r["ha_report"], 0) + 1
    L.append("Disconnects (linked → other): %d; not linked for ~%s. Polls by state: %s." % (
        drops, _dur(off), ", ".join("%s %d" % kv for kv in sorted(states.items()))))
    if rep:
        L.append("ha_report: %s." % ", ".join("%s %d" % kv for kv in sorted(rep.items())))
    L.append("")

    pr = [r for r in dr if r.get("ip_tcp") or r.get("name_dns")]
    if pr:
        def bad(c):
            return sum(1 for r in pr if r.get(c) and not r[c].startswith(("ok", "200")))
        only_name = sum(1 for r in pr if r.get("ip_http") == "200" and r.get("name_http") not in ("", "200"))
        L += ["## Inbound path", "", "%d polls: name_dns failed %d, ip_tcp failed %d, ip_http failed %d, name_http failed %d; "
              "name gone while the IP answered: %d." % (len(pr), bad("name_dns"), bad("ip_tcp"), bad("ip_http"),
                                                         bad("name_http"), only_name), ""]
        ms = sorted(_int(r["name_any"].split(" ")[1]) for r in pr if r.get("name_any", "").startswith("ok "))
        if ms:
            L[-1:-1] = ["AF_UNSPEC lookup: median %d ms, max %d ms, %d of %d at or over %d ms." % (
                ms[len(ms) // 2], ms[-1], sum(1 for m in ms if m >= SLOW_LOOKUP_MS), len(ms), SLOW_LOOKUP_MS)]

    L += ["## Unreachable", ""]
    gaps = [g for g in _gaps(rows) if g[0]["time"][:10] == day]
    if gaps:
        L += ["| from | to | duration | kind |", "|---|---|---|---|"]
        for s, e, kind in gaps:
            to = e["time"] if e else rows[-1]["time"]
            L.append("| %s | %s | %s%s | %s |" % (s["time"][11:19], to[11:19] if e else "(still)",
                                                 _dur(_epoch(to) - _epoch(s["time"])), "" if e else "+", kind))
    else:
        L.append("None.")
    errs = [r for r in dr if r["state"] == "error"]
    if errs:
        L += ["", "HTTP errors: " + ", ".join("%s %s" % (r["time"][11:16], r["error"]) for r in errs) + "."]
    return "\n".join(L) + "\n"


def read_csv(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


# ------------------------------------------------------------------ collector

def fetch(base, path, token, timeout):
    req = urllib.request.Request(base + path, headers={"Authorization": "Bearer " + token, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def poll(base, token, timeout):
    """(status, diag, None) or (None, None, (state, error))."""
    try:
        status = fetch(base, "/api/v1/status", token, timeout)
        try:
            diag = fetch(base, "/api/v1/diagnostics", token, timeout)
        except urllib.error.HTTPError as e:
            if e.code != 404:   # 404: an API without /diagnostics (older firmware)
                raise
            diag = None
        return status, diag, None
    except urllib.error.HTTPError as e:
        return None, None, ("error", "HTTP %d" % e.code)
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException) as e:   # + IncompleteRead
        why = getattr(e, "reason", None) or e
        return None, None, ("down", type(why).__name__ if not str(why) else str(why))


def _why(e):
    """Short failure word for a probe exception."""
    e = getattr(e, "reason", None) or e
    if isinstance(e, socket.gaierror):
        return "dns"
    if isinstance(e, (socket.timeout, TimeoutError)):
        return "timeout"
    if isinstance(e, ConnectionRefusedError):
        return "refused"
    if isinstance(e, OSError) and e.errno in (errno.EHOSTUNREACH, errno.ENETUNREACH, errno.EHOSTDOWN):
        return "unreachable"
    if isinstance(e, OSError) and e.errno:
        return errno.errorcode.get(e.errno, str(e.errno))
    return type(e).__name__


def _http_code(base, token, timeout):
    try:
        fetch(base, "/api/v1/status", token, timeout)
        return "200"
    except urllib.error.HTTPError as e:
        return "HTTP %d" % e.code
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException) as e:
        return _why(e)


def _is_ip(host):
    try:
        socket.inet_aton(host)
        return host.count(".") == 3
    except OSError:
        return False


def probe(base, token, timeout, last_ip):
    """Inbound-path cells (PROBE columns) and the IP to poll; see the module docstring."""
    u = urllib.parse.urlparse(base)
    host, port = u.hostname or "", u.port or 80
    c = {k: "" for k in PROBE}
    ip = host if _is_ip(host) else None
    if ip is None:
        t0 = time.monotonic()
        try:
            ip = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)[0][4][0]
            c["name_dns"] = "ok %d" % ((time.monotonic() - t0) * 1000)
        except OSError as e:
            c["name_dns"] = "fail " + (str(e) or type(e).__name__)
            ip = last_ip
        t0 = time.monotonic()
        try:
            fam = {a[0] for a in socket.getaddrinfo(host, port, socket.AF_UNSPEC, socket.SOCK_STREAM)}
            c["name_any"] = "ok %d %s" % ((time.monotonic() - t0) * 1000,
                                          "+".join(n for f, n in ((socket.AF_INET, "v4"), (socket.AF_INET6, "v6")) if f in fam))
        except OSError as e:
            c["name_any"] = "fail " + (str(e) or type(e).__name__)
    if ip:
        c["ip"] = ip
        try:
            socket.create_connection((ip, port), timeout=timeout).close()
            c["ip_tcp"] = "ok"
        except OSError as e:
            c["ip_tcp"] = _why(e)
        if c["ip_tcp"] == "ok":
            c["ip_http"] = _http_code("%s://%s:%d" % (u.scheme or "http", ip, port), token, timeout)
        else:
            c["ip_http"] = c["ip_tcp"]
    if not _is_ip(host):
        c["name_http"] = _http_code(base, token, timeout) if c["name_dns"].startswith("ok") else "dns"
    return c, ip


def collect(args, token):
    base = args.url if "://" in args.url else "http://" + args.url
    base = base.rstrip("/")
    out = args.out or os.path.join("soak", urllib.parse.urlparse(base).netloc.replace(":", "-") or "display")
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, "soak.csv")
    fresh = not os.path.exists(path) or os.path.getsize(path) == 0
    prev, last_status, n, ip = None, None, 0, args.ip
    start = time.monotonic()
    print("soak: %s every %d s → %s%s" % (base, args.interval, path, " for %g h" % args.hours if args.hours else ""))
    while True:
        when = datetime.datetime.now().astimezone()
        cells, ip = probe(base, token, args.timeout, ip)
        u = urllib.parse.urlparse(base)
        by_ip = cells["ip_http"] == "200" and not _is_ip(u.hostname or "")
        status, diag, err = poll("%s://%s:%d" % (u.scheme, ip, u.port or 80) if by_ip else base, token, args.timeout)
        if err and err[1] in ("HTTP 401", "HTTP 403") and n == 0:
            print("soak: %s rejected the token (%s): set X4_TOKEN to a read API token" % (base, err[1]), file=sys.stderr)
            return 2
        if status is not None:
            row = make_row(when, status, diag, prev)
            prev = {"t": when.timestamp(), "uptime": _get(status, "uptime_s"), "boots": _get(diag, "boots")}
            last_status = status
        elif err[0] == "down":
            row = unreachable_row(when, err[1], last_status)
        else:
            row = {k: "" for k in COLUMNS}
            row.update(time=when.isoformat(timespec="seconds"), state="error", error=err[1])
        row.update({k: v for k, v in cells.items() if v})
        with open(path, "a", newline="") as f:
            w = csv.DictWriter(f, fieldnames=COLUMNS)
            if fresh:
                w.writeheader()
                fresh = False
            w.writerow(row)
        day = row["time"][:10]
        with open(os.path.join(out, "summary-%s.md" % day), "w") as f:
            f.write(summarize(read_csv(path), day))
        print("%s %-6s up %6s heap %6s/%6s bat %3s ha %s · dns %s tcp %s http %s/%s%s%s" % (
            row["time"][11:19], row["state"], row["uptime_s"], row["free_heap"], row["heap_largest_block"], row["battery"],
            row["home_assistant"], row["name_dns"].split(" ")[0] or "-", row["ip_tcp"] or "-", row["ip_http"] or "-",
            row["name_http"] or "-", "  reboot: " + row["new_boots"] if row["new_boots"] else "",
            "  " + row["error"] if row["error"] else ""), flush=True)
        n += 1
        nxt = start + n * args.interval
        if args.hours and nxt - start >= args.hours * 3600:
            return 0
        time.sleep(max(0.0, nxt - time.monotonic()))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--url", help="display address, e.g. http://ha-paper-a1b2.local or 192.168.1.40")
    p.add_argument("--ip", help="display IP to probe until the name resolves once (default: from the name)")
    p.add_argument("--interval", type=int, default=300, help="seconds between polls (default 300)")
    p.add_argument("--hours", type=float, default=0, help="stop after this many hours (default: run until Ctrl-C)")
    p.add_argument("--out", help="output folder (default soak/<host>[-port])")
    p.add_argument("--timeout", type=float, default=10, help="HTTP timeout per request, seconds (default 10)")
    p.add_argument("--summarize", metavar="CSV", help="print the summary of an existing soak.csv and exit")
    p.add_argument("--day", help="with --summarize: only this YYYY-MM-DD (default: every day)")
    a = p.parse_args(argv)
    if a.summarize:
        rows = read_csv(a.summarize)
        days = [a.day] if a.day else sorted({r["time"][:10] for r in rows})
        print("\n".join(summarize(rows, d) for d in days), end="")
        return 0
    if not a.url:
        p.error("--url is required")
    if a.interval < 1:
        p.error("--interval must be ≥ 1")
    token = os.environ.get("X4_TOKEN", "").strip()
    if not token:
        print("soak: set X4_TOKEN to a read API token (web console › API access)", file=sys.stderr)
        return 2
    try:
        return collect(a, token)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
