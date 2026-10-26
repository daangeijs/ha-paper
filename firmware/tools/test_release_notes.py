import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import release_notes as rn  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DOC = """# Release notes

Intro text.

## 0.2.0-beta.2

- Deep sleep 30 min after an update
* Battery history in diagnostics

Prose for the GitHub release.

## 0.2.0-beta.1 (2026-10-20)

- First hardware build
<!-- - not a note -->
"""


class ReleaseNotesTest(unittest.TestCase):
    def test_section_and_bullets(self):
        sec = rn.section(DOC, "0.2.0-beta.2")
        self.assertEqual(rn.bullets(sec), ["Deep sleep 30 min after an update", "Battery history in diagnostics"])
        self.assertIn("Prose for the GitHub release.", rn.body(sec))
        self.assertNotIn("beta.1", sec)

    def test_v_prefix_heading_suffix_last_section_and_comments(self):
        sec = rn.section(DOC, "v0.2.0-beta.1")
        self.assertEqual(rn.bullets(sec), ["First hardware build"])
        self.assertNotIn("not a note", rn.body(sec))

    def test_missing_section(self):
        with self.assertRaisesRegex(rn.NotesError, r"no '## 0\.2\.0-beta\.9' section"):
            rn.section(DOC, "0.2.0-beta.9")
        with self.assertRaises(rn.NotesError):   # a prefix of another version is not that version
            rn.section(DOC, "0.2.0-beta")

    def test_limits(self):
        ok = "x" * rn.MAX_CHARS
        self.assertEqual(rn.bullets("- " + ok), [ok])
        with self.assertRaisesRegex(rn.NotesError, "35 characters"):
            rn.bullets("- " + ok + "y")
        with self.assertRaisesRegex(rn.NotesError, "at most 6"):
            rn.bullets("\n".join("- n%d" % i for i in range(rn.MAX_ITEMS + 1)))
        with self.assertRaisesRegex(rn.NotesError, "no bullets"):
            rn.bullets("Only prose.\n<!-- - commented -->")

    def test_repo_file_parses(self):
        # every section with bullets in the shipped RELEASE_NOTES.md must meet the limits (empty = still being written)
        with open(os.path.join(ROOT, "RELEASE_NOTES.md"), encoding="utf-8") as f:
            text = f.read()
        versions = [m.group(1) for m in map(rn._HEAD.match, text.splitlines()) if m]
        self.assertIn("0.2.0-beta.2", versions)
        for v in versions:
            sec = rn.section(text, v)
            if any(l.lstrip().startswith(("- ", "* ")) for l in rn._COMMENT.sub("", sec).splitlines()):
                rn.bullets(sec)

    def test_cli(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "RN.md")
            with open(src, "w", encoding="utf-8") as f:
                f.write(DOC)
            notes, body = os.path.join(d, "notes.txt"), os.path.join(d, "body.md")
            r = subprocess.run([sys.executable, rn.__file__, "--version", "v0.2.0-beta.2", "--file", src,
                                "--notes-out", notes, "--body-out", body], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(open(notes).read(), "Deep sleep 30 min after an update\nBattery history in diagnostics\n")
            self.assertIn("Prose", open(body).read())
            r = subprocess.run([sys.executable, rn.__file__, "--version", "9.9.9", "--file", src],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 1)
            self.assertIn("error: release notes for 9.9.9", r.stderr)


if __name__ == "__main__":
    unittest.main()
