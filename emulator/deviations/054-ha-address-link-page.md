# Home Assistant address on the link page (issues #54, #55)

- The link page shows "Found <address> on your network" only when `home_assistant.server` is in `.discovered` (mDNS);
  a typed or remembered address reads "Home Assistant at <address>", and with none there is an address field. A
  failed sign-in start shows the device's error inline and opens the field. The key explanation and the separate-user
  route moved behind two disclosures; the visible card is one sentence, the address and the button.
- `POST /auth/ha/start` on an unlinked display probes `GET <address>/auth/providers` first (`core/haAddress.ts`,
  `spec/test-vectors/ha-address.json`): 422 not an address / not Home Assistant / https typed but HA is http-only,
  502 no answer. The firmware used to accept any URL and the browser then failed on HA's side.
- Device simulator: the command-line HA is its mDNS answer and wins again after a restart; a typed address is
  remembered only until then (firmware keeps it in storage). The in-browser emulator checks the address rules but
  does not probe (no network).
