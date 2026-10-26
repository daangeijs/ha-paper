19. **Hardware-key factory reset and crash-loop offer** (issue #21, not in the handoff; the handoff only had the
    double-tap tile in Settings). `src/core/recovery.ts`, vectors `spec/test-vectors/recovery.json`. Hold Power + Right
    (exactly those two) for 5 s → "Factory reset?" screen. Release every key, then Right alone erases; any other key,
    Home or a touch cancels; 10 s without an answer cancels. After the screen goes away all keys must be released
    before a new hold counts (a key stuck down in a bag shows the screen once). Left is never in the combo: it is the
    GPIO0 download-mode strap at reset. At boot, ≥ 3 crash resets in a row at the top of the boot ring (PANIC, *_WDT,
    CPU_LOCKUP; BROWNOUT breaks the streak) offer the same screen with crash wording. The emulator has click-only
    keys, so Simulation › "Hold Power + Right" plays the 5 s hold and the release, and "Crash loop" reboots into the
    offer.
