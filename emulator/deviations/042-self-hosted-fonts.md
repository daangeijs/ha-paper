# Self-hosted fonts (issue #42)

- The handoff pages loaded IBM Plex (and the dashboard faces) from Google Fonts. The console now ships IBM's own
  Latin1 woff2 subsets of Plex Sans 400/500/600 and Plex Mono 400/500 (`src/fonts/plex.css`, OFL, ~101 KB in www);
  the emulator page loads the firmware's TTFs from `firmware/assets/fonts` (`src/fonts/dashboard.css`). Plex Mono 600
  is synthesised from 500, as it was with Google's CSS. → and ✓ are not in the subset and come from the system font.
  `offline.test.ts` (emulator and flasher) fails on any resource URL to another host in the built pages.
