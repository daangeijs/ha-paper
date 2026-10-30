/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// base "./": the built page loads its script and firmware/ by relative URL, so the folder works at any path on any
// static host (e.g. daangeijs.nl/ha-paper/flash/). `make flasher` copies the release files into firmware/.
// For `npm run dev`, put release files under public/firmware/ (git-ignored), in either layout:
//   one version:   public/firmware/{manifest.json,SHA256SUMS,bootloader.bin,partitions.bin,boot_app0.bin,firmware.bin,www.bin}
//   several (eink-ha-os#239, like the Pages site): public/firmware/<version>/<the same seven files> plus
//                  public/firmware/versions.json = [{"version":"0.2.0-beta.1","prerelease":true,
//                  "date":"2026-10-26T12:00:00Z","path":"firmware/0.2.0-beta.1/"}] (newest date = latest).
// `gh release download v<version> -R daangeijs/ha-paper -D public/firmware/<version> -p '*.bin' -p manifest.json
// -p SHA256SUMS` fetches one release's files.
export default defineConfig({
  base: "./",
  build: { target: "es2022" },
  // the flow tests push 16 MB through esptool-js against a fake chip: ~1 s locally, 13 s on a GitHub runner
  test: { environment: "node", include: ["test/**/*.test.ts"], testTimeout: 60_000 },
});
