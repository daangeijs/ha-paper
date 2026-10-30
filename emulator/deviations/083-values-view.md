# Values view of the screen editor (issue #83)

- A Names | Values toggle in the console's top bar (Screens tab, remembered in `localStorage`). Values swaps the editor
  for `GET /screens/{id}/preview.png` of the selected screen, every 5 s, one request at a time, paused while the tab is
  hidden, and at once after a config save (`src/webconsole/preview.ts`). A screen that is only in the draft is not
  fetched ("Push to see it").
- What each side returns: the firmware sends the panel's current framebuffer for any known id (header
  `X-X4-Preview: current-panel`, the console then says it may be another screen); the device simulator sends a
  layout-only PNG (tile frames); the in-browser emulator draws an SVG of that screen with its live values (frames,
  label, value, sub line, list rows, `Emulator.previewSvg`), not the full panel look.
- HA address check (eink-ha-os#75): the device simulator accepts its own fake HA's loopback host (`localhost`, from `--ha`)
  through `parseHaAddress(input, allowHost)`; every other loopback / link-local address is refused like on the device.
  The firmware has no such exception (its HA is never on loopback).
