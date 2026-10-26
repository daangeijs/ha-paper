# Tile values for the console (issue #122)

- `GET /api/v1/screens/{id}/values` is answered from the web task, but the entity store belongs to the main loop. The
  handler records the ask in the hub; `DeviceServices::pump()` formats that screen (`App::tileValues` →
  `ui::tileValue`, the same `statText` / `fmtNum` / `entityOn` the tiles draw with) at most once a second, and stops
  30 s after the last ask. The first call answers `{"ready": false, "values": []}`; values older than 5 s are not
  served. The emulator and device simulator answer ready at once.
- Values follow the last drawn state (`App::Impl::data` from the last build), so a value can trail the store by one
  main-loop pass.
