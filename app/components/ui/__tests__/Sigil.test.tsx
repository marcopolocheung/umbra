// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import Sigil, { UMBRA_DISC_PATH, type SigilName } from "../Sigil";

afterEach(cleanup);

it("uses one original disc path for the app and install icon", () => {
  const { container } = render(<Sigil name="disc" />);
  const path = container.querySelector("path");
  expect(path?.getAttribute("d")).toBe(UMBRA_DISC_PATH);
  expect(path?.getAttribute("fill-rule")).toBe("evenodd");
  expect(readFileSync(resolve("public/pwa-icon.svg"), "utf8")).toContain(UMBRA_DISC_PATH);
});

it("gives every core meaning a distinct decorative vector", () => {
  const names: SigilName[] = ["sun", "shade", "tree", "rain", "transit", "walk"];
  const drawings = names.map((name) => {
    const { container, unmount } = render(<Sigil name={name} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    const drawing = svg?.innerHTML;
    unmount();
    return drawing;
  });
  expect(new Set(drawings).size).toBe(names.length);
});
