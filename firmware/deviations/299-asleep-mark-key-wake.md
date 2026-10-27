# Asleep mark and key wake from glance sleep (issue #299)

- Before every deep sleep (glance, standby timer, low battery, API sleep; not the quiet face, which has no clock) the
  App draws its clocks as "asleep": the top-bar clock region becomes "Asleep · updated HH:MM" (R18 Classic, T6 16 Modern,
  the region widens to the text), a Clock tile keeps the update time as its digits and its date line (Classic) or
  weekday (Modern) reads "Updated · asleep", the standby face footer reads "Asleep · updated HH:MM · press power to wake".
  Chosen over a "next 08:30" time: a glance wake with no visible change does not refresh, so a "next" time would go
  stale on the glass; "updated" stays true.
- `App::markAsleep()` sets it with a partial refresh before the snapshot, so glance compares like with like; a glance
  wake renders with the mark (`settle()`), leaving glance for live clears it.
- Key wake from glance sleep (`ESP_SLEEP_WAKEUP_EXT1`, power save glance, RTC snapshot present): no boot screen. The
  panel is held (as on a timer wake) until HA data has settled (1.5 s quiet), a later key press (≥ 1.5 s after reset),
  setup, or 8 s, then one clean refresh. A partial is not possible: `X4Display::sleep()` sends the SSD1677 deep-sleep
  command and the rails go down, so the controller's old/new RAM is gone and the first paint after the wake must be
  clean. Before: boot screen (clean) + dashboard (clean) + partials as data arrived. Emulator: same, without the hold
  (its data is instant).
