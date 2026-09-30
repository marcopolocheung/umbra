import { describe, expect, it } from "vitest";
import { contrastRatio, lineBulletInk } from "../lineBulletInk";

describe("lineBulletInk", () => {
  it.each([
    // Published NYC subway colours: yellow N/Q/R, red 1/2/3, blue A/C/E, green 4/5/6, grey L.
    ["#FCCC0A", "dark"],
    ["#EE352E", "dark"],
    ["#0039A6", "light"],
    ["#00933C", "dark"],
    ["#A7A9AC", "dark"],
    ["#0070BD", "light"],
    // Mid-tones no ink reaches 4.5:1 on: the 7's purple, the J/Z brown.
    ["#B933AD", null],
    ["#996633", null],
  ] as const)("inks %s %s", (color, ink) => {
    expect(lineBulletInk(color)).toBe(ink);
  });

  it("never picks an ink under 4.5:1 on the fill", () => {
    for (const color of ["#FCCC0A", "#EE352E", "#0039A6", "#00933C", "#A7A9AC", "#B933AD", "#FF6319", "#996633", "#808183", "#6CBE45"]) {
      const ink = lineBulletInk(color);
      if (ink) expect(contrastRatio(color, ink === "dark" ? "#0b0b0b" : "#f8efdf")).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("reads three-digit hex and refuses names it cannot measure", () => {
    expect(lineBulletInk("#fc0")).toBe("dark");
    expect(lineBulletInk("red")).toBeNull();
    expect(lineBulletInk("")).toBeNull();
  });
});
