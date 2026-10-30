# Agenda and Next tiles: fetch and cache are firmware only (issue #316)

- The emulator draws its demo week (`core/agenda.ts` `demoAnswer`) through the same parser and never calls HA; the
  fake HA answers `calendar.get_events` with that week. The call, the plan and the cache exist only in the firmware
  (`core/agenda.{h,cpp}` Fetcher, glue in `net/ha_client.cpp`, `net/device_services.cpp`).
- One `calendar.get_events` (return_response) per calendar set, one request in flight, every 30 min and at the local
  day change; 5 min after a failed answer; a request unanswered for 60 s is given up. All sets of the config are kept
  fresh, on screen or not (history tiles fetch only the app on screen).
- The answer streams through `agenda::Scanner` (no DOM, no copy of the frame); a failed or broken answer keeps the
  events the set had. The kept events (≤ 12 per set) are written to `/agenda.txt` on userdata after each answer and
  read at boot, so a glance wake from deep sleep shows them at once and asks HA only when they are 30 min old or the day
  changed. The emulator has no such cache.
- Diagnostics: the serial log only (`AGENDA ask`, `AGENDA answer <id> <bytes> B: internal low-water`); no
  `/__qemu/state` or console block.
