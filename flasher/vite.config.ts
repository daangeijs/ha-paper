/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// base "./": the built page loads its script and firmware/ by relative URL, so the folder works at any path on any
// static host (e.g. daangeijs.nl/ha-paper/flash/). `make flasher` copies the release files into firmware/.
// For `npm run dev`, copy the files from `make dist` (plus a SHA256SUMS) into public/firmware/ (git-ignored).
export default defineConfig({
  base: "./",
  build: { target: "es2022" },
  // the flow tests push 16 MB through esptool-js against a fake chip: ~1 s locally, 13 s on a GitHub runner
  test: { environment: "node", include: ["test/**/*.test.ts"], testTimeout: 60_000 },
});
