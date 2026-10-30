import { describe, expect, it } from "vitest";
import { hardReset } from "../src/reset.ts";

describe("hard reset after a write (eink-ha-os#239)", () => {
  it("raises RTS with DTR low, waits, then drops RTS: the chip boots from flash", async () => {
    const calls: string[] = [];
    const t = {
      setDTR: async (s: boolean) => void calls.push(`DTR${+s}`),
      setRTS: async (s: boolean) => void calls.push(`RTS${+s}`),
    };
    await hardReset(t, async (ms) => void calls.push(`W${ms}`));
    expect(calls).toEqual(["DTR0", "RTS1", "W100", "RTS0", "W100"]);
  });
});
