8. **Hostname.** The handoff uses `x4-home.local` (product renamed to HA Paper in #217). Each display now announces `ha-paper-XXXX.local` (last 4 hex digits of
   its Wi-Fi MAC) so two displays on one network don't clash. The emulator and the device simulator use the fixed fake
   `ha-paper-a1b2` (`src/core/data.ts` `HOST`). The device and the web console show it; `/status` and `/console/state`
   return it as `hostname`. Owner requirement: the IP must work as well as the name. The device shows both
   ("ha-paper-a1b2.local or 192.168.1.42", `SIM_IP`) and its QR placeholders now carry the IP (`http://192.168.1.42`,
   `…/link?p=CODE`), as the firmware's real QR codes do.
