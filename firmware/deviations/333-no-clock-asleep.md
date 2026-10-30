# No time of day while asleep (issue #333)

- Replaces the #299 "updated HH:MM" mark (Daan, 2026-10-28: "better no time than spending a lot of energy updating
  minutes"). A deep-sleeping panel shows no time of day anywhere: the top-bar clock region reads "Asleep" (B18 Classic;
  Modern a dark 32 px pill, T6 16 paper text, so it is not missed), the standby face footer "Asleep · press power to
  wake", and the Nobody home face (#331) drops its "Updated HH:MM" line (it keeps "Next update ~HH:MM").
- A Clock tile and the standby face show the date instead of digits: the day number in the clock font (digits-only
  font, so no new glyphs) and "weekday · month" (`asleepDate`) under it. Classic tile: "Asleep" right on the date line;
  Modern tile: header weekday / month, a paper "Asleep" pill where the day progress was (a time of day, so it goes).
  Home has no bar clock, so the tile carries the mark.
- Midnight: the clock digits region (k<i> / time) stays out of the glance diff, but the tile region (t<i>) holds the
  weekday, so the first glance wake after midnight redraws. The emulator leaves whole clock tiles out of its diff; it
  renders the live date anyway.
- Live and standby (awake) keep the live clock. Not done: RTC minute wakes (~13–16 mAh/day estimated, see the issue).
