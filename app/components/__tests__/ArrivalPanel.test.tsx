/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ArrivalPanel from "../ArrivalPanel";
import type { ResolvedExposureContext } from "../../lib/exposure";
import type { RouteLeg, RouteOption } from "../../lib/routing";

afterEach(cleanup);

const LINE: GeoJSON.Feature<GeoJSON.LineString> = {
  type: "Feature",
  properties: {},
  geometry: { type: "LineString", coordinates: [] },
};

/** A walk evaluated in Midtown: 14:00Z is 10:00 EDT, 03:00Z is 23:00 EDT. */
function walk(distanceM: number, shadowCoverage: number, iso = "2026-06-21T14:00:00Z"): RouteOption {
  return {
    label: "Shortest",
    geojson: LINE,
    distanceM,
    shadowCoverage,
    longestContinuousShadowM: 0,
    longestContinuousSunM: 0,
    shadowTransitions: 0,
    detourRatio: 1,
    turnCount: 0,
    objective: "sun",
    evaluatedContext: {
      objective: "sun",
      time: new Date(iso),
      referenceLocation: { lat: 40.754, lng: -73.984 },
    } as ResolvedExposureContext,
  };
}

function arrive(route: RouteOption | null, extra: Partial<Parameters<typeof ArrivalPanel>[0]> = {}) {
  const props = {
    route,
    waypointBLabel: "Bryant Park",
    waypointB: [-73.9832, 40.7536] as [number, number],
    onPlanAnother: vi.fn(),
    onDone: vi.fn(),
    ...extra,
  };
  render(<ArrivalPanel {...props} />);
  return props;
}

describe("ArrivalPanel as a postcard (R8a)", () => {
  it("greets from the destination on a kicker plate, postmarked Arrived", () => {
    arrive(walk(500, 0.6));

    expect(screen.getByText("Greetings from").className).toContain("umbra-kicker");
    // The stamp is decorative; the heading says Arrived to a screen reader.
    expect(screen.getByRole("heading", { name: "Arrived at Bryant Park" }).className).toContain("font-display");
    expect(screen.getByRole("article", { name: "Arrived at Bryant Park" })).toBeTruthy();
    expect(screen.getByText("Arrived").closest(".umbra-stamp-badge--sun")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("tells the sun time once, with the split bar's basis and the fixed pace", () => {
    arrive(walk(500, 0.6));

    expect(screen.getByText(/^\d+ of 6 min in sun$/)).toBeTruthy();
    expect(screen.getByText("distance share")).toBeTruthy();
    expect(screen.getByText("500 m route — at a fixed 5.0 km/h pace")).toBeTruthy();
  });

  it("fills the bar with the exact share, not one skewed by a rounded minute total", () => {
    // 1.00 min sun + 0.43 min shade: the total rounds to 1, which drew a 43% bar.
    const { container } = render(
      <ArrivalPanel route={walk(120, 0.3)} waypointBLabel="Bryant Park" waypointB={null} onPlanAnother={() => {}} onDone={() => {}} />,
    );

    const fill = container.querySelector<HTMLElement>("[aria-hidden='true'].border-ink > div");
    expect(fill?.style.width).toBe("30%");
  });

  it("names where the shadow figure came from when the route recorded it", () => {
    const route = walk(500, 0.6);
    route.shadowSource = {
      bySource: { tiles: 1 },
      dominant: "tiles",
      sampledFraction: 1,
      minConfidence: 1,
      meanConfidence: 1,
    };
    arrive(route);

    expect(screen.getByText("Shadow estimate · from building geometry")).toBeTruthy();
  });

  it("says after sunset, as the route card does, instead of quoting sun minutes", () => {
    arrive(walk(500, 1, "2026-06-21T03:00:00Z"));

    expect(screen.getByText("After sunset")).toBeTruthy();
    expect(screen.queryByText(/min in sun/)).toBeNull();
    expect(screen.queryByText("distance share")).toBeNull();
    expect(screen.getByText(/no sun minutes: the sun was down at the route's time/)).toBeTruthy();
    // No sun figure, so the postmark is ink, not the sun's orange.
    expect(screen.getByText("Arrived").closest(".umbra-stamp-badge--sun")).toBeNull();
  });

  it("draws no bar and invents no sun minutes when the exposure is unknown", () => {
    const legs: RouteLeg[] = [
      { type: "walk", geojson: LINE, distanceM: 126, shadowCoverage: 1 },
      { type: "transit", geojson: LINE, travelTimeSec: 1200, waitSec: 600, waitExposure: { coverage: 0.2, boardings: 1 } },
      { type: "walk", geojson: LINE, distanceM: 126, shadowCoverage: 1 },
    ];
    arrive({ ...walk(252, 1), objective: undefined, evaluatedContext: undefined, label: "Via Bus", legs });

    expect(screen.queryByText(/min in sun/)).toBeNull();
    expect(screen.queryByText(/share$/)).toBeNull();
    expect(screen.getByText("252 m route — sun exposure unknown")).toBeTruthy();
  });

  it("tells a rain trip in shelter, against open ground", () => {
    arrive({ ...walk(500, 0), objective: "rain", dryCoverage: 0.42 }, { rainMode: true });

    expect(screen.getByText("42% sheltered")).toBeTruthy();
    expect(screen.getByText("open")).toBeTruthy();
    // Shelter is not sun data: the postmark stays ink.
    expect(screen.getByText("Arrived").closest(".umbra-stamp-badge--sun")).toBeNull();
    expect(screen.queryByText(/min in sun/)).toBeNull();
  });

  it("says shelter is updating, with no stale figure or source, while it recomputes", () => {
    const route: RouteOption = { ...walk(500, 0), objective: "rain", dryCoverage: 0.42, exposureUpdating: true };
    route.shelterSource = { bySource: { tiles: 1 }, dominant: "tiles", sampledFraction: 1, minConfidence: 1, meanConfidence: 1 };
    arrive(route, { rainMode: true });

    expect(screen.getByText("500 m route — updating shelter…")).toBeTruthy();
    expect(screen.queryByText(/sheltered/)).toBeNull();
    expect(screen.queryByText(/Shelter estimate/)).toBeNull();
  });

  it("keeps an unnamed destination's coordinates out of the display face", () => {
    arrive(walk(500, 0.6), { waypointBLabel: null });

    expect(screen.getByRole("heading", { name: "Arrived at Your destination" })).toBeTruthy();
    expect(screen.getByText("40.75360, -73.98320").className).toContain("tabular-nums");
  });

  it("plans another trip or is done", () => {
    const props = arrive(walk(500, 0.6));

    fireEvent.click(screen.getByRole("button", { name: "PLAN ANOTHER" }));
    expect(props.onPlanAnother).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(props.onDone).toHaveBeenCalledTimes(1);
  });
});
