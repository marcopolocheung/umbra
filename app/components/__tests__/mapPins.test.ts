// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { COIN_RADIUS, coinOutline } from "../../lib/lineBadges";
import { lineCoinElement } from "../mapPins";

const letterOf = (host: HTMLElement) => host.querySelector(":scope > span") as HTMLElement;

describe("lineCoinElement", () => {
  it("is a coin of the line's own colour inside an inked rim, with the line's letter", () => {
    const host = lineCoinElement("N", "#FCCC0A");
    expect(host.getAttribute("role")).toBe("img");
    expect(host.getAttribute("aria-label")).toBe("Line N");
    const coin = host.querySelector("[data-part='coin']") as SVGPathElement;
    expect(coin.getAttribute("fill")).toBe("#FCCC0A");
    expect(coin.getAttribute("stroke")).toBe("var(--color-line-ink-dark)");
    expect(coin.getAttribute("d")).toBe(coinOutline("N"));
    expect(letterOf(host).textContent).toBe("N");
    expect(letterOf(host).style.color).toBe("var(--color-line-ink-dark)");
    expect(host.querySelector("[data-part='disc']")).toBeNull();
  });

  it("sets the letter on a cream disc where no ink reads on the line's colour", () => {
    const host = lineCoinElement("7", "B933AD");
    // A bare-hex OSM colour is made valid CSS.
    expect((host.querySelector("[data-part='coin']") as SVGPathElement).getAttribute("fill")).toBe("#B933AD");
    expect((host.querySelector("[data-part='disc']") as SVGCircleElement).getAttribute("fill")).toBe("var(--color-line-ink-light)");
    expect(letterOf(host).style.color).toBe("var(--color-line-ink-dark)");
  });

  it("widens for a three-character route so it fits at the 11px floor", () => {
    expect((lineCoinElement("M15", "#0039A6").querySelector("[data-part='coin']") as SVGPathElement).getAttribute("d"))
      .toBe(coinOutline("M15", COIN_RADIUS + 4));
    expect(letterOf(lineCoinElement("M15", "#0039A6")).style.fontSize).toBe("11px");
  });

  it("is itself the 44px grip, the only part that takes the pointer", () => {
    const host = lineCoinElement("L", "#A7A9AC");
    expect([host.style.width, host.style.height]).toEqual(["44px", "44px"]);
    expect((host.querySelector("svg") as SVGSVGElement).style.pointerEvents).toBe("none");
  });
});
