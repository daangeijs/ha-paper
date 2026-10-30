# Glance = sleep face + button wake, dark timer wake (issue #356, #357)

- Behaviour change (Daan, 2026-10-29): the glance power mode no longer wakes every `wakeEvery` minutes to refresh data.
  It draws the sleep face once when it goes to sleep and deep-sleeps until a key, the charger, or the next transition:
  midnight (the face's date) or the start of quiet hours, whichever comes first (quiet-hours end and the 03:00 install
  slot as before), capped at 8 h (`kMaxSleepS`, kept as the guard against a missed wake source). No backoff after
  failed wakes; Nobody home (#331) keeps its 2 h wakes. `wakeEvery` now only sets standby's cadence.
- Glance sleep outside quiet hours shows one calm face instead of the dashboard with #333's "Asleep" marks: "Asleep ·
  press to wake" (52 px), the date (no time of day), the "Today" row (#328's sources: weather high / low + rain from,
  the next event not over, bins collected today) and "as of HH:MM" only when the data was stale. Going to sleep from
  live is one full refresh (the face); `prepareSleep` no longer draws the home page first in glance.
- One painter for three faces (`ui_chrome.cpp sleepFace`, emulator Device.tsx SLEEP FACE): quiet hours (#295), Nobody
  home (#331) and glance sleep fill a title, a line under it, the Tomorrow / Today row or facts, a footer. Quiet and
  Nobody home look as before. Precedence: quiet hours, Nobody home, the Good morning page (#330), then the glance face.
- The face's region ("sleep") is rebuilt at each transition wake; the RTC snapshot diff redraws when its date or row
  changed, or (`stale`) when the last draw is over an hour old. HA unreachable at such a wake: the face is still
  redrawn when it changed without new data (the date at midnight), so the Today row can lose items it had (bins,
  agenda) until the next good wake.
- `quietTomorrow` / `quiet::tomorrow` now skip events that are over (end <= now); for the night face this changes
  nothing (tomorrow's events are not over). endHour 24 (`TODAY_END` / `quiet::kTodayEnd`) = always today.
- Firmware shows the face when asleep with `powerSave = glance` (like the Nobody home face), so a low-battery deep sleep
  in glance mode shows it too; the emulator keys on its `asleep.glance` flag and shows the standby face with "battery
  low" there.
- #357: a timer wake (glance, quiet-hours end, OTA) boots with the front light off (`lightOnBoot`, frontlight.json);
  the first key or tap turns it on and still acts (not consumed like the #220 timeout). Charger, key and power-on
  boots light up as before. The emulator also shows no light while asleep.
