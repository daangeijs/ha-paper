# Built-in Settings (issue #159)

- `core/config.cpp`: `settingsScreens()` builds the fixed Settings pages in code (same order and tiles as the
  emulator); `withSettings()` = user apps + `settings`, user screens + those pages; `userConfig()` takes them off.
  `kDefaultYaml` = spec/default-screens.yaml without Settings, so the Display style / Power insert in the default config
  is gone. `defaultApps()` = catalog `apps()` without `settings`; `kMaxUserApps` = 7.
- `parseConfig` skips an `apps:` entry `settings`, accepts `app: settings`, validates and then drops Settings screens and
  system tiles (`isSystemTile`: setting, ota, wifi, ha, about); only Settings screens → `No screens found` (line 1).
  A stored screens.yaml from an older build is read the same way at boot.
- `App::begin` / `App::setConfig` run `withSettings(config)`; `App::config()` is the display's config. The hub, the web
  server (`GET /config`, `/console/state` apps) and the HA subscriptions keep the user config.
- The seed (`ha_client.cpp`) passes no tail; `seed.h settingsScreens()` is gone (moved to config).
