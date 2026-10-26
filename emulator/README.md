# HA Paper emulator (Vite + React + TypeScript)

Standalone port of the Claude Design emulator (`Main.dc.html` from the original design handoff; the `handoff/` folder was removed on 2026-10-16, the last commit with it is `c7393ae`).
The behaviour and visuals follow the original line for line. The markup was converted mechanically with the
handoff RECREATE.md Option C mapping, and the `Component` class was ported method by method into `src/emulator/Emulator.tsx`.

```sh
npm install
npm run dev               # http://localhost:5173  (emulator)
npm test                  # vitest: core + emulator acceptance checks + render smoke tests
npm run build             # typecheck + emulator bundle → dist/
npm run build:device-ui   # on-device web console → dist-device-ui/ (index.html + app.js + app.css)
npm run vectors           # regenerate ../spec/test-vectors from src/core
npm run device-sim        # device simulator: real web console + REST API on http://localhost:8080 (see below)
npm run test:contract     # API contract tests (simulator, or a real display with DEVICE_URL=…)
```

Views: `?view=emulator` (default), `?view=topbar` (top bar design system), `?view=halink` (HA phone-link flow).
Options: `?state=installed` (boot straight to Home), `?look=archivo` (display style: classic | archivo | bricolage | fraunces | geist), `?battery=15` (low battery / OTA blocked), `?body=White`, `?name=…`.

## Layout

```
src/core/         pure logic, no React: config (parseYaml/toYaml/validate), severity, regions (diff + hash),
                  paging (lights layout, subPages, pager, grid rects), refresh policy, debounce, tokens, mock data
src/emulator/     Emulator.tsx (the state machine) + emulatorApi.ts (in-memory DeviceApi)
src/components/   Device (hardware + 800×480 screen), Terminal, SidePanel
src/webconsole/   WebConsole + pages/*, useConsole (view model), DeviceApi.ts (interface),
                  httpApi.ts (fetch /api/v1), device-main.tsx (device SPA entry)
src/artboards/    TopBar + HaLink static artboards
scripts/          gen-vectors.ts → ../spec/test-vectors
server/           device simulator (node:http, no runtime deps) + fake Home Assistant + contract tests
```

## The panes

- **Device**: the X4 Pro with Power, Prev, Next, Home and Reset keys, and the 800 × 480 e-ink screen (4-gray filter,
  black/white flash on a full refresh, hatched redraw regions on a partial refresh, front-light tint). Tap and swipe work as on the device.
- **Laptop terminal**: simulated `curl` against the device API: `export X4_TOKEN` → `status` → `get` → `vim` (adds a
  "Morning" screen) → `PUT`. It shows 401, 403 and 422 errors.
