// Web Serial + esptool-js connection. Kept apart from flow.ts so the flow tests don't load esptool-js.

import { ESPLoader, type IEspLoaderTerminal, Transport } from "esptool-js";
import type { Loader } from "./flow.ts";
import { hardReset } from "./reset.ts";

export const ESPRESSIF_VID = 0x303a;
export const USB_SERIAL_JTAG_PID = 0x1001;
// Same as the Makefile / x4flash.py. The X4 Pro's USB-Serial/JTAG port ignores it; a UART bridge needs it for a
// 16 MB backup in minutes instead of half an hour.
export const BAUD = 921600;

/** USB-Serial/JTAG has no real baud rate: skip esptool-js's port reopen for the baud change (it can reset some boards). */
export function romBaudFor(pid: number | undefined): number {
  return pid === USB_SERIAL_JTAG_PID ? BAUD : 115200;
}

export function webSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

export interface Connection {
  loader: Loader;
  description: string;
  /** Wi-Fi MAC as esptool prints it, "" when it can't be read. */
  mac: string;
  close(): Promise<void>;
}

export async function connect(terminal: IEspLoaderTerminal): Promise<Connection> {
  // Only Espressif devices are offered, like x4flash.py's port search.
  const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_VID }] });
  const pid = port.getInfo().usbProductId;
  const transport = new Transport(port, false);
  const loader = new ESPLoader({ transport, baudrate: BAUD, romBaudrate: romBaudFor(pid), terminal });
  try {
    // On the X4 Pro (303a:1001) "default_reset" runs esptool-js's UsbJtagSerialReset: the chip restarts into the ROM
    // bootloader over USB without any key, as long as the running firmware keeps USB-Serial/JTAG on.
    const description = await loader.main("default_reset");
    const l = loader as unknown as Loader;
    // esptool-js's own hard reset doesn't reset the chip; see reset.ts.
    l.after = () => hardReset(transport);
    const mac = await loader.chip.readMac(loader).catch(() => "");
    return {
      loader: l,
      description,
      mac,
      close: () => transport.disconnect(),
    };
  } catch (e) {
    await transport.disconnect().catch(() => {});
    throw e;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * After the install's hard reset the USB-Serial/JTAG device drops off the bus and comes back. Wait for the Espressif
 * port the user already allowed and open it at the firmware console's 115200 (Improv Wi-Fi, improv.ts). Null when it
 * doesn't come back in time.
 */
export async function reopenConsole(timeoutMs: number): Promise<SerialPort | null> {
  const deadline = Date.now() + timeoutMs;
  await sleep(1500); // the old port object is still there right after the reset
  while (Date.now() < deadline) {
    const ports = (await navigator.serial.getPorts()).filter((p) => p.getInfo().usbVendorId === ESPRESSIF_VID);
    for (const p of ports) {
      try {
        await p.open({ baudRate: 115200 });
        return p;
      } catch {
        // still enumerating, or the old object of the reset device
      }
    }
    await sleep(500);
  }
  return null;
}
