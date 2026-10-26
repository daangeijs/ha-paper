// Devices the flasher offers (#239). Every release is tested on a real X4 Pro before it ships (Daan, 2026-10-26),
// so the tested line names the bundled release's version.

export interface Device {
  id: string;
  name: string;
}

export const DEVICES: readonly Device[] = [{ id: "x4pro", name: "Xteink X4 Pro" }];

/** Shown after the verified icon: "v0.2.0-beta.1"; empty (badge hidden) without a loaded manifest. */
export function verifiedLine(_d: Device, version?: string): string {
  return version ? `v${version}` : "";
}