- **Side panel**: the status line; Hardware keys and Full refresh; **Simulation** (time of day, tado room count, panel
  rendering, travel situation, Pause data, Drop HA link, Revoke HA key, **First install**, **Installed**, Never linked,
  show/hide redraw regions, refresh counters); **GitHub releases (mock)** (publish a release; next update works / bad download / won't start);
  **Event log** (keys, redraws, HA calls, API calls).
- **Web console** (`ha-paper-a1b2.local`, inside a fake browser window): the "can't be reached" page, the SoftAP setup wizard,
  link / sign in, then the configurator: drag-and-drop **Screens** (each tile with its data source), **Device settings**, **Advanced** (YAML with validation, API tokens).
  It talks to the display only through `DeviceApi`. The same components run on the device using `httpApi.ts` (see `../spec/openapi.yaml`).

## Acceptance walkthrough (original handoff AGENT_README §5)

1. **First install**: the app starts factory fresh (or press *First install*). The console shows "This site can't be reached".
   On the display, pick *HomeNet-Guest* and type any password of 8+ characters → the display shows "Finish in your browser" and the console shows *Finish setting up*.
   Press **Sign in with Home Assistant**: the display links and redraws Home with live data, and the console opens the configurator.
   (Other route: *Set up from phone* on the display → the console shows the 192.168.4.1 wizard.)
2. **Never linked**: press *Never linked*. Home shows the clock and the link card. Other HA pages show dashed ghost tiles with "—" and one card. There are no fake numbers.
3. **Pager**: the House app shows "1 / n" across Lights (part 1…k) and Heating (set tado rooms to 14 → 2 pages). Prev/Next, ‹ › and a swipe
   follow the pager and wrap. The middle of the pager opens the page overview.
4. **Redraw only what changed**: the event log shows `HA update · nothing visible changed · no redraw` when values round to the same text.
   A changed heating row shows `EPD partial (HA update · 1 region)` and hatches only that row.
5. **Debounce**: tap + on a heating row five times quickly. The setpoint updates right away with a dotted underline, the log shows one
   `climate.set_temperature`, and an `ack` follows 0.9 s later.
6. **API errors**: in Advanced › API, create a *Read only* token, then run export → get → vim → `PUT` in the terminal → `HTTP 403`. Revoke the token → `status` → `HTTP 401`.
   In the YAML tab, change an entity to `sensor.sola_power` and press Push → "Not pushed. Line 11: Unknown entity …". This is the same 422 rule as `PUT /config`.
7. **OTA**: Settings › Updates → Check → Install. With *Bad download* nothing changes. With *Won't start* the device reboots, fails, and rolls back to v0.3.0.
8. **Night**: set the time to 23:00 → night face; data redraws are skipped ("night · redraw skipped"). Tapping the screen shows the dashboard for 60 s (moon icon).

## Strings (English and Dutch, #98)

The display and the console follow Home Assistant's language (`get_config` → `language`, asked after every
`auth_ok`): Dutch for any `nl` variant, English for everything else. While unlinked the display is English and the
console uses the browser's language. Card names the user typed, HA friendly names, area names and screen titles are
never translated. Emulator: `?lang=nl` or *HA language* in the side panel; fake HA: the Dutch houses answer `nl`,
`POST /__fake/language {"language":"nl"}` changes it (the display picks it up on its next connect).

