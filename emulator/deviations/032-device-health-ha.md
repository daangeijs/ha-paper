22. **Device health in Home Assistant** (issue #32, not in the handoff). `core/haReport.ts`, vectors
    `spec/test-vectors/ha-report.json`. The device simulator POSTs battery, charging, Wi-Fi signal, last full
    refresh, last boot, firmware and reset reason to HA's `/api/states/<entity_id>` (entity id prefix = hostname
    slug, `ha_paper_a1b2`, one per display): on connect, on a battery or charging change and every 10 min, never twice
    in 60 s. Settings `display.haReport` (default on) turns it off; web console Settings card "Report to Home
    Assistant". The fake HA accepts `POST /api/states` from admin users only, like HA, and lists what it got at
    `GET /__fake/posted`. The simulator's preset link user "X4 display" is not an admin, so the main simulator gets
    401 and stops; the contract test links a second simulator as an admin. GET /status `ha_report`
    `{enabled, state: ok|off|waiting|not_admin|error, last_push_epoch}` shows it; the console's Device tab words it
    (`reportLine`), and the link page's "Advanced" text says health in HA needs an administrator. The browser
    emulator does not report (no HA); its `getHaReport` says ok since boot when linked.
