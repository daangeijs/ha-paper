1. **The web console is decoupled.** In the original, `webVm()` read and wrote the device component's state directly.
   Now the browser-side state (tab, draft, YAML, forms) lives in `src/webconsole/useConsole.ts`. Everything about the display goes
   through `DeviceApi`. As a result:
   - The session (`web.auth`) and API tokens are **device state** (`session`, `tokens`). Tokens store a hash plus a masked form, not the secret.
     The emulator records the secret on the "laptop" (`term.known`) when it is shown once; the terminal's `export` uses it.
   - The `web.auth === 'signing'` guard is browser-side (`signing`).
   - "Clear the draft after any config push" is driven by `configRev`, and "forget everything after a factory reset" by `installId`.
     Both appear in the snapshot.
   - `putConfig` in the in-memory API validates the YAML first (like `PUT /config`). The original pushed the draft without validating.
