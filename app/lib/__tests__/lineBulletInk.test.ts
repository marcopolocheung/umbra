import { describe, expect, it } from "vitest";
import { contrastRatio, lineBulletInk, lineWhitePlateFill } from "../lineBulletInk";

describe("lineBulletInk", () => {
  it.each([
    // Published NYC subway colours: yellow N/Q/R, red 1/2/3, blue A/C/E, green 4/5/6, grey L.
    ["#FCCC0A", "dark"],
    ["#EE352E", "dark"],
    ["#0039A6", "light"],
    ["#00933C", "dark"],
    ["#A7A9AC", "dark"],
    ["#0070BD", "light"],
    // Cream narrowly misses these line colours; white clears 4.5:1.
    ["#B933AD", "white"],
    ["#996633", "white"],
  ] as const)("inks %s %s", (color, ink) => {
    expect(lineBulletInk(color)).toBe(ink);
  });

  it("never picks an ink under 4.5:1 on the fill", () => {
    for (const color of ["#FCCC0A", "#EE352E", "#0039A6", "#00933C", "#A7A9AC", "#B933AD", "#FF6319", "#996633", "#808183", "#6CBE45"]) {
      const ink = lineBulletInk(color);
      if (ink) expect(contrastRatio(color, { dark: "#0b0b0b", light: "#f8efdf", white: "#ffffff" }[ink])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("reads three-digit hex and refuses names it cannot measure", () => {
    expect(lineBulletInk("#fc0")).toBe("dark");
    expect(lineBulletInk("red")).toBeNull();
    expect(lineBulletInk("")).toBeNull();
    const contrastGap = `#${"77".repeat(3)}`;
    expect(lineBulletInk(contrastGap)).toBeNull();
  });
});

describe("lineWhitePlateFill", () => {
  it("keeps the purple hue and darkens green only enough for white text", () => {
    const green = lineWhitePlateFill("#00933C");
    expect(green).not.toBe("#00933C");
    expect(contrastRatio(green!, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(lineWhitePlateFill("#B933AD")).toBe("#b933ad");
  });

  it("leaves a bright line to use a solid text inset", () => {
    expect(lineWhitePlateFill("#FCCC0A")).toBeNull();
  });
});
