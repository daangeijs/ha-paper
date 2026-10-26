# Settings › Updates status line during and after a check (issue #250)

The design handoff showed "Checking GitHub…" over the repository name and turned the button into "Checking…". Now the
status line says "Checking…" over the channel, then the result: "Up to date" / "v… available" over "Checked HH:MM ·
… channel", or a failed check in plain words (Not enough memory · No connection · GitHub busy · No releases yet ·
Couldn't check) from GET /ota `error`. The button keeps its label, so a check redraws only the status line (region
`s<i>`, a partial refresh, on the display too). Before any check the line says "Not checked yet", where the firmware
used to say "Up to date". "Couldn't check" shows the firmware's English message (it carries the HTTP status).
