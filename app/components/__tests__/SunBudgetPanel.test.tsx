/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SunBudgetPanel, { sunBudgetMessage } from "../SunBudgetPanel";

afterEach(cleanup);

const base = { status: "ready" as const, outcome: "exact" as const, provenCount: 40, undecidedCount: 0, sunMin: 8, walkMin: 20 };

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

  it("never says a street can't be reached", () => {
    const cases = [
      sunBudgetMessage({ ...base, outcome: "approximate", undecidedCount: 5 }),
      sunBudgetMessage({ ...base, outcome: "budget-exhausted", undecidedCount: 5 }),
      sunBudgetMessage({ ...base, provenCount: 0, undecidedCount: 5, outcome: "budget-exhausted" }),
      sunBudgetMessage({ ...base, status: "uncovered", outcome: null }),
    ];
    for (const m of cases) expect(`${m.headline} ${m.detail ?? ""}`).not.toMatch(/can't reach|unreachable|nowhere|impossible/i);
  });

  it("calls an empty result unconfirmed, not empty", () => {
    expect(sunBudgetMessage({ ...base, provenCount: 0 }).headline).toMatch(/^Nothing confirmed yet/);
  });

  it("at night, says the sun is down instead of budgeting sun that isn't there", () => {
    const m = sunBudgetMessage({ ...base, sunDown: true });
    expect(m.headline).toMatch(/sun is down/);
    expect(`${m.headline} ${m.detail}`).not.toMatch(/≤ 8 min/);
  });

  it("says plainly when the start is outside the shade data", () => {
    expect(sunBudgetMessage({ ...base, status: "uncovered", outcome: null }).headline).toMatch(/NYC shade data/);
  });
});

describe("SunBudgetPanel", () => {
  const props = {
    ...base,
    onSunMinChange: vi.fn(),
    onWalkMinChange: vi.fn(),
    onExit: vi.fn(),
  };

  it("labels the sun slider, speaks its value, and reports changes in minutes", () => {
    render(<SunBudgetPanel {...props} />);
    const slider = screen.getByLabelText("Most direct sun");
    expect(slider.getAttribute("aria-valuetext")).toBe("8 min of sun");
    fireEvent.change(slider, { target: { value: "12" } });
    expect(props.onSunMinChange).toHaveBeenCalledWith(12);
  });

  it("disables the sun slider when the sun is down", () => {
    render(<SunBudgetPanel {...props} sunDown />);
    expect((screen.getByLabelText("Most direct sun") as HTMLInputElement).disabled).toBe(true);
  });

  it("switches walking time and announces the result in a live region", () => {
    render(<SunBudgetPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "30 min walk" }));
    expect(props.onWalkMinChange).toHaveBeenCalledWith(30);
    expect(screen.getByRole("status").textContent).toContain("one way");
  });
});
