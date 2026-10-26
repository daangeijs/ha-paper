# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: **Security → Report a vulnerability** on this repository
(a private security advisory). Don't open a public issue for them. Include the firmware version
(`GET /api/v1/status`), what you did and what happened.

## Scope

- The device web API and web console (`/api/v1/…`, sessions, API tokens, the setup flow).
- Handling of the Home Assistant credentials: OAuth sign-in, refresh token storage, the HA connection.
- Updates: OTA download and LAN upload (`POST /api/v1/ota/upload`), the SHA-256 image check, rollback. Images are
  checked against the manifest's SHA-256, not signed.
- The USB and browser flashers (`x4flash.py`, `flasher/`), including Improv Wi-Fi setup over serial.

Known limitations, not vulnerabilities: device traffic is plain HTTP on the local network; flash encryption and secure
boot are not enabled; anyone with physical access can re-flash the device or read its flash. Details:
[docs/FLASHING.md](docs/FLASHING.md) §7.

## What the device stores

- The Home Assistant **refresh token** (or the long-lived access token, if you linked with one) and the **Wi-Fi
  password**, AES-256-GCM encrypted in NVS with a key derived from the chip's MAC and a unique eFuse ID. A flash dump
  alone does not reveal them; someone holding the device can derive the key.
- **API tokens** as SHA-256 hashes only; the token itself is shown once when it is created.
- **Never the Home Assistant password.** Sign-in goes through Home Assistant's own login page; the password is not
  stored or logged.
