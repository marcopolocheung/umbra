/* @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedExposureContext } from "../../lib/exposure";
import type { RouteOption } from "../../lib/routing";
import FloatingRouteCards from "../FloatingRouteCards";

afterEach(cleanup);

/** Midtown, evaluated at a UTC instant: 03:00Z is 23:00 EDT, 14:00Z is 10:00 EDT. */
function routeAt(iso: string): RouteOption {
  return {
    label: "Shortest",
    geojson: {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: [[-73.9855, 40.753], [-73.9825, 40.755]] },
    },
    distanceM: 600,
    shadowCoverage: 0.3,
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

/** R6b: the desktop cards' solar pill keys off the same 0° rule as the phone sheet's. */
describe("FloatingRouteCards — solar pill", () => {
  it("says the sun is down after sunset", () => {
    render(<FloatingRouteCards routes={[routeAt("2026-06-21T03:00:00Z")]} selectedRouteIndex={0} onSelectRoute={vi.fn()} solarIntensity={0} />);
    expect(screen.getByText("Sun down — no direct sun")).toBeTruthy();
    expect(screen.queryByText(/Low sun/)).toBeNull();
  });

  it("keeps the solar load tier while the sun is up", () => {
    render(<FloatingRouteCards routes={[routeAt("2026-06-21T14:00:00Z")]} selectedRouteIndex={0} onSelectRoute={vi.fn()} solarIntensity={0.9} />);
    expect(screen.getByText("High solar load — shadow matters")).toBeTruthy();
  });
});
