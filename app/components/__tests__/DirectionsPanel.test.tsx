/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DirectionsPanel from "../DirectionsPanel";
import type { DirectionsPanelProps } from "../DirectionsPanel";
import type { ResolvedExposureContext } from "../../lib/exposure";
import type { RouteOption } from "../../lib/routing";

/**
 * There is no `setupFiles` in vitest.config.ts, so unmounting is this file's job.
 */
afterEach(cleanup);

function renderPanel(
  props: Partial<DirectionsPanelProps> = {},
) {
  const onTravelModeChange = vi.fn();
  const onCalculate = vi.fn();
  const base: DirectionsPanelProps = {
    waypointA: null, waypointB: null, waypointALabel: null, waypointBLabel: null,
    onSetWaypointA: vi.fn(), onSetWaypointB: vi.fn(), onSwapWaypoints: vi.fn(),
    onClearWaypointA: vi.fn(), onClearWaypointB: vi.fn(), onClear: vi.fn(),
    onCalculate, isCalculating: false, routes: [], selectedRouteIndex: 0,
    onSelectRoute: vi.fn(), error: null, pendingSlot: null, onSetPendingSlot: vi.fn(),
    onBack: vi.fn(), onTravelModeChange,
    selectedTime: new Date("2026-06-21T18:20:00Z"), mapUtcOffsetMin: -240,
    solarPosition: null, sunset: null, weather: null, onOpenTimeline: vi.fn(),
  };
  const view = render(<DirectionsPanel {...base} {...props} />);
  return { onTravelModeChange, onCalculate, rerender: (next: Partial<DirectionsPanelProps>) => view.rerender(<DirectionsPanel {...base} {...props} {...next} />) };
}

