// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { COIN_RADIUS } from "../../lib/lineBadges";
import { lineCoinElement, placeStopFlagElement, STOP_FLAG_LEADER_PX, stopFlagElement } from "../mapPins";


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

describe("stopFlagElement", () => {
  const part = (host: HTMLElement, name: string) => host.querySelector(`[data-part='${name}']`) as HTMLElement;

  it("flies Enter here over a shield with the line and the stop's name", () => {
    const flag = stopFlagElement("enter", "N", "#FCCC0A", "Lexington Av/63 St", [0.6, 0.8]);
    expect(flag.getAttribute("aria-label")).toBe("Enter here: N, Lexington Av/63 St");
    expect(part(flag, "kicker").textContent).toBe("Enter here");
    expect(part(flag, "line").textContent).toBe("N");
    expect(part(flag, "stop-name").textContent).toBe("Lexington Av/63 St");
    expect(stopFlagElement("exit", "N", "#FCCC0A", "Canal St", [1, 0]).getAttribute("aria-label")).toBe("Exit here: N, Canal St");
  });

  it("rings the shield and dots the leader in the line's colour, and inks text to read", () => {
    const flag = stopFlagElement("enter", "N", "#FCCC0A", "Lexington Av/63 St", [0.6, 0.8]);
    expect(part(flag, "shield").style.border).toContain("rgb(252, 204, 10)");
    expect(part(flag, "leader").getAttribute("stroke")).toBe("#FCCC0A");
    expect(part(flag, "leader").getAttribute("stroke-dasharray")).toBe("0 6");
    expect(part(flag, "kicker").style.color).toBe("var(--color-line-ink-dark)");
    expect(part(flag, "stop-name").style.color).toBe("var(--color-line-ink-light)");
  });

  it("runs the leader away from the ride and opens the flag at its end", () => {
    const flag = stopFlagElement("exit", "L", "#A7A9AC", "1 Av", [0.6, 0.8]);
    // From just outside the stop's ring to the leader's length, along `toward`.
    expect(part(flag, "leader").getAttribute("d")).toBe(`M7.20,9.60L${(0.6 * STOP_FLAG_LEADER_PX).toFixed(2)},${(0.8 * STOP_FLAG_LEADER_PX).toFixed(2)}`);
    // Down and right: the flag hangs from its top-left corner.
    expect((part(flag, "shield").parentElement as HTMLElement).style.transform).toBe("translate(0%, 0%)");
  });

  it("marks a street door and starts its leader just beyond the dot", () => {
    const flag = stopFlagElement("enter", "E", "#B933AD", "Grid South", [1, 0], true);
    expect(part(flag, "door").style.border).toContain("rgb(185, 51, 173)");
    expect(part(flag, "leader").getAttribute("d")).toBe(`M6.00,0.00L${STOP_FLAG_LEADER_PX.toFixed(2)},0.00`);
    expect(part(stopFlagElement("exit", "E", "#B933AD", "Grid North", [1, 0]), "door")).toBeNull();
  });

  it("keeps a moving door's whole flag inside the phone map and hides it offscreen", () => {
    const flag = stopFlagElement("enter", "E", "#B933AD", "A long station name", [1, 0], true);
    const body = part(flag, "flag-body");
    Object.defineProperty(body, "offsetWidth", { value: 107 });
    Object.defineProperty(body, "offsetHeight", { value: 43 });
    Object.defineProperty(flag, "getBoundingClientRect", { value: () => ({ left: 200, top: 820 }) });
    const positioned = () => ({ left: 200 + Number.parseFloat(body.style.left), top: 820 + Number.parseFloat(body.style.top) });
    Object.defineProperty(body, "getBoundingClientRect", { value: () => {
      const { left, top } = positioned();
      return { left, top, right: left + 107, bottom: top + 43 };
    } });
    Object.defineProperty(part(flag, "kicker"), "getBoundingClientRect", { value: () => {
      const { left, top } = positioned();
      return { left, top, right: left + 120, bottom: top + 20 };
    } });
    // The shield extends beyond the flex wrapper's own box in a real browser.
    Object.defineProperty(part(flag, "shield"), "getBoundingClientRect", {
      value: () => {
        const { left, top } = positioned();
        return { left, top, right: left + 245, bottom: top + 50 };
      },
    });
    placeStopFlagElement(flag, [1, 0], { x: 200, y: 820 }, { width: 390, height: 844 }, true);
    expect(200 + Number.parseFloat(body.style.left)).toBe(137);
    expect(820 + Number.parseFloat(body.style.top)).toBe(762);
    placeStopFlagElement(flag, [-1, 0], { x: 400, y: 820 }, { width: 390, height: 844 }, true);
    expect(flag.style.display).toBe("none");
    placeStopFlagElement(flag, [-1, 0], { x: 200, y: 820 }, { width: 390, height: 844 }, true);
    expect(flag.style.display).toBe("");
    expect(part(flag, "leader").getAttribute("d")).toBe("M-6.00,0.00L0.00,-8.00");
  });

  it("rings the letter and plate on cream where no ink reads on the line's colour", () => {
    const flag = stopFlagElement("enter", "7", "B933AD", "Flushing–Main St", [1, 0]);
    expect(part(flag, "kicker").style.background).toBe("var(--color-line-ink-light)");
    expect(part(flag, "line").style.border).toContain("rgb(185, 51, 173)");
  });

  it("never takes the pointer", () => {
    expect(stopFlagElement("enter", "A", "#0039A6", "Fulton St", [0, 1]).style.pointerEvents).toBe("none");
  });
});
