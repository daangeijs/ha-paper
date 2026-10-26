# Task watchdog (`hw/watchdog.h`, robustness plan phase 2)

Not in the handoff design. 30 s, panic on, for every image (confirmed or not); loopTask, `x4input`, `x4net` and
AsyncTCP's `async_tcp` are subscribed, IDLE0 stays watched as in the prebuilt sdkconfig. HTTP(S) requests and the
WebSocket TLS connect cannot feed from inside the library (a GitHub download follows a redirect: two DNS + connect +
handshake + header waits), so `x4net` leaves the watchdog for those calls (`wdt::BlockingCall`) under a 120 s esp_timer
backstop that aborts. TLS handshake timeout lowered from the library's 120 s to 10 s. The reset reason (TASK_WDT) and panic message land in the diagnostics boot ring (`net/diag.h`).
