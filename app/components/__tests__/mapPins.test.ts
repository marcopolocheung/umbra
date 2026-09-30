// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { blobOutline } from "../../lib/lineBadges";
import { lineBlobElement, orientLineBlob } from "../mapPins";

describe("lineBlobElement", () => {
  it("swells in the line's own colour, seamless, with the line's identifier on it", () => {
    const host = lineBlobElement("N", "#FCCC0A");
    expect(host.getAttribute("role")).toBe("img");
    expect(host.getAttribute("aria-label")).toBe("Line N");
    const blob = host.querySelector("[data-part='blob']") as SVGPathElement;
    expect(blob.getAttribute("fill")).toBe("#FCCC0A");
    // No outline: it is the line thickening, not a pin set on it.
    expect(blob.getAttribute("stroke")).toBeNull();
    expect(blob.getAttribute("d")).toBe(blobOutline("N"));
    const letter = host.querySelector("[data-part='grip'] span") as HTMLElement;
    expect(letter.textContent).toBe("N");
    expect(letter.style.color).toBe("var(--color-line-ink-dark)");
  });

  it("puts the letter on a casing disc where no ink reads on the line's colour", () => {
    const letter = lineBlobElement("7", "B933AD").querySelector("[data-part='grip'] span") as HTMLElement;
    expect(letter.style.color).toBe("var(--color-map-route)");
    expect(letter.style.background).toBe("var(--color-map-casing)");
  });

  it("catches the pointer only on a 44px grip, leaving the map its gestures", () => {
    const host = lineBlobElement("L", "#A7A9AC");
    expect(host.style.pointerEvents).toBe("none");
    const grip = host.querySelector("[data-part='grip']") as HTMLElement;
    expect(grip.style.pointerEvents).toBe("auto");
    expect([grip.style.width, grip.style.height]).toEqual(["44px", "44px"]);
  });

  it("turns the swelling with the track and leaves the letter upright", () => {
    const host = lineBlobElement("A", "#0039A6");
    orientLineBlob(host, 30);
    expect((host.querySelector("svg") as SVGSVGElement).style.rotate).toBe("30deg");
    expect((host.querySelector("[data-part='grip']") as HTMLElement).style.rotate).toBe("");
  });
});
