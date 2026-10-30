# Bin day tile vs the beta.5 mockup (issue #317)

- The mockup's headline line was "Thursday morning · put out tonight". The integrations give a date, not a time of
  day, so the line is "Thursday 29 · put out tonight" (`binLineTonight`), and before the tonight hour "Tomorrow ·
  Thursday 29" (`binLine`). The rest list uses short weekdays ("Plastic Mon 3", `dayShort0`–`dayShort6`).
- The mockup drew a 54 × 64 hatched bin; the tile draws a 40 × 48 one (lid, handle, hatched body) so a rs 1 tile keeps
  room for the rest list.
- Bins on the same soonest day share the headline ("Paper + Plastic"); the mockup only showed one.
- The 1-wide tile has no pill (no room next to the bin name); on the evening before its foot says "Put out tonight" in
  bold instead of the date.
- The emulator ellipsizes a long headline and 1-wide value (CSS); the firmware steps the size down first
  (firmware/deviations/317-bin-day-text-fit.md). Both show only whole rest items (the emulator wraps the rest into a
  hidden second line).
