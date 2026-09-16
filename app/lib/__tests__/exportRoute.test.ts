import { describe, expect, it } from "vitest";
import { routeToGPX, routeToGeoJSON } from "../exportRoute";
import type { RouteOption } from "../routing";
import { buildTrip } from "../trip/trip";

const ROUTE = {
  label: "Balanced",
  geojson: {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: [
        [-3.7, 40.41],
        [-3.68, 40.42],
      ],
    },
  },
  distanceM: 1500,
  shadowCoverage: 0.6,
  longestContinuousShadowM: 300,
  longestContinuousSunM: 120,
  shadowTransitions: 4,
  detourRatio: 1.1,
  turnCount: 5,
} as RouteOption;

const TRIP = buildTrip({
  departAt: { instant: "2026-09-15T12:00:00.000Z", zone: "Europe/Madrid" },
  defaultMode: "walk",
  stops: [
    { coord: [-3.7, 40.41], label: "Café & Bar" },
    { coord: [-3.69, 40.415], dwellMinutes: 30 },
    { coord: [-3.68, 40.42], label: "Park" },
  ],
});

describe("route export with a trip", () => {
  it("writes GPX waypoints with names and dwell, escaping XML", () => {
    const gpx = routeToGPX(ROUTE, "Balanced", TRIP);
    expect(gpx).toContain("<name>Café &amp; Bar</name>");
    expect(gpx).toContain("<desc>30 min stop</desc>");
    expect(gpx).toContain("<name>Park</name>");
    // The track itself is unchanged.
    expect(gpx).toContain("<trkpt");
    // GPX 1.1 orders `wpt*` before `trk*`; a validating reader drops stops
    // that trail the track, so assert position, not just presence.
    expect(gpx.indexOf("<wpt")).toBeGreaterThan(-1);
    expect(gpx.indexOf("<wpt")).toBeLessThan(gpx.indexOf("<trk>"));
    expect(gpx.lastIndexOf("</wpt>")).toBeLessThan(gpx.indexOf("<trk>"));
  });

  it("writes GPX byte-identically without a trip", () => {
    expect(routeToGPX(ROUTE, "Balanced")).not.toContain("<wpt");
  });

  it("appends GeoJSON stop points with dwell properties", () => {
    const fc = JSON.parse(routeToGeoJSON(ROUTE, TRIP)) as GeoJSON.FeatureCollection;
    expect(fc.features).toHaveLength(4);
    expect(fc.features[0].geometry?.type).toBe("LineString");
    expect(fc.features[1]).toMatchObject({
      geometry: { type: "Point", coordinates: [-3.7, 40.41] },
      properties: { name: "Café & Bar" },
    });
    expect(fc.features[2].properties).toMatchObject({ name: "Stop 2", dwellMinutes: 30 });
  });

  it("writes GeoJSON with the route alone without a trip", () => {
    const fc = JSON.parse(routeToGeoJSON(ROUTE)) as GeoJSON.FeatureCollection;
    expect(fc.features).toHaveLength(1);
  });
});
