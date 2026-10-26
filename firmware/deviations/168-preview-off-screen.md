# preview.png draws the asked screen off-screen (issue #168)

- `GET /screens/{id}/preview.png` of the screen the panel shows (first page, no menu, setup, standby or night face over
  it) is the panel's own frame (`X-X4-Preview: current-panel`). Any other screen is drawn by the main loop into a 96 KB
  PSRAM frame (`App::renderScreen`, `X-X4-Preview: rendered`) and encoded in a PsramScope; the panel, its framebuffer,
  the drawn regions and the refresh counters stay as they are. The frame is freed after each request.
- The web task pauses the request and leaves one ask in the hub; the pump answers it. A second ask while one is open,
  or an ask the main loop did not pick up within 8 s, gets 503 + `Retry-After: 2`.
- The off-screen page is always page 1 of the screen with the current chrome (ambient or not) and look; at night it shows
  the screen, not the night face.
- The simulator (`emulator/server/png.ts`) still draws the layout only (top bar rule, tile frames), no
  `X-X4-Preview` header.
- `GET /__qemu/state` adds `screen` (the shown screen, "" when something covers it) for the contract test.
