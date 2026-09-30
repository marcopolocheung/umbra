import { describe, expect, it, vi } from "vitest";
import { resolveExposureContext } from "../exposure";
import { refreshRouteExposure } from "../routeExposureRefresh";
import type { RouteOption } from "../routing";
import type { EdgeRef, EdgeShadow, ShadowField } from "../shadowField/ShadowField";

describe("refreshRouteExposure", () => {
  it("samples each transit walk leg once (#100)", () => {
    const sampleEdges = vi.fn((edges: EdgeRef[]): EdgeShadow[] =>
      edges.map(() => ({ left: 1, right: 0, source: "overpass", confidence: 1 })),
    );
    const field = { sampleEdges } as unknown as ShadowField;
    const walk = (from: [number, number], to: [number, number]) => ({
      type: "walk",
      geojson: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [from, to] } },
      sampledEdges: [{ from, to, side: null }],
    });
    const route = {
      legs: [
        walk([-74, 40.7], [-74, 40.701]),
        { type: "transit", waitSec: 60, travelTimeSec: 300 },
        walk([-74, 40.71], [-74, 40.711]),
      ],
    } as unknown as RouteOption;
    const context = resolveExposureContext({ objective: "sun" }, { time: new Date("2026-06-21T16:00:00Z") });

    const next = refreshRouteExposure(route, field, context);

    expect(sampleEdges).toHaveBeenCalledTimes(2);
    // The route-level segments still carry both walk legs' sampled segments.
    const walkSegments = next.exposureSegments?.filter((s) => s.distanceM > 0);
    expect(walkSegments).toEqual([
      ...(next.legs?.[0].exposureSegments ?? []),
      ...(next.legs?.[2].exposureSegments ?? []),
    ]);
    expect(walkSegments).toHaveLength(2);
  });
});
