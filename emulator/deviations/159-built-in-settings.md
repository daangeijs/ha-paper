# Built-in Settings (issue #159)

- Settings is no longer part of screens.yaml. The display (in-browser emulator, device simulator, firmware) always adds a
  fixed Settings app as the last app switcher slot, with the pages Display, Display style, Power, Updates, Wi-Fi,
  Home Assistant, About (`settingsScreens()`, `withSettings()` in `src/core/config.ts`). A screens.yaml holds at most
  7 apps (8 slots minus Settings); the console says "at most 8 categories, Settings included".
- Older files still parse: an `apps:` entry `settings` is skipped, `app: settings` screens and the system tiles
  `setting`, `ota`, `wifi`, `ha`, `about` are validated and then dropped, also from your own screens (a Wi-Fi tile on a
  Home screen disappears). A file with only Settings screens fails with `No screens found` (line 1), so a saved
  config always re-parses (vectors `53`–`57`).
- The seed no longer appends a Settings tail.
- The web console's Screens tab and Add-tile palette show no Settings screens or system tiles. The Device tab's
  Settings card is grouped like the device menu (Display, Display style, Power saving, Updates, Home Assistant) and adds
  Updates › Channel (`ota_channel`) and Automatic (`display.otaAuto`); `settingsPages()` in `src/core/settings.ts`
  derives the groups from the fixed pages. `haReport` has no tile on the device; it sits under Home Assistant.
- The in-browser emulator's `GET/PUT /settings` now carries `ota_channel` and `display.otaAuto` (its Updates page state);
  the device simulator mirrors `display.otaAuto` into its OTA state.
- A config push keeps the display on the page it shows; since the Settings pages always exist, a push while on
  Settings stays on Settings (before, a push that dropped the screen jumped to the first one).
- Fixed page titles stay English (not in strings.ts): they are what screens.yaml used to carry. Follow-up if wanted.
