# List picks (issue #127)

- The device simulator's region view (what decides a redraw) narrows a lightList / zoneList to an `entities`-only pick;
  with `areas` it keeps every light (it has no light → area map; a superset only redraws more often). The firmware and
  the in-browser emulator show exactly the pick.
- The in-browser emulator's entity list adds the mock climate zones with their area; `areas` = the mock ROOMS.
