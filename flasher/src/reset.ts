// Hard reset after a write, separate from serial.ts so it can be tested without esptool-js.
//
// esptool-js 0.7.0's HardReset only sets RTS low (lib/reset.js). It never raises RTS first, and after its
// USB-Serial/JTAG connect sequence RTS is already low, so `after("hard_reset")` changes no line and the chip stays
// in the flasher stub (#239: the display didn't restart after an install until the cable was re-plugged).
// esptool (Python, `make flash`) raises RTS, waits 100 ms and drops it. With DTR low the chip then boots from flash.
// The same sequence resets a UART bridge board (RTS drives EN).

export interface Signals {
  setDTR(state: boolean): Promise<void>;
  setRTS(state: boolean): Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function hardReset(t: Signals, sleep: (ms: number) => Promise<void> = wait): Promise<void> {
  await t.setDTR(false); // IO0 not forced low: boot from flash, not download mode
  await t.setRTS(true); // chip in reset
  await sleep(100);
  await t.setRTS(false); // release: the app starts
  await sleep(100);
}
