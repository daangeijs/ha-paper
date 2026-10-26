# UI language (issue #98)

- Strings come from `core/strings_gen.h`, generated from the emulator's `src/core/strings.ts` (`npm run vectors`);
  `test_strings_vectors` checks it against `spec/test-vectors/strings.json`. No deviation in the texts.
- The language is HA's `get_config` `language`, asked after every `auth_ok`, kept in userdata `/lang` (LittleFS, not
  NVS) and rewritten only when it changes. A change is one full refresh. Unlink clears it (English, and the console
  falls back to the browser's language); a revoked key keeps it.
- Covered: clock day and month names, our own card headings and sub lines, the night and standby faces, the
  link card, empty screen, status values (HA / Wi-Fi), boot text. Still English: the settings screens' labels, the
  Wi-Fi keyboard, the OTA and recovery faces, the setup steps on the display. Numbers keep the decimal point
  ("2.1 kW", not "2,1 kW").
