# Good morning page (issue #330)

- No "Overnight / needs attention" row: nothing in the firmware or emulator defines Needs-attention candidates yet, so
  the row has no source and is left out (the issue's own rule). It can join `core/morning` once such a list exists.
- The page reads the first weather tile with an entity, the first agenda / next tile with calendars and the first bins
  tile with sensors anywhere in the config. No tile = no row; no fetch of its own (weather from the RTC forecast, events
  from the agenda slot, bins from the entity mirror). An agenda answer that arrives after a glance wake has settled
  shows on the next wake.
- On battery in Glance the page is drawn by the timer wake at the end of quiet hours and stays on the glass until a
  later timer wake finds the 20 minutes over, so it can stay up to 20 min + one wake interval. A key press (also the
  press that wakes the display from deep sleep) closes it.
- Classic look in both display styles, like the quiet face. The setting tile is labelled "Good morning" (the Dutch
  "Goedemorgenpagina" did not fit a 1-cell tile); Quiet hours went from 2 cells to 1 on Settings › Power to make room.
