# The rest of the UI in Dutch (issue #111)

- All drawn texts now come from `core/strings_gen.h`: the settings tiles (labels via `SettingDef::label`, values via
  `settingValue`), Updates, Wi-Fi with the keyboard's "space" / "Connect", Home Assistant, About, the install and
  recovery faces, the "needs Home Assistant" card (`noHaText` returns a key), menu counts, the car route line, and our
  own stat tiles: `statText(…, Lang)` translates the label and sub line (`stat-sub.json` stays the English vector).
  Binary sensors read "Aan" / "Uit" in Dutch, like the emulator.
- Messages kept in App state (`wMsg`, `otaMsg`) are written in the language of the moment; a language change does
  not rewrite one already on screen.
- Sleek setting values drop the "after " / "every " part (or "na " / "elke ") by the text before `{}` of the key.
- Left English: the first-install screens (shown before HA has told the language), API error texts (the console
  translates them), logs. Catalog route notes are demo data.
