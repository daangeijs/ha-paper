# The rest of the UI in Dutch (issue #111)

- Translated now: the settings tiles (labels and values), Updates, Wi-Fi (list, password, keyboard, connecting, phone
  setup), Home Assistant (status and link), About, the install and recovery faces, the "needs Home Assistant" texts,
  our own stat tiles (labels and sub lines), menu counts, and every console tab (Screens, Data sources, Advanced, API
  access, Device) plus the seed report. `SETTINGS` / `ENT` keep an English `label` (config defaults, HA names) and
  add `lk` (the shown text); `fmt` / `get` take the language.
- The wire stays English: device API errors and the screen editor's checks (`configEdit.ts`) are English, and the
  console shows them through `trMsg()` (`src/core/strings.ts`): an exact match of a key's English, or one of the
  `MSG_KEYS` templates with its `{}` parts carried over. A message the table doesn't know is shown as it came.
- The Updates hint for "Notify" now reads "Checks daily, shows an icon in the top bar" (the firmware's text; the emulator
  said "shows UPDATE"). The device simulator's "network not found" error uses the firmware's wording.
- Sleek stat icons are picked by the English label (`ikey`), so a Dutch label keeps its icon.
- Left English on purpose: the first-install screens (Wi-Fi setup, "Finish in your browser", the onboarding face):
  they show before Home Assistant has told the language. The API endpoint list and OpenAPI text, the Diagnostics rows
  (reset reasons, heap, panel), curl examples and YAML parser errors (technical, like the logs). The emulator's
  simulator controls ("Simulate phone", side panel), the browser's "site can't be reached" mock, the hardware key
  labels, and the demo data (mock rooms, routes and their notes, release notes, palette items for those). Screen
  titles, category names and tile labels that the seed wrote into the config are user text and stay as written.
