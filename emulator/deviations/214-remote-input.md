# Remote input and framebuffer in the simulator (issue #214)

- `POST /api/v1/debug/input` (device simulator): `key=next|prev` and `swipe` page within the app shown (wrapping),
  `key=home` goes to the first screen; `tap` and `key=power` are only logged (`INPUT remote …`). The firmware feeds
  every spec into the board input queue, so taps, menus and the last-input-wins coalescing (eink-ha-os#212) act as on the glass.
- `GET /api/v1/debug/framebuffer.png` (device simulator): the layout of the screen shown, like `preview.png`; the
  firmware sends the frame last pushed to the panel, whatever it shows.
- The in-browser emulator has no remote input: `display.debugInput` passes validation there but is not kept.
