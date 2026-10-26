# Raw reset cause and task-watchdog record in /diagnostics (issue #241)

- `boots[].hw`: the chip's raw reset cause (`esp_rom_get_reset_reason(0)`) next to the IDF reason. TASK_WDT with
  `CORE_SW`/`CPU_SW` = the TWDT panic path reset the chip; with `CORE_MWDT0` = the watchdog's hardware stage did it
  (the interrupt never ran). The emulator and device-sim report `null` (no chip).
- `last_wdt`: written by the TWDT interrupt (`esp_task_wdt_isr_user_handler`, QEMU: `hw/qemu_hw.cpp`) into
  `RTC_NOINIT`: starved tasks, uptime, internal free and min DMA (lock-free counters); the largest internal block is the last
  10 s sample (`diagLoop`), since `heap_caps_get_largest_free_block` takes the heap lock the starved task may hold. The boot after it adds the last
  line of the previous log tail and, when no panic message was caught, sets `panic` to `task_wdt: <tasks>`. Kept until
  `DELETE /diagnostics`, the next timeout or a power cut. Emulator/device-sim: always `null`.
- The boot ring's RTC struct grew (`hw`, 16 B per boot): its magic changes, so the first boot of this image reloads
  the older boots from `/diag.json` instead of RTC memory.
- Not done: excusing a reset after a browser flash as "not a crash". The post-flash TASK_WDT on 2026-10-26 was
  followed by a second TASK_WDT 551 s later (#248), so it was most likely ours.
