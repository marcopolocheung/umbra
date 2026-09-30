// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import registryCss from "../../../globals.css?raw";
import Segmented from "../Segmented";

afterEach(cleanup);

describe("Segmented", () => {
  it("is a named group of pressed-state buttons that reports the chosen value", () => {
    const picked: string[] = [];
    render(
      <Segmented
        label="Route mode"
        value="walk"
        onChange={(v) => picked.push(v)}
        options={[
          { value: "walk", label: "Walk" },
          { value: "transit", label: "Transit" },
        ]}
      />,
    );
    const group = within(screen.getByRole("group", { name: "Route mode" }));
    expect(group.getByRole("button", { name: "Walk" }).getAttribute("aria-pressed")).toBe("true");
    expect(group.getByRole("button", { name: "Transit" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(group.getByRole("button", { name: "Transit" }));
    expect(picked).toEqual(["transit"]);
  });

  it("keeps a disabled option unpressable and lets an aria-label replace its name", () => {
    const picked: string[] = [];
    render(
      <Segmented
        label="Mode"
        value="a"
        onChange={(v) => picked.push(v)}
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B", disabled: true, ariaLabel: "Option B, unavailable" },
        ]}
      />,
    );
    const b = screen.getByRole("button", { name: "Option B, unavailable" });
    expect((b as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(b);
    expect(picked).toEqual([]);
  });

  it("selects by full ink inversion, at a 44px row, with an inset focus ring", () => {
    const css = registryCss.replace(/\s+/g, " ");
    expect(css).toContain('.umbra-segmented__option[aria-pressed="true"] { background: var(--color-ink); color: var(--color-on-ink); }');
    expect(css).toMatch(/\.umbra-segmented__option \{[^}]*min-height: 2\.75rem;/);
    expect(css).toContain(".umbra-segmented__option:focus-visible { outline: 2px solid currentColor; outline-offset: -4px; }");
    // Disabled text stays on the readable 75% role, never faded by opacity.
    expect(css).toMatch(/\.umbra-segmented__option:disabled \{ color: var\(--color-ink-muted\);/);
  });
});
