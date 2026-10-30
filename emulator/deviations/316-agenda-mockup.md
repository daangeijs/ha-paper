# Agenda and Next tiles: differences from the beta.5 mockup (issue #316)

- Next: the title is 30 px (Modern 26 px) on up to two lines, not 44 px: the firmware's larger sizes carry only ASCII
  and a few marks, and event titles need the full Latin-1 set (é ë ü).
- No "Leave by … · 14 min by bike" foot on Next (no travel time source) and no calendar names beside the Agenda title.
- Line counts are fixed per tile height (4 lines on one row, 11 on two, headers included) so the emulator and the
  firmware cut the list at the same event; the rest is counted in "+N more this week".
- Times are 24-hour in both clock settings.
