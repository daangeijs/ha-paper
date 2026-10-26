20. **Ambient idle mode; night face as a poster** (issue #27, visual strategy; the handoff always showed the chrome
    and a "Night mode until … / Values as of … · tap anywhere" night face). `core/ambient.ts`, vectors
    `spec/test-vectors/ambient.json`. After 60 s without input (and no menu or setup open) the top bar drops the
    pager, the battery icon and the app label (with the sub-page "1 of 2"); the page title stays, centred. A page with
    a clock tile (Home) also drops the bar clock. Status icons (not linked, offline, sending, update, away, night,
    front light) stay: they are information. Battery stays below 20 %, the existing "NN%" threshold, not the 15 %
    the issue suggested: one low-battery rule. Entering and leaving is one partial of the top bar (≤ 64 px tall, B/W
    already, #38); the bar clock moves to the right edge while the pager is gone. The first touch, Prev, Next or Home
    only brings the chrome back (the click never reaches a button); Power is not consumed (goes straight to standby).
    Night face: no header, clock + date + three values (Inside, Battery, Cheapest); the footer reads "as of HH:MM"
    only when the last Home Assistant data was older than 30 min when the night face was drawn, else nothing.
