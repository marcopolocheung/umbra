// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { lineBadgeElement } from "../mapPins";

describe("lineBadgeElement", () => {
  it("fills a teardrop with the line's colour and inks the letter to read on it", () => {
    const badge = lineBadgeElement("N", "#FCCC0A");
    expect(badge.getAttribute("role")).toBe("img");
    expect(badge.getAttribute("aria-label")).toBe("Line N");
    // Not a control: it lets the map keep its gestures.
    expect(badge.style.pointerEvents).toBe("none");
    const pin = badge.firstElementChild as HTMLElement;
    expect(pin.style.background).toContain("rgb(252, 204, 10)");
    expect((pin.firstElementChild as HTMLElement).style.color).toBe("var(--color-line-ink-dark)");
    expect(pin.textContent).toBe("N");
  });

  it("rings the letter in the line's colour when no ink reads on the fill", () => {
    const pin = lineBadgeElement("7", "B933AD").firstElementChild as HTMLElement;
    expect(pin.style.background).toBe("var(--color-map-casing)");
    expect(pin.style.border).toContain("rgb(185, 51, 173)");
    expect((pin.firstElementChild as HTMLElement).style.color).toBe("var(--color-map-route)");
  });

  it("widens for a three-character route so the identifier fits", () => {
    expect(lineBadgeElement("M15", "#0039A6").style.width).toBe("34px");
    expect(lineBadgeElement("L", "#A7A9AC").style.width).toBe("28px");
  });
});
