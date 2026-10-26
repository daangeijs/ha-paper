import { describe, expect, it } from "vitest";
import { DEVICES, verifiedLine } from "../src/devices.ts";

describe("device tiles (#239)", () => {
  const x4 = DEVICES.find((d) => d.id === "x4pro")!;
  it("names the bundled release's manifest version", () => {
    expect(verifiedLine(x4, "0.2.0-beta.1")).toBe("v0.2.0-beta.1");
  });
  it("leaves the version out when the manifest didn't load", () => {
    expect(verifiedLine(x4)).toBe("");
  });
});
