/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SunBudgetPanel, { sunBudgetMessage } from "../SunBudgetPanel";

afterEach(cleanup);

const shown = { sunMin: 8, walkMin: 20 };
const base = { status: "ready" as const, outcome: "exact" as const, provenCount: 40, undecidedCount: 0, shown };

describe("sunBudgetMessage", () => {
  it("gives each outcome its own words", () => {
    const exact = sunBudgetMessage(base);
    const approximate = sunBudgetMessage({ ...base, outcome: "approximate", undecidedCount: 5 });
    const exhausted = sunBudgetMessage({ ...base, outcome: "budget-exhausted", undecidedCount: 5 });
    const texts = [exact, approximate, exhausted].map((m) => `${m.headline} ${m.detail ?? ""}`);
    expect(new Set(texts).size).toBe(3);
    expect(exact.headline).toContain("in 20 min on ≤ 8 min of direct sun, one way");
    expect(exhausted.detail).toMatch(/stopped early/);
  });

  it("words the headline from the region on screen, not a slider that has moved on", () => {
    // The slider says 2; the map still shows the 8-minute result.
    expect(sunBudgetMessage({ ...base, shown: { sunMin: 8, walkMin: 20 } }).headline).toContain("≤ 8 min");
    expect(sunBudgetMessage({ ...base, shown: null }).headline).toMatch(/Finding/);
  });

  it("never says a street can't be reached", () => {
    const cases = [
      sunBudgetMessage({ ...base, outcome: "approximate", undecidedCount: 5 }),
      sunBudgetMessage({ ...base, outcome: "budget-exhausted", undecidedCount: 5 }),
      sunBudgetMessage({ ...base, provenCount: 0, undecidedCount: 5, outcome: "budget-exhausted" }),
      sunBudgetMessage({ ...base, status: "uncovered", outcome: null }),
    ];
    for (const m of cases) expect(`${m.headline} ${m.detail ?? ""}`).not.toMatch(/can't reach|unreachable|nowhere|impossible/i);
  });

  it("never mentions dashed streets when none are drawn", () => {
    const exhausted = sunBudgetMessage({ ...base, outcome: "budget-exhausted", undecidedCount: 0 });
    expect(`${exhausted.headline} ${exhausted.detail ?? ""}`).not.toMatch(/dashed/i);
  });

  it("calls an empty finished result unconfirmed, not 'yet'", () => {
    expect(sunBudgetMessage({ ...base, provenCount: 0 }).headline).toMatch(/^No street confirmed/);
  });

  it("at night, says the sun is down instead of budgeting sun that isn't there", () => {
    const m = sunBudgetMessage({ ...base, status: "sun-down" });
    expect(m.headline).toMatch(/sun is down/);
    expect(`${m.headline} ${m.detail}`).not.toMatch(/≤ 8 min/);
  });

  it("labels each outcome in its own words (#381)", () => {
    const plates = [
      sunBudgetMessage(base).plate,
      sunBudgetMessage({ ...base, outcome: "approximate", undecidedCount: 5 }).plate,
      sunBudgetMessage({ ...base, outcome: "budget-exhausted", undecidedCount: 5 }).plate,
    ];
    expect(plates).toEqual(["All streets", "Some confirmed", "Stopped early"]);
  });

  it("a region cut at the data's edge never claims every street, and says why (#380)", () => {
    const m = sunBudgetMessage({ ...base, clipped: true });
    expect(m.headline).not.toMatch(/^Every street/);
    expect(m.detail).toMatch(/edge of NYC's data/);
    expect(m.detail).toMatch(/streets near it may be missing/);
    expect(m.plate).not.toBe("All streets");
    const dashed = sunBudgetMessage({ ...base, clipped: true, outcome: "approximate", undecidedCount: 3 });
    expect(dashed.detail).toMatch(/weren't confirmed.*edge of NYC's data/);
  });

  it("says plainly when the start is outside the shade data", () => {
    expect(sunBudgetMessage({ ...base, status: "uncovered", outcome: null }).headline).toMatch(/NYC shade data/);
  });
});

describe("SunBudgetPanel", () => {
  const props = { ...base, sunMin: 8, walkMin: 20, onSunMinChange: vi.fn(), onWalkMinChange: vi.fn(), onExit: vi.fn() };

  it("labels the sun slider, speaks its value, and reports changes in minutes", () => {
    render(<SunBudgetPanel {...props} />);
    const slider = screen.getByLabelText("Most direct sun");
    expect(slider.getAttribute("aria-valuetext")).toBe("8 min of sun");
    fireEvent.change(slider, { target: { value: "12" } });
    expect(props.onSunMinChange).toHaveBeenCalledWith(12);
  });

  it("disables the sun slider when the sun is down", () => {
    render(<SunBudgetPanel {...props} status="sun-down" />);
    expect((screen.getByLabelText("Most direct sun") as HTMLInputElement).disabled).toBe(true);
  });

  it("states the walking pace it assumes", () => {
    render(<SunBudgetPanel {...props} />);
    expect(screen.getByText(/5 km\/h walk/)).toBeTruthy();
  });

  it("states the tapped walk's time and sun, rounded up so it never shows less sun (#379)", () => {
    const onHideWalk = vi.fn();
    render(<SunBudgetPanel {...props} walk={{ nodeIds: [1, 2], sunSec: 301, arrivalSec: 840 }} onHideWalk={onHideWalk} />);
    expect(screen.getByText("This walk: 14 min, 6 min of direct sun.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide walk" }));
    expect(onHideWalk).toHaveBeenCalled();
  });

  it("says plainly when the walk behind a street isn't available", () => {
    render(<SunBudgetPanel {...props} walk="none" />);
    expect(screen.getByText(/isn't available at this budget/)).toBeTruthy();
  });

  it("switches walking time and announces the result in a live region", () => {
    render(<SunBudgetPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "30 min walk" }));
    expect(props.onWalkMinChange).toHaveBeenCalledWith(30);
    expect(screen.getByRole("status").textContent).toContain("one way");
  });
});
