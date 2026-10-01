// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { COIN_RADIUS } from "../../lib/lineBadges";
import { lineCoinElement, stopLabelElement } from "../mapPins";


describe("lineCoinElement", () => {
  it("anchors a zero-size marker on the line, named for the line", () => {
    const { host } = lineCoinElement("N", "#FCCC0A");
    expect(host.getAttribute("role")).toBe("img");
    expect(host.getAttribute("aria-label")).toBe("Line N");
    expect([host.style.width, host.style.height]).toEqual(["0px", "0px"]);
  });

  it("welds in the line's own colour, cased in the map's paper, with the coin's disc unmasked on top", () => {
    const { joint, casing, fill, disc } = lineCoinElement("N", "#FCCC0A");
    expect(fill.getAttribute("fill")).toBe("#FCCC0A");
    expect(disc.getAttribute("fill")).toBe("#FCCC0A");
    expect(disc.getAttribute("r")).toBe(String(COIN_RADIUS));
    expect(casing.getAttribute("stroke")).toBe("var(--color-map-casing)");
    // The weld is masked to the ride and away from its stops; the disc is not.
    expect(joint.getAttribute("mask")).toMatch(/^url\(#line-coin-\d+-ride\)$/);
    expect(disc.parentElement).not.toBe(joint);
  });

  it("is grabbed only by its 44px grip, which carries the letter in a readable ink", () => {
    const { grip, host } = lineCoinElement("N", "#FCCC0A");
    expect([grip.style.width, grip.style.height]).toEqual(["44px", "44px"]);
    expect(grip.style.pointerEvents).toBe("auto");
    expect((host.querySelector("svg") as SVGSVGElement).style.pointerEvents).toBe("none");
    const letter = grip.querySelector("span") as HTMLElement;
    expect(letter.textContent).toBe("N");
    expect(letter.style.color).toBe("var(--color-line-ink-dark)");
  });

  it("sets the letter on a cream disc where no ink reads on the line's colour", () => {
    const { fill, grip } = lineCoinElement("7", "B933AD");
    // A bare-hex OSM colour is made valid CSS.
    expect(fill.getAttribute("fill")).toBe("#B933AD");
    expect((grip.querySelector("span") as HTMLElement).style.background).toBe("var(--color-line-ink-light)");
  });

  it("gives every coin its own clip and mask ids", () => {
    const a = lineCoinElement("A", "#0039A6").joint.getAttribute("mask");
    const b = lineCoinElement("A", "#0039A6").joint.getAttribute("mask");
    expect(a).not.toBe(b);
  });
});

describe("stopLabelElement", () => {
  it("names a stop on a plate in the map's overlay inks, and lets the map keep its gestures", () => {
    const label = stopLabelElement("34 St–Herald Sq");
    expect(label.textContent).toBe("34 St–Herald Sq");
    expect(label.style.background).toBe("var(--color-map-casing)");
    expect(label.style.color).toBe("var(--color-map-route)");
    expect(label.style.pointerEvents).toBe("none");
  });
});
