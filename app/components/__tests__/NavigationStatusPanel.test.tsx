/* @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NavigationStatusPanel from "../NavigationStatusPanel";
import type { ResolvedExposureContext } from "../../lib/exposure";
import type { RouteLeg, RouteOption } from "../../lib/routing";

afterEach(cleanup);

const LINE: GeoJSON.Feature<GeoJSON.LineString> = {
  type: "Feature",
  properties: {},
  geometry: { type: "LineString", coordinates: [] },
};

function walk(overrides: Partial<RouteOption> = {}): RouteOption {
  return {
    label: "Balanced",
    geojson: LINE,
    distanceM: 700,
    shadowCoverage: 0.74,
    longestContinuousShadowM: 0,
    longestContinuousSunM: 0,
    shadowTransitions: 0,
    detourRatio: 1,
    turnCount: 3,
    ...overrides,
  };
}

function panel(route: RouteOption) {
  render(
    <NavigationStatusPanel
      route={route}
      waypointA={[-73.9855, 40.753]}
      waypointB={[-73.9825, 40.755]}
      waypointALabel="Start point"
      waypointBLabel="Bryant Park"
      onBack={vi.fn()}
      onArrive={vi.fn()}
      onExit={vi.fn()}
    />,
  );
}

describe("NavigationStatusPanel (R5b)", () => {
  it("shows the card's own figures: its duration verdict and shade share", () => {
    panel(walk());
    expect(screen.getByText("Balanced").className).toContain("umbra-kicker");
    expect(screen.getByText("To Bryant Park")).toBeTruthy();
    // 700 m at the fixed 5.0 km/h walking pace ≈ 8 min, as on the route card.
    expect(screen.getByText("8 min")).toBeTruthy();
    expect(screen.getByText("74%")).toBeTruthy();
  });

  it("quotes no shade share after sunset", () => {
    const evaluatedContext = {
      objective: "sun",
      time: new Date("2026-06-21T03:00:00Z"),
      referenceLocation: { lat: 40.754, lng: -73.984 },
    } as ResolvedExposureContext;
    panel(walk({ shadowCoverage: 1, objective: "sun", evaluatedContext }));
    expect(screen.getByText("After sunset")).toBeTruthy();
    expect(screen.queryByText("100%")).toBeNull();
  });

  it("names a ridden line by its bullet, and keeps every control a 44px target", () => {
    const legs: RouteLeg[] = [
      { type: "walk", geojson: LINE, distanceM: 90, shadowCoverage: 0.5 },
      { type: "transit", geojson: LINE, line: "N", lineName: "Broadway Express", lineColor: "#ffe14d", travelTimeSec: 480, stops: ["34 St", "Canal St"] },
      { type: "walk", geojson: LINE, distanceM: 90, shadowCoverage: 0.5 },
    ];
    panel(walk({ label: "Via Subway", legs, totalTimeSec: 600 }));
    expect(screen.getByText("N").className).toBe("umbra-line-bullet__id");
    for (const name of ["Back to route options", "End navigation"]) {
      expect(screen.getByRole("button", { name }).className).toContain("h-11 w-11");
    }
  });

  it("quotes no transit shade share where its time outdoors was not measured, as the card", () => {
    const legs: RouteLeg[] = [
      { type: "walk", geojson: LINE, distanceM: 90, shadowCoverage: 0.5 },
      // A bus stop the field could not answer for: the trip's outdoor time is part unknown.
      { type: "transit", geojson: LINE, line: "M15", lineColor: "#ffe14d", travelTimeSec: 900, waitSec: 600, waitExposure: { coverage: 0.2, boardings: 1 } },
      { type: "walk", geojson: LINE, distanceM: 90, shadowCoverage: 0.5 },
    ];
    panel(walk({ label: "Via Bus", legs, totalTimeSec: 1100 }));
    expect(screen.getByText("Shadow on foot")).toBeTruthy();
    expect(screen.getByText("Unknown")).toBeTruthy();
    expect(screen.queryByText(/^\d+%$/)).toBeNull();
    // The ride's step names its wait, so the steps add up to the Time cell.
    expect(screen.getByText(/15 min incl\. ~10 min wait/)).toBeTruthy();
  });

  it("draws the itinerary rail: dotted on foot, solid in the line's colour for the ride", () => {
    const legs: RouteLeg[] = [
      { type: "walk", geojson: LINE, distanceM: 90, shadowCoverage: 0.5 },
      { type: "transit", geojson: LINE, line: "N", lineColor: "ffe14d", travelTimeSec: 480 },
      { type: "walk", geojson: LINE, distanceM: 90, shadowCoverage: 0.5 },
    ];
    panel(walk({ label: "Via Subway", legs, totalTimeSec: 600 }));
    const steps = screen.getByRole("list", { name: "Route steps" }).querySelectorAll("li");
    const rails = [...steps].map((li) => li.querySelector(".umbra-leg-rail") as HTMLElement);
    expect(rails.map((r) => r.className)).toEqual([
      "umbra-leg-rail umbra-leg-rail--foot",
      "umbra-leg-rail umbra-leg-rail--ride",
      "umbra-leg-rail umbra-leg-rail--foot",
    ]);
    // Bare-hex OSM colours are made valid CSS, as the bullet does.
    expect(rails[1].style.getPropertyValue("--leg-color")).toBe("#ffe14d");
  });
});
