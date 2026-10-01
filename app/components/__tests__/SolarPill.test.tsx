/* @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import SolarPill from "../SolarPill";

afterEach(cleanup);

/**
 * R6b: below the horizon the pill says the sun is down. It used to call any
 * intensity under 0.15 "Low sun", which at 22:00 implied the sun was up.
 */
describe("SolarPill", () => {
  it("says the sun is down after sunset, whatever the intensity", () => {
    render(<SolarPill intensity={0} afterSunset />);
    expect(screen.getByText("Sun down — no direct sun")).toBeTruthy();
    expect(screen.queryByText(/Low sun/)).toBeNull();
  });

  it("keeps the three daylight tiers while the sun is up", () => {
    const { rerender } = render(<SolarPill intensity={0.05} />);
    expect(screen.getByText("Low sun — shadow routing minimal")).toBeTruthy();
    rerender(<SolarPill intensity={0.4} />);
    expect(screen.getByText("Moderate solar load")).toBeTruthy();
    rerender(<SolarPill intensity={0.9} />);
    expect(screen.getByText("High solar load — shadow matters")).toBeTruthy();
  });

  it("is a square tag, with orange only while the sun loads the route", () => {
    const { rerender } = render(<SolarPill intensity={0} afterSunset />);
    const down = screen.getByText(/Sun down/);
    expect(down.className).toContain("umbra-tag--neutral");
    expect(down.getAttribute("style") ?? "").not.toContain("sun");
    rerender(<SolarPill intensity={0.9} />);
    expect(screen.getByText(/High solar load/).getAttribute("style")).toContain("var(--color-sun-signal)");
  });
});
