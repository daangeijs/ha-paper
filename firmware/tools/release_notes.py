#!/usr/bin/env python3
"""Release notes for one version from RELEASE_NOTES.md (eink-ha-os#251).

RELEASE_NOTES.md has one section per version (`## 0.2.0-beta.3`). Its `- ` bullets are the notes the device lists on
the Updates screen (manifest.json `notes`): at most MAX_ITEMS, each at most MAX_CHARS characters, so they fit the
notes column at R18 (firmware/src/app/ui_system.cpp, ota()) without being cut. The whole section (bullets plus any
prose) goes into the GitHub release body. A missing section, no bullets, too many or too long a line is an error, so
the release fails instead of shipping notes the device truncates.

Usage: release_notes.py --version 0.2.0-beta.3 [--file RELEASE_NOTES.md] [--notes-out notes.txt] [--body-out body.md]
Prints the bullets, one per line (e.g. for the export commit message).
"""
import argparse
import re
import sys

# Measured with tools/render.sh (2026-10-26): the notes column is 434 px wide at R18 and has room for 6 rows. Real
# notes run ~8.3 px per character (33 chars = 277 px), so 34 characters leaves room for capitals and wider typefaces;
# the device ellipsizes anything wider and drops rows past the sixth.
MAX_CHARS = 34
MAX_ITEMS = 6

_HEAD = re.compile(r"^##\s+v?(\S+)")
_COMMENT = re.compile(r"<!--.*?-->", re.S)


class NotesError(Exception):
    pass


def section(text, version):
    """The raw text of the version's section (without its heading), or NotesError if there is none."""
    version = version[1:] if version.startswith("v") else version
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        m = _HEAD.match(line)
        if start is None:
            if m and m.group(1) == version:
                start = i + 1
        elif line.startswith("## ") or line.startswith("# "):
            return "\n".join(lines[start:i]).strip("\n")
    if start is None:
        raise NotesError("RELEASE_NOTES.md has no '## %s' section; add one (≤ %d bullets, ≤ %d characters each)"
                         % (version, MAX_ITEMS, MAX_CHARS))
    return "\n".join(lines[start:]).strip("\n")


def bullets(sec):
    """The `- ` / `* ` bullets of a section (HTML comments ignored), checked against the device limits."""
    out = [l.strip()[2:].strip() for l in _COMMENT.sub("", sec).splitlines() if re.match(r"\s*[-*]\s", l)]
    errs = []
    if not out:
        errs.append("no bullets (the device shows these as the release notes)")
    if len(out) > MAX_ITEMS:
        errs.append("%d bullets, at most %d fit the device's Updates screen" % (len(out), MAX_ITEMS))
    for b in out:
        if len(b) > MAX_CHARS:
            errs.append("%d characters, at most %d fit: '%s'" % (len(b), MAX_CHARS, b))
    if errs:
        raise NotesError("; ".join(errs))
    return out


def body(sec):
    """Section text for the GitHub release body (HTML comments removed)."""
    return _COMMENT.sub("", sec).strip("\n") + "\n"


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--version", required=True, help="e.g. 0.2.0-beta.3 (a leading v is ignored)")
    p.add_argument("--file", default="RELEASE_NOTES.md")
    p.add_argument("--notes-out", help="write the bullets here, one per line (make dist NOTES=…)")
    p.add_argument("--body-out", help="write the whole section here (GitHub release body)")
    a = p.parse_args(argv)
    try:
        with open(a.file, encoding="utf-8") as f:
            sec = section(f.read(), a.version)
        notes = bullets(sec)
    except (OSError, NotesError) as e:
        print("error: release notes for %s: %s" % (a.version, e), file=sys.stderr)
        return 1
    if a.notes_out:
        with open(a.notes_out, "w", encoding="utf-8") as f:
            f.write("".join(n + "\n" for n in notes))
    if a.body_out:
        with open(a.body_out, "w", encoding="utf-8") as f:
            f.write(body(sec))
    print("\n".join(notes))
    return 0


if __name__ == "__main__":
    sys.exit(main())
