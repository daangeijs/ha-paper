# Release notes

One section per version, newest first: `## <version>` (the tag without the `v`). The `- ` bullets are what the
display lists under "What's new" on its Updates screen (manifest.json `notes`): at most 6 bullets, one line each, at
most 34 characters. The release workflow fails if the tag's section is missing or a bullet is too long
(`firmware/tools/release_notes.py`). Prose below the bullets goes only into the GitHub release.

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
