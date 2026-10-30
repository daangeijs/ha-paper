# QEMU build (`env:x4qemu`, `make qemu`)

Same sources as `x4pro`, under `X4_QEMU`: Serial on UART0; Espressif's `open_eth` NIC instead of Wi-Fi (reported as connected
SSID `QEMU-ETH`, always saved; Disconnect/Forget take the link down logically); no mDNS / SoftAP / captive DNS;
`hw/qemu_hw.cpp` instead of `hw/x4_*.cpp` (null display that keeps the last frame, scripted input, battery 80 %, no
I2C/LEDC; the panel/touch/gauge libraries are not linked because `analogRead()` pulls in IDF's ADC self-calibration
constructor, which spins forever on QEMU's missing SAR ADC); OTA health deadline 45 s instead of 10 min. Debug
endpoints without auth: `GET /__qemu/framebuffer.pgm`, `POST /__qemu/input?tap=x,y|key=…|swipe=±1`, `GET /__qemu/state`.
A task-watchdog timeout resets through the TWDT ISR hook (reason TASK_WDT) instead of panicking: QEMU's panic
handler does not reset. QEMU's MWDT never counts, so the TWDT never fires there at all; `env:x4qemu_wdttest` checks
the TWDT bookkeeping after the hang and calls that hook itself (docs/ESP32_EMULATION.md).
The vendored `open_eth` MAC driver (`sim/qemu/lib/qemu_openeth`) restarts its RX/TX rings at descriptor 0 on every
link-up, as QEMU does when RXEN/TXEN are set; upstream keeps its old position, which after a `set_link off/on` left the
NIC with a link and no traffic (eink-ha-os#108). `GET /__qemu/state` adds `eth` (link, ip, link_ups/link_downs, leases,
lease_age_s, rx_skew); `make qemu-linkdrop` checks N link drops.