Adding a string (also for #86 / #91):

1. Add one line to `STRINGS` in `src/core/strings.ts`: `myKey: ['English', 'Nederlands'],`. The key must be a C++
   identifier; `{}` is a placeholder filled in order (`tr(lang, 'myKey', value)`). Keep the Dutch plain and short
   ("Bijgewerkt", "Geen verbinding met Home Assistant").
2. `npm run vectors`: rewrites `spec/test-vectors/strings.json` and the firmware's `src/core/strings_gen.h`.
3. Use it. Emulator display: `tx('myKey')` in `Emulator.vm` / `renderVals`, `v.t('myKey')` in `Device.tsx`. Console:
   `v.web.t('myKey')` (or `tp('myKey')` for the text around a bold `{}`). Firmware: `a.t(S::myKey)` in `ui_*.cpp`,
   `tr(lang, S::myKey, arg)` elsewhere.

`src/core/strings.test.ts` fails when the vectors or the header are stale, when a Dutch text lost a `{}`, or when a
text has a character outside the firmware fonts (ASCII, Latin-1, a few marks); the firmware's `test_strings_vectors`
compares its table with the vectors.

## Failure states (#86)

One calm state per failure, the same on the display and in the console (texts in `src/core/strings.ts`):

| Failure | Display | Console |
|---|---|---|
| HA unreachable | offline mark + "since 14:05"; tiles keep their last values | one line under the header; entity picker "Can't reach Home Assistant…" |
| Sign-in hangs | — | after 20 s: "Home Assistant didn't answer within 20 seconds. Check the address, and that Home Assistant is running." |
| Entity unavailable / unknown | a ring where the value goes + "Unavailable" / "Unknown" | the tile says "Unavailable in Home Assistant"; selected: why and what the display shows (`/console/state` `entity_gaps`) |
| Empty screen | "Nothing on this screen yet" + "Add tiles at <host> or <ip>." | the Values view shows the same |
| No matching entities | — | "Nothing matches “…”." or, with no search, "Home Assistant has nothing that fits here." |

Try them: `sensor.garden_temperature` is unavailable in the emulator's mock HA; with the fake HA,
`POST /__fake/state {"entity_id":"…","state":"unavailable"}` and `POST /__fake/restart {"down_s":40}`.

## Device simulator

`npm run device-sim` runs the display's HTTP side on your laptop so the **real** on-device web console
(`dist-device-ui/`, built automatically when missing) and the REST API (`../spec/openapi.yaml`) can be tested with a
browser, curl and automated tests before flashing. Node ≥ 23.6 runs the TypeScript directly; no runtime dependencies.
Parsing/validation, token handling, refresh policy, region diff and mock data come from `src/core`.

```sh
npm run device-sim                                    # installed + fake HA on :8123 → open http://localhost:8080
npm run device-sim -- --state-preset first-install    # wizard: Wi-Fi → "Finish in your browser" → sign in
npm run device-sim -- --state-preset never-linked --state ./x4-state.json   # persist "NVS/LittleFS" to JSON
npm run device-sim -- --ha-url http://homeassistant.local:8123 --state-preset never-linked   # real HA sign-in
npm run device-sim -- --releases-file ./releases.json --battery 20          # OTA feed / low battery
npm run device-sim -- --help
```

- **Static files** like LittleFS: every file pre-gzipped (served with `Content-Encoding: gzip` when accepted), ETag,
  SPA fallback for extension-less paths (`/setup`, `/link`, `/api-access`, …).
- **Every endpoint in the spec** (core, `x-console` and `x-firmware`): status codes and `{"error": …}` bodies as the
  firmware must produce them (401 `missing token` / `invalid or revoked token`, 403 `token is read-only`,
  422 `{error,line,message}`, 415 for form-encoded config, 429 + `Retry-After` after 5 bad tokens/min).
  Tokens are stored as SHA-256 only (`src/core/auth.ts` takes the hash function as a parameter; the emulator keeps its stand-in).
- **Sign in with Home Assistant** is the real flow: `POST /api/v1/auth/ha/start` (or `GET /auth/start`, `GET /link?p=CODE`)
  → 302 to `<ha>/auth/authorize` with `client_id=http://<Host>/`, `redirect_uri=http://<Host>/auth/callback`, `state`
  and a PKCE S256 challenge → `/auth/callback` checks `state` (single use), exchanges the code with the verifier,
  reads `auth/current_user` over the WebSocket, stores the refresh token (display linked) and sets `x4_session`
  (full access for an HA admin, view-only otherwise). The display then refreshes its access token and subscribes over `/api/websocket`;
  `invalid_grant` → "revoked". Unlink calls `/auth/revoke`.
- **Fake HA** (`--fake-ha`, default when no `--ha-url`; standalone: `npm run fake-ha`): login page (any user, *Administrator* checkbox),
  `/auth/token` (authorization_code with PKCE verification, refresh_token, `invalid_grant`), `/auth/revoke`,
  `/api/websocket` (auth, auth/current_user, get_states, subscribe_entities, subscribe_events, call_service,
  energy/get_prefs, config/area_registry/list, config/entity_registry/list, render_template for the firmware's
  discovery and first-run seed templates, recorder/statistics_during_period → {}) with entities from `src/core/data.ts`
  that drift every `--ha-tick` ms. `--house stranger` swaps in somebody else's HA (`server/fake-ha-stranger.ts`: P1
  meter, Nest thermostat, a few lights and thermometers) to see the first-run screens (#23); `--house dutch` /
  `dutch-energy` is a SolarEdge + P1 + Anker battery + tado house with Dutch names, without / with an Energy dashboard
  (#82). Start with `--state-preset never-linked` and link.
- **Real HA**: `--ha-url http://<ha>:8123`. Open the simulator by the host name you want as `client_id`
  (e.g. `http://<laptop-ip>:8080/`); HA accepts the redirect because it is on the same host.
- **OTA**: `POST /ota/check` reads the mock releases (default: 0.4.0 stable / 0.5.0-beta.1, or `--releases-file`, a
  GitHub *list releases* JSON with an optional inline `manifest` and a local `path` for `firmware.bin`, see `server/ota.ts`);
  `POST /ota` "downloads" and verifies SHA-256; `POST /ota/upload` takes a multipart `firmware` (+ `manifest`) or a raw body with
  `?sha256=` / `X-SHA256`, 422 on mismatch, 202 + reboot into it on success.
- **Simulator only** (not on the device): `GET /__sim/state` (current screen, full/partial/skipped refresh counts, recent
  refresh events, HA link state, pairing code, tokens as hashes) and `POST /__sim/control`
  `{"preset":"first-install"|"never-linked"|"installed", "battery":15, "battery_mv":3950, "ota_fail":"ok"|"hash"|"boot", "screen":"energy", "tap":0}` (`tap`: touch tile n of the shown screen; only scene
  tiles act, 409 otherwise).

```sh
curl -s localhost:8080/__sim/state | jq .refreshes
curl -s -H "Authorization: Bearer $X4_TOKEN" localhost:8080/api/v1/config -o screens.yaml
curl -s -X PUT -H "Authorization: Bearer $X4_TOKEN" -H "Content-Type: application/yaml" --data-binary @screens.yaml localhost:8080/api/v1/config
```

### Contract tests

`server/contract.test.ts` (part of `npm test`) boots the simulator and the fake HA on random ports and checks, over HTTP:
the console from flash, 401 missing/invalid/revoked token, 403 read-only, 422 with the line number, 415, PUT valid config →
200 + exactly one full refresh, token shown once and stored as SHA-256, the full OAuth round trip (PKCE, forged/replayed
`state` rejected, non-admin gets a view-only session, revoked key → re-link), the fake HA WebSocket API, "no visible change → no
redraw", OTA check/upload/rollback, first install, settings, long-lived-token linking, pairing link, restart, factory reset, 429.

The same suite runs against a real display (nothing is booted; simulator-only tests are skipped):

```sh
DEVICE_URL=http://ha-paper.local X4_SESSION=<x4_session cookie> npm run test:contract
DEVICE_URL=http://ha-paper.local X4_TOKEN_RW=x4_… X4_TOKEN_RO=x4_… npm run test:contract
```

Real firmware in QEMU (or a display on the LAN) with the standalone fake HA — the suite then signs in itself and also
runs the OAuth, revoke/re-link, live-data, entity-mapping, unlink + long-lived token and 429 tests against the firmware:

```sh
npm run fake-ha -- --tick 0                           # :8123, /__fake/{state,revoke-all,llat,calls} for tests
DEVICE_URL=http://127.0.0.1:8080 X4_FAKE_HA=http://127.0.0.1:8123 X4_FAKE_HA_DEVICE=http://10.0.2.2:8123 npm run test:contract
node scripts/device-signin.ts [device] [fakeHa] [haAsSeenByDevice]   # prints an x4_session cookie
```

(`make qemu-contract` does all of it; `CONTRACT_HA_TLS=1 make qemu-contract` links the device over https instead, with
`POST /__fake/tls {mode: hang|slow|reset}` and `/__fake/tls-reset` for a stalled, slow or reset handshake, #87.) `X4_SESSION` (copy the `x4_session` cookie after signing in) enables the token lifecycle tests and lets the suite
create and revoke its own temporary read/write tokens; without it give `X4_TOKEN_RW` (and `X4_TOKEN_RO` for the 403 checks).
PUT /config and settings changes are restored afterwards.

Differences from the original: see `DEVIATIONS.md` (an index of `deviations/`, one file per topic).
