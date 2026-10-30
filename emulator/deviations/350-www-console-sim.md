# Web console version in the simulator (issue #350)

- The firmware reads the console version from `/www/version.txt` inside the LittleFS image. The device simulator cannot
  read a LittleFS image: a `www.bin` accepted by `POST /api/v1/ota/upload-www` counts as the console of the running
  firmware version, and `sha256` is the upload's digest.
- After a simulated OTA the confirmed image's console is synced at once when the simulated release feed has that
  version (firmware: `wwwSync` downloads `www.bin` of release `v<version>` after the 60 s health check). An uploaded
  firmware without such a release leaves the console stale.
- The simulator serves its console from Vite, not from `www`: the "console out of date" page at `/` is firmware-only.
