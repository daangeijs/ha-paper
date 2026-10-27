# Car route arrival time as a second big value (issue #303)

- The handoff's car route tile put the arrival time in the small line next to the minutes ("17 min arrive 20:53 if
  you leave now"). From the room only the minutes read. At `cs >= 3` the tile now shows the arrival time at the same
  size as the minutes (52 px bold, tabular), after a dotted divider, with the new `arriveCaption` string ("arrive if you
  leave now" / "aankomst als je nu vertrekt") beside it. `cs` 2 keeps the one-line `arriveIfLeave` layout.
- Same markup in Classic and Modern; firmware `ui_tiles.cpp` routeTile() matches (divider 14 px after "min", time 20 px
  after it, caption 10 px after the time, clipped to the tile).
