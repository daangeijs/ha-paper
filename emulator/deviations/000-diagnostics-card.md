11. **Diagnostics card** (Device tab; ROBUSTNESS_PLAN Phase 1, not in the handoff). Reads `GET /api/v1/diagnostics`: this
    boot's reset reason, the last crash (reason, firmware, how long that boot ran, panic message), the core dump task/PC
    with a download link, heap and panel controller; "Clear" = `DELETE /api/v1/diagnostics`. The in-memory emulator
    never crashes (one POWERON boot); the device-sim crashes on `POST /__sim/control {crash: panic|task_wdt|brownout}`.
    Ring logic: `src/core/diag.ts`, vectors `spec/test-vectors/diag.json`.
