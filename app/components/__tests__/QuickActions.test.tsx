/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import QuickActions from "../QuickActions";

afterEach(cleanup);

describe("QuickActions as the idle empty state (R8c)", () => {
  it("pairs a kicker with a title that says nothing is planned", () => {
    render(<QuickActions onNavigate={vi.fn()} onDrawRoute={vi.fn()} drawMode={false} />);

    expect(screen.getByText("Before you set out").className).toContain("umbra-kicker");
    expect(screen.getByRole("heading", { name: "Nothing planned yet" })).toBeTruthy();
  });

  it("starts directions or draw mode, and says whether draw mode is on", () => {
    const onNavigate = vi.fn();
    const onDrawRoute = vi.fn();
    const { rerender } = render(<QuickActions onNavigate={onNavigate} onDrawRoute={onDrawRoute} drawMode={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Directions" }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    const draw = screen.getByRole("button", { name: "Draw route" });
    expect(draw.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(draw);
    expect(onDrawRoute).toHaveBeenCalledTimes(1);

    rerender(<QuickActions onNavigate={onNavigate} onDrawRoute={onDrawRoute} drawMode />);
    expect(screen.getByRole("button", { name: "Draw route" }).getAttribute("aria-pressed")).toBe("true");
  });
});
