# Release notes

One section per version, newest first: `## <version>` (the tag without the `v`). The `- ` bullets are what the
display lists under "What's new" on its Updates screen (manifest.json `notes`): at most 6 bullets, one line each, at
most 34 characters. The release workflow fails if the tag's section is missing or a bullet is too long
(`firmware/tools/release_notes.py`). Prose below the bullets goes only into the GitHub release.

## 0.2.0-beta.6

- List tile: rare birds nearby
- Chart styles: band and compare
- One wake per quiet-hours change
- More free memory on the display
- Console updates over the air
- mDNS name repairs itself

New: a list tile shows rows from a sensor attribute, made for the Waarneming integration
(github.com/daangeijs/ha-waarneming): rare bird sightings around home and in chosen waarneming.nl areas, with
Dutch names, place, distance and how long ago. History charts gain a band (lowest to highest per period) and a
compare line (the day or week before).

Better: the display learns how fast its sleep timer runs and wakes once per quiet-hours change instead of twice.
About 30 KB of long-lived data moved to PSRAM. A console update over the air no longer stops on the first try.

Fixed: the .local name could stop answering after a wake while the display still answered on its IP; a check
every minute now repairs it. A very fast stream of HA updates no longer crashes the display.

## 0.2.0-beta.5

- Agenda, bins and weather tiles
- Now playing with favorites
- Good morning page after quiet
- Guest Wi-Fi QR code tile
- Nobody home: longer sleep
- Fixes a crash going to sleep

New tiles: the agenda and Next tiles read HA calendars; the bin day tile says which bin goes out and when; the
weather tile draws the condition with high, low, wind and a 5-day strip; now playing shows title and artist with
play, skip and volume taps, and favorites picked in the console. The guest Wi-Fi tile shows a QR code to join, with
the name and password in large type. On the first wake after quiet hours a Good morning page shows the weather,
today's events and the bins, for 20 minutes or until a press.

Better: a history tile can show the past and the forecast in one chart, the forecast drawn lighter. The quiet face
has a "Tomorrow" row with the forecast, the first event and the bins. While nobody is home the display wakes every
2 hours and shows "Nobody home". Asleep, it shows the date and "Asleep" instead of a time of day. The battery % no
longer goes up without a charger, and diagnostics show awake time per phase.

Fixed: a crash in mDNS when the display went into deep sleep (#326).

## 0.2.0-beta.4

- History charts on the display
- Rain and weather forecast charts
- Quiet hours replace night mode
- Asleep mark, no frozen clock
- Key wake without restart flash
- Dependency updates

History tiles fetch HA statistics or history for the screens on display only, stream-parsed into PSRAM; a very
chatty sensor shows "Too many changes" instead of dropping the connection. Forecast tiles read an attribute list or
`weather.get_forecasts` and look ahead from now. Quiet hours (default 23:00–07:00) show "Back at 07:00" with three
Home values and sleep on battery; any press shows the dashboard. Before glance sleep the clock becomes "Asleep ·
updated hh:mm".

## 0.2.0-beta.3

- Fixes crashes from low memory
- Hold Power 2 s to turn off
- Front light off after 1 min
- Price chart: low/high + times
- Check for updates shows result
- HA 2025.12 energy meters

Internal RAM: the TLS record pool moved to PSRAM and task stacks shrank. On the device the low point went from
under 1 KB to 66 KB, and the slow creep is gone. This fixes the `abort()` restarts and "Not enough memory" on an
update check (ha-paper#7). History and forecast charts are in the web console; the display draws them from beta.4.

## 0.2.0-beta.2

- Deep sleep 30 min after an update
- Battery history in diagnostics
- Power key logged (debug #225)
- Full version on update screen
- New web flasher, version picker
- Known: watchdog reset on battery

## 0.2.0-beta.1

- First public beta as HA Paper
- Pages turn without a full flash
- Larger text sizes for the panel
- Device log in the web console
- Power+Prev 5 s restarts display
- Fewer TLS and Wi-Fi heap spikes
