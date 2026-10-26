# Smaller net and web task stacks (issue #248)

- `x4net` 16 → 12 KB (`net/device_services.cpp`), `async_tcp` 16 → 10 KB (`CONFIG_ASYNC_TCP_STACK_SIZE`): 10 KB more
  internal RAM. Both stacks stay internal: these tasks write flash (settings, LittleFS, OTA), which a PSRAM stack can't.
- Measured peak use (FreeRTOS high-water): x4net 5.1 KB on the X4 Pro (HA TLS, reports; mem6 log), 5.6 KB in QEMU
  (TLS to the fake HA, 20 PUTs of a 10-screen config); async_tcp 840 B on the X4 Pro, 4.7 KB in QEMU during a full
  OTA upload. Margin ≥ 5.4 KB. Not measured: a GitHub release check on x4net on the device with the smaller stack.
