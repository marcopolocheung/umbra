/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DirectionsPanel from "../DirectionsPanel";

/**
 * There is no `setupFiles` in vitest.config.ts, so unmounting is this file's job.
 */
afterEach(cleanup);

function renderPanel(
  props: { travelMode?: "walk" | "bike"; routeMode?: "walk" | "transit" } = {},
) {
  const onTravelModeChange = vi.fn();
  render(
    <DirectionsPanel
      waypointA={null}
      waypointB={null}
      waypointALabel={null}
      waypointBLabel={null}
      onSetWaypointA={vi.fn()}
      onSetWaypointB={vi.fn()}
      onSwapWaypoints={vi.fn()}
      onClearWaypointA={vi.fn()}
      onClearWaypointB={vi.fn()}
      onClear={vi.fn()}
      onCalculate={vi.fn()}
      isCalculating={false}
      routes={[]}
      selectedRouteIndex={0}
      onSelectRoute={vi.fn()}
      error={null}
      pendingSlot={null}
      onSetPendingSlot={vi.fn()}
      onBack={vi.fn()}
      onTravelModeChange={onTravelModeChange}
      {...props}
    />,
  );
  return { onTravelModeChange };
}

function travelButtons() {
  return within(screen.getByTestId("travel-mode-selector"));
}

describe("DirectionsPanel — travel mode selector (E1)", () => {
  it("shows Walk/Bike and reports a Bike click", () => {
    const { onTravelModeChange } = renderPanel({ travelMode: "walk" });

    const bike = travelButtons().getByRole("button", { name: "Bike" });
    expect(bike.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(bike);
    expect(onTravelModeChange).toHaveBeenCalledTimes(1);
    expect(onTravelModeChange).toHaveBeenCalledWith("bike");
  });

  it("marks the active mode pressed", () => {
    renderPanel({ travelMode: "bike" });

    expect(travelButtons().getByRole("button", { name: "Bike" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(travelButtons().getByRole("button", { name: "Walk" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("hides the selector on the transit tab", () => {
    renderPanel({ routeMode: "transit" });

    expect(screen.queryByTestId("travel-mode-selector")).toBeNull();
  });
});
