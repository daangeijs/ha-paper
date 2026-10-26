#!/usr/bin/env python3
"""Write the release manifests into dist/.

manifest.json  — read by the device OTA (src/net/ota.cpp): {version, sha256, size, notes[]} for firmware.bin
"""
import argparse
import hashlib
import json
import os

p = argparse.ArgumentParser()
p.add_argument("--version", required=True)
p.add_argument("--dist", required=True)
p.add_argument("--notes-file", help="text file, one release note per line (optional)")
p.add_argument("--check", action="store_true",
               help="write nothing; fail unless dist/ is a build of --version (manifest and firmware.bin agree)")
a = p.parse_args()

fw = os.path.join(a.dist, "firmware.bin")
data = open(fw, "rb").read()

if a.check:
    m = json.load(open(os.path.join(a.dist, "manifest.json")))
    errs = []
    if m.get("version") != a.version:
        errs.append("manifest.json is version %s, expected %s" % (m.get("version"), a.version))
    if m.get("sha256") != hashlib.sha256(data).hexdigest() or m.get("size") != len(data):
        errs.append("manifest.json sha256/size do not match firmware.bin")
    if a.version.encode() not in data:
        errs.append("firmware.bin does not contain the version string %s" % a.version)
    if errs:
        raise SystemExit("Stale %s: %s. Run 'make dist' first." % (a.dist, "; ".join(errs)))
    print("dist/ is %s (manifest + firmware.bin agree)" % a.version)
    raise SystemExit(0)

notes = []
if a.notes_file and os.path.isfile(a.notes_file):
    notes = [l.strip("-* \t\n") for l in open(a.notes_file, encoding="utf-8") if l.strip("-* \t\n")]

manifest = {"version": a.version, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "notes": notes}
with open(os.path.join(a.dist, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")

print("manifest.json: %s sha256=%s size=%d notes=%d" % (a.version, manifest["sha256"][:12], len(data), len(notes)))