function travelButtons() {
  return within(screen.getByRole("group", { name: "Travel by" }));
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

  it("keeps one mode group when transit is selected", () => {
    renderPanel({ routeMode: "transit" });

    expect(travelButtons().getByRole("button", { name: "Transit" }).getAttribute("aria-pressed")).toBe("true");
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
    const base: DirectionsPanelProps = {
      waypointA: [-73.9855, 40.753], waypointB: [-73.9825, 40.755],
      waypointALabel: "Start point", waypointBLabel: "End point",
      onSetWaypointA: vi.fn(), onSetWaypointB: vi.fn(), onSwapWaypoints: vi.fn(),
      onClearWaypointA: vi.fn(), onClearWaypointB: vi.fn(), onClear: vi.fn(),
      onCalculate, isCalculating: false, routes: [ROUTE], selectedRouteIndex: 0,
      onSelectRoute: vi.fn(), error: null, pendingSlot: null,
      onSetPendingSlot: vi.fn(), onBack: vi.fn(), onTravelModeChange: vi.fn(),
      selectedTime: new Date("2026-06-21T18:20:00Z"), mapUtcOffsetMin: -240,
      solarPosition: null, sunset: null, weather: null, onOpenTimeline: vi.fn(),
    };
    const view = render(<DirectionsPanel {...base} {...extra} />);
    return { onCalculate, rerender: (next: Partial<DirectionsPanelProps>) => view.rerender(<DirectionsPanel {...base} {...extra} {...next} />) };
  }

  it("collapses the planning form to the trip bar once options exist", () => {
    renderWithRoutes();

    // The route stack starts at the top of the sheet's first snap point, not
    // below the whole planning form.
    expect(screen.queryByRole("group", { name: "Travel by" })).toBeNull();
    expect(screen.queryByPlaceholderText("Choose a start")).toBeNull();
    expect(screen.getByRole("button", { name: /Edit trip: Start point to End point/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Edit trip: Start point to End point/ }).textContent).toContain("Start point");
    expect(screen.getByRole("button", { name: /Edit trip: Start point to End point/ }).textContent).toContain("End point");
    expect(screen.getByText("Shortest")).toBeTruthy();
  });

  it("reopens on Edit, keeps Find busy, then folds after recalculation", () => {
    const { onCalculate, rerender } = renderWithRoutes();

    fireEvent.click(screen.getByRole("button", { name: /Edit trip: Start point to End point/ }));
    expect(screen.getByRole("group", { name: "Travel by" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Find the shade" }));
    expect(onCalculate).toHaveBeenCalledTimes(1);
    rerender({ isCalculating: true });
    expect((screen.getByRole("button", { name: /Calculating/ }) as HTMLButtonElement).disabled).toBe(true);
    rerender({ isCalculating: false });
    expect(screen.queryByRole("group", { name: "Travel by" })).toBeNull();
  });

  it("keeps the form open while a pin slot is pending on the map", () => {
    renderWithRoutes({ pendingSlot: "A" });

    expect(screen.getByRole("group", { name: "Travel by" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Edit trip: Start point to End point/ })).toBeNull();
  });

  it("keeps Dodge available beside results so the objective can change", () => {
    const onRainModeChange = vi.fn();
    renderWithRoutes({ onRainModeChange });
    fireEvent.click(within(screen.getByRole("group", { name: "Dodge" })).getByRole("button", { name: "Rain" }));
    expect(onRainModeChange).toHaveBeenCalledWith(true);
  });
});

describe("DirectionsPanel — warning placement (U4 serial position)", () => {
  const NOTICE = "Some streets had no sidewalk data";

  function route(label: string): RouteOption {
    return { ...ROUTE, label };
  }

  function routes(n: number): RouteOption[] {
    return ["Shortest", "Balanced", "Most shadowed", "Longest"].slice(0, n).map(route);
  }

  function renderWithWarning(n: number) {
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
        onCalculate={vi.fn()}
        isCalculating={false}
        routes={routes(n)}
        selectedRouteIndex={0}
        onSelectRoute={vi.fn()}
        error={null}
        pendingSlot={null}
        onSetPendingSlot={vi.fn()}
        onBack={vi.fn()}
        selectedTime={new Date("2026-06-21T18:20:00Z")}
        mapUtcOffsetMin={-240}
        solarPosition={null}
        sunset={null}
        weather={null}
        onOpenTimeline={vi.fn()}
        warning={NOTICE}
      />,
    );
  }

  function cardsAndNotices() {
    const group = screen.getByRole("radiogroup", { name: "Route options" });
    // The DOM order inside the group is the visual order of the stack.
    return Array.from(group.children).map((child) =>
      child.textContent?.startsWith(NOTICE) ? "notice" : "card",
    );
  }

  it("leads the stack with the notice while there are at most three options", () => {
    renderWithWarning(3);
    expect(cardsAndNotices()).toEqual(["notice", "card", "card", "card"]);
  });

  it("moves the notice above the weakest viable card once the stack passes three", () => {
    renderWithWarning(4);
    expect(cardsAndNotices()).toEqual(["card", "card", "notice", "card", "card"]);
  });
});

describe("DirectionsPanel chrome (R5b)", () => {
  it("says on screen why Transit is off, not only in a tooltip touch never shows", () => {
    renderPanel({ canTransit: false });
    const transit = screen.getByRole("button", { name: "Transit" }) as HTMLButtonElement;
    expect(transit.disabled).toBe(true);
    expect(screen.getByText("Transit needs a start and a destination")).toBeTruthy();
  });

  it("names every segmented control as a group", () => {
    renderPanel();
    for (const name of ["Travel by", "Dodge"]) {
      expect(screen.getByRole("group", { name })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Swap start and destination" })).toBeTruthy();
  });
});

describe("DirectionsPanel — Find readiness", () => {
  const start: [number, number] = [-73.9855, 40.753];
  const end: [number, number] = [-73.9825, 40.755];

  it("does not render Find until both endpoints are set", () => {
    renderPanel({ waypointA: start });
    expect(screen.queryByRole("button", { name: "Find the shade" })).toBeNull();
  });

  it("renders Find with two endpoints and invokes calculation", () => {
    const { onCalculate } = renderPanel({ waypointA: start, waypointB: end });
    fireEvent.click(screen.getByRole("button", { name: "Find the shade" }));
    expect(onCalculate).toHaveBeenCalledOnce();
  });

  it("requires two sketch points even without endpoints", () => {
    renderPanel({ drawMode: true, sketchPointCount: 1 });
    expect(screen.queryByRole("button", { name: "Find the shade" })).toBeNull();
    cleanup();
    renderPanel({ drawMode: true, sketchPointCount: 2 });
    expect(screen.getByRole("button", { name: "Find the shade" })).toBeTruthy();
  });

  it("keeps Find mounted, disabled, and busy during calculation", () => {
    renderPanel({ waypointA: start, waypointB: end, isCalculating: true });
    const button = screen.getByRole("button", { name: /Calculating/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  it("keeps a sketch Find mounted when calculation exits draw mode", () => {
    const { rerender } = renderPanel({ drawMode: true, sketchPointCount: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Find the shade" }));
    rerender({ drawMode: false, isCalculating: true });
    const button = screen.getByRole("button", { name: /Calculating/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  it("gives two mounted panels distinct mist filters", () => {
    renderPanel();
    renderPanel();
    const ids = [...document.querySelectorAll(".directions-filter filter")].map((element) => element.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("opens the timeline when the rubber stamp is tapped", () => {
    const onOpenTimeline = vi.fn();
    renderPanel({ onOpenTimeline });
    fireEvent.click(screen.getByRole("button", { name: /Leaves at 2:20 PM. Change time/ }));
    expect(onOpenTimeline).toHaveBeenCalledOnce();
  });
});

describe("DirectionsPanel — solar pill after sunset (R6b)", () => {
  /** Evaluated in Midtown: 03:00Z is 23:00 EDT, 10:00Z is 06:00 EDT (sun up, low). */
  function renderAt(iso: string, solarIntensity: number) {
    const evaluatedContext = {
      objective: "sun",
      time: new Date(iso),
      referenceLocation: { lat: 40.754, lng: -73.984 },
    } as ResolvedExposureContext;
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
        onCalculate={vi.fn()}
        isCalculating={false}
        routes={[{ ...ROUTE, objective: "sun", evaluatedContext }]}
        selectedRouteIndex={0}
        onSelectRoute={vi.fn()}
        error={null}
        pendingSlot={null}
        onSetPendingSlot={vi.fn()}
        onBack={vi.fn()}
        selectedTime={new Date("2026-06-21T18:20:00Z")}
        mapUtcOffsetMin={-240}
        solarPosition={null}
        sunset={null}
        weather={null}
        onOpenTimeline={vi.fn()}
        onTravelModeChange={vi.fn()}
        solarIntensity={solarIntensity}
      />,
    );
  }

  it("says the sun is down at 23:00, on the route card's 0° rule", () => {
    renderAt("2026-06-21T03:00:00Z", 0);
    expect(screen.getByText("Sun down — no direct sun")).toBeTruthy();
    expect(screen.queryByText(/Low sun/)).toBeNull();
  });

  it("still says low sun while the sun is up", () => {
    renderAt("2026-06-21T10:00:00Z", 0.1);
    expect(screen.getByText("Low sun — shadow routing minimal")).toBeTruthy();
  });
});
