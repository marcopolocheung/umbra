/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DirectionsPanel from "../DirectionsPanel";
import type { RouteOption } from "../../lib/routing";

/**
 * There is no `setupFiles` in vitest.config.ts, so unmounting is this file's job.
 */
afterEach(cleanup);

function renderPanel(
  props: { travelMode?: "walk" | "bike" | "scoot"; routeMode?: "walk" | "transit" } = {},
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

  it("offers Scoot alongside Walk/Bike and reports a Scoot click", () => {
    const { onTravelModeChange } = renderPanel({ travelMode: "walk" });

    // The Scoot button carries a fuller aria-label (kick vs electric), so
    // match it loosely — the same way a substring-matching assistive query
    // would. "Bike" must still resolve to exactly the Bike button (E1).
    const scoot = travelButtons().getByRole("button", { name: /scoot/i });
    expect(travelButtons().getByRole("button", { name: "Bike" })).toBeTruthy();
    expect(scoot.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(scoot);
    expect(onTravelModeChange).toHaveBeenCalledTimes(1);
    expect(onTravelModeChange).toHaveBeenCalledWith("scoot");
  });

  it("hides the selector on the transit tab", () => {
    renderPanel({ routeMode: "transit" });

    expect(screen.queryByTestId("travel-mode-selector")).toBeNull();
  });
});

const LINE: GeoJSON.Feature<GeoJSON.LineString> = {
  type: "Feature",
  properties: {},
  geometry: { type: "LineString", coordinates: [] },
};

const ROUTE: RouteOption = {
  label: "Shortest",
  geojson: LINE,
  distanceM: 600,
  shadowCoverage: 0.3,
  longestContinuousShadowM: 0,
  longestContinuousSunM: 0,
  shadowTransitions: 0,
  detourRatio: 1,
  turnCount: 0,
};

describe("DirectionsPanel — planning collapse (U3)", () => {
  function renderWithRoutes(extra: Record<string, unknown> = {}) {
    const onCalculate = vi.fn();
    render(
      <DirectionsPanel
        waypointA={[-73.9855, 40.753]}
        waypointB={[-73.9825, 40.755]}
        waypointALabel="Start point"
        waypointBLabel="End point"
        onSetWaypointA={vi.fn()}
        onSetWaypointB={vi.fn()}
        onSwapWaypoints={vi.fn()}
        onClearWaypointA={vi.fn()}
        onClearWaypointB={vi.fn()}
        onClear={vi.fn()}
        onCalculate={onCalculate}
        isCalculating={false}
        routes={[ROUTE]}
        selectedRouteIndex={0}
        onSelectRoute={vi.fn()}
        error={null}
        pendingSlot={null}
        onSetPendingSlot={vi.fn()}
        onBack={vi.fn()}
        onTravelModeChange={vi.fn()}
        {...extra}
      />,
    );
    return { onCalculate };
  }

  it("collapses the planning form to the trip bar once options exist", () => {
    renderWithRoutes();

    // The route stack starts at the top of the sheet's first snap point, not
    // below the whole planning form.
    expect(screen.queryByTestId("travel-mode-selector")).toBeNull();
    expect(screen.queryByPlaceholderText("Start — type or click map")).toBeNull();
    expect(screen.getByRole("button", { name: /Edit trip: Start point to End point/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Edit trip: Start point to End point/ }).textContent).toContain("Start point");
    expect(screen.getByRole("button", { name: /Edit trip: Start point to End point/ }).textContent).toContain("End point");
    expect(screen.getByText("Shortest")).toBeTruthy();
  });

  it("reopens the form on Edit; recalculating folds it away again", () => {
    const { onCalculate } = renderWithRoutes();

    fireEvent.click(screen.getByRole("button", { name: /Edit trip: Start point to End point/ }));
    expect(screen.getByTestId("travel-mode-selector")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Find Shadowed Route" }));
    expect(onCalculate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("travel-mode-selector")).toBeNull();
  });

  it("keeps the form open while a pin slot is pending on the map", () => {
    renderWithRoutes({ pendingSlot: "A" });

    expect(screen.getByTestId("travel-mode-selector")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Edit trip: Start point to End point/ })).toBeNull();
  });
});
