"""Tests for logs.py and the log-line secret audit (make test-tools, eink-ha-os#200).

The audit reads every LOG_* / note() / onLog() call in firmware/src: no argument after the format string may name a
secret (passwords, tokens, refresh token, PKCE verifier, cookies). The ring also masks secret-looking values
(core/log_ring.cpp redact, spec/test-vectors/logs.json); this catches the ones a mask cannot recognise, such as a
Wi-Fi password.
"""
import io
import json
import os
import re
import threading
import unittest
import http.server
from contextlib import redirect_stderr, redirect_stdout

import logs

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
CALL = re.compile(r"\b(LOG_(?:INF|WRN|ERR|DBG)|note|onLog)\s*\(")
SECRET = re.compile(r"(?i)(pass(word|wd)?|psk|secret|token|refresh_?tok|verifier|bearer|cookie|wPw|\bpw\b|\bkey\b)")
# argument text → why it is not a secret
ALLOWED = {
    "t.name.c_str()": "API token name the user typed, not the token",
    "errorCode(resp).c_str()": "HA's OAuth error code (invalid_grant …)",
    '"SET " + key': "display setting name (language, night …) from the device menu",
}


def calls(text):
    """(name, args text) of every call, parentheses balanced, string literals skipped."""
    for m in CALL.finditer(text):
        i, depth, quote = m.end(), 1, None
        while i < len(text) and depth:
            c = text[i]
            if quote:
                if c == "\\":
                    i += 1
                elif c == quote:
                    quote = None
            elif c in "\"'":
                quote = c
            elif c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
            i += 1
        yield m.group(1), text[m.end():i - 1]


def split_args(args):
    out, depth, quote, cur = [], 0, None, ""
    i = 0
    while i < len(args):
        c = args[i]
        if quote:
            cur += c
            if c == "\\" and i + 1 < len(args):
                cur += args[i + 1]
                i += 1
            elif c == quote:
                quote = None
        elif c in "\"'":
            quote = c
            cur += c
        elif c in "([{":
            depth += 1
            cur += c
        elif c in ")]}":
            depth -= 1
            cur += c
        elif c == "," and depth == 0:
            out.append(cur.strip())
            cur = ""
        else:
            cur += c
        i += 1
    if cur.strip():
        out.append(cur.strip())
    return out


def strip_literals(s):
    return re.sub(r'"(\\.|[^"\\])*"', '""', s)


def audit(text):
    """(call sites with arguments, offending arguments) in one source text."""
    bad, seen = [], 0
    for name, args in calls(text):
        parts = split_args(args)
        if name.startswith("LOG_"):
            parts = parts[2:]   # tag, format
        if not parts:
            continue
        seen += 1
        for p in parts:
            if SECRET.search(strip_literals(p)) and p not in ALLOWED:   # words inside string literals are text
                bad.append("%s(… %s …)" % (name, p))
    return seen, bad


class SecretAudit(unittest.TestCase):
    def test_the_audit_catches_a_secret(self):
        self.assertEqual(audit('LOG_INF("WIFI", "joining %s pw %s", ssid.c_str(), wifiPassword.c_str());')[1], ["LOG_INF(… wifiPassword.c_str() …)"])
        self.assertEqual(audit('LOG_WRN("HA", "got %s", link.refreshToken.c_str()); note("pw " + wPw);')[1],
                         ["LOG_WRN(… link.refreshToken.c_str() …)", 'note(… "pw " + wPw …)'])
        self.assertEqual(audit('LOG_INF("HA", "refresh_token stored, password unchanged (%d)", n);')[1], [])

    def test_no_log_argument_names_a_secret(self):
        bad, seen = [], 0
        for root, _, files in os.walk(SRC):
            if os.sep + "gen" in root:
                continue
            for f in files:
                if not f.endswith((".cpp", ".h")):
                    continue
                path = os.path.join(root, f)
                with open(path, encoding="utf-8") as fh:
                    n, b = audit(fh.read())
                seen += n
                bad += [os.path.relpath(path, SRC) + ": " + x for x in b]
        self.assertGreater(seen, 100)   # the scan found the call sites
        self.assertEqual(bad, [])


class LogsTool(unittest.TestCase):
    def test_line_text_matches_the_console(self):
        self.assertEqual(logs.line_text({"ms": 1234, "level": "W", "tag": "NET", "msg": "x"}), "     1.234 W [NET] x")

    def test_step_detects_a_restart(self):
        l = lambda seq, ms: {"seq": seq, "ms": ms, "level": "I", "tag": "A", "msg": "m"}
        lines, seq, ms, r = logs.step(0, None, {"seq": 2, "lines": [l(1, 10), l(2, 20)]})
        self.assertEqual((len(lines), seq, ms, r), (2, 2, 20, False))
        self.assertTrue(logs.step(2, 20, {"seq": 1, "lines": []})[3])
        self.assertTrue(logs.step(2, 20, {"seq": 9, "lines": [l(3, 5)]})[3])

    def test_fetch_sends_the_token_and_prints_lines(self):
        seen = {}

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen["auth"], seen["path"] = self.headers.get("Authorization"), self.path
                body = json.dumps({"boot": "current", "seq": 1, "first": 1, "dropped": False, "more": False,
                                   "lines": [{"seq": 1, "ms": 5, "epoch": None, "level": "I", "tag": "MAIN", "msg": "hello"}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            os.environ["X4_TOKEN"] = "x4_test"
            out = io.StringIO()
            with redirect_stdout(out):
                rc = logs.main(["--url", "127.0.0.1:%d" % srv.server_port, "--tag", "MAIN"])
            self.assertEqual(rc, 0)
            self.assertEqual(seen["auth"], "Bearer x4_test")
            self.assertIn("tag=MAIN", seen["path"])
            self.assertEqual(out.getvalue(), "     0.005 I [MAIN] hello\n")
            del os.environ["X4_TOKEN"]
            err = io.StringIO()
            with redirect_stderr(err):
                self.assertEqual(logs.main(["--url", "http://127.0.0.1:1"]), 2)
            self.assertNotIn("x4_test", err.getvalue())
        finally:
            srv.shutdown()
            srv.server_close()
            os.environ.pop("X4_TOKEN", None)


if __name__ == "__main__":
    unittest.main()
