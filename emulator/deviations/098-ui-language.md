# UI language (issue #98)

- The handoff was English only. Now the display and the console follow Home Assistant's language (`get_config`
  `language`; `src/core/strings.ts`, see README "Strings"). The emulator has no WebSocket: `haLang` (`?lang=nl`, side
  panel *HA language*) stands for HA's answer and applies while linked or revoked, like the firmware, which keeps the
  last answer in `/lang` across reboots and clears it on unlink.
- The device simulator asks `get_config` on every connect, keeps `language` in its state file and reports it in
  `GET /status` and `/console/state`.
- Console: translated are the link, sign-in and setup pages, the header, the save/push messages and the preview line.
  The Screens / Data sources / Advanced / API / Device tab contents, and error texts that come from the device API, are
  still English.
