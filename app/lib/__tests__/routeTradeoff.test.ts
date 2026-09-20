import { describe, expect, it } from "vitest";
import type { RouteLeg, RouteOption } from "../routing";
import {
  routeExposureLine,
  routeExposureMinutes,
  routeExposureScope,
  routeShadowLabel,
  routeTradeoffLine,
  shortestRoute,
  transitOutdoorExposure,
} from "../routeTradeoff";
import type { TransitWaitExposure } from "../transitWaitExposure";

function route(
  label: string,
  distanceM: number,
  shadowCoverage: number,
  totalTimeSec?: number,
  longestContinuousSunM = 0,
): RouteOption {
  return {
    label,
    distanceM,
    shadowCoverage,
    totalTimeSec,
    geojson: {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: [] },
    },
    longestContinuousShadowM: 0,
    longestContinuousSunM,
    shadowTransitions: 0,
    detourRatio: 1,
    turnCount: 0,
  };
}

describe("routeTradeoffLine", () => {
  it("labels the shortest route as the comparison baseline", () => {
    const shortest = route("Shortest", 1000, 0.25);

    expect(routeTradeoffLine(shortest, shortest)).toBe("Shortest baseline, 25% shadow");
  });

  it("reports added time and reduced sun exposure", () => {
    const shortest = route("Shortest", 1000, 0.2);
    const shadowed = route("Most shadowed", 1260, 0.62);

    expect(routeTradeoffLine(shadowed, shortest)).toBe("+3 min, -40% sun exposure");
  });

  it("prices the same detour in fewer minutes at cycling speed", () => {
    // The same 260 extra metres: ~3 min on foot, ~1 min at 4.5 m/s. Sun metres
    // are geometry, so the exposure half is identical.
    const shortest = route("Shortest", 1000, 0.2);
    const shadowed = route("Most shadowed", 1260, 0.62);
    const bikeShortest = { ...shortest, travelMode: "bike" as const };
    const bikeShadowed = { ...shadowed, travelMode: "bike" as const };

    expect(routeTradeoffLine(shadowed, shortest)).toBe("+3 min, -40% sun exposure");
    expect(routeTradeoffLine(bikeShadowed, bikeShortest)).toBe("+1 min, -40% sun exposure");
  });

  it("uses total travel time when a route has transit timing", () => {
    const walk = route("Walk", 1400, 0.5, 1000);
    const transit = route("Transit", 900, 0.16, 1120);

    expect(shortestRoute([walk, transit])).toBe(walk);
    expect(routeTradeoffLine(transit, walk)).toBe("+2 min, +8% sun exposure");
  });
});

describe("routeExposureLine", () => {
  it("states direct sun as minutes rather than a percentage", () => {
    // 1000 m at 20% sun = 200 m at 1.4 m/s ≈ 2.4 min
    expect(routeExposureLine(route("Shortest", 1000, 0.8))).toBe("2 min in sun");
  });

  it("adds the longest unbroken stretch when the route was sampled per edge", () => {
    // 2000 m at 30% sun = 600 m ≈ 7.1 min; longest run 420 m = 5 min
    expect(routeExposureLine(route("Balanced", 2000, 0.7, undefined, 420))).toBe(
      "7 min in sun · longest stretch 5 min",
    );
  });

  it("distinguishes routes a shadow percentage would call equivalent", () => {
    // Same total sun, split six ways versus taken in one crossing.
    const scattered = route("Scattered", 2000, 0.7, undefined, 100);
    const oneCrossing = route("One crossing", 2000, 0.7, undefined, 600);

    expect(routeExposureLine(scattered)).toBe("7 min in sun · longest stretch 1 min");
    expect(routeExposureLine(oneCrossing)).toBe("7 min in sun · longest stretch 7 min");
  });

  it("omits the stretch for sketch and transit routes, whose streak is a placeholder", () => {
    expect(routeExposureLine(route("Via MRT", 1200, 0.4))).toBe("9 min in sun");
  });

  it("does not round a short exposure down to zero", () => {
    expect(routeExposureLine(route("Most shadowed", 1000, 0.98))).toBe("under a minute in sun");
  });

  it("reports bike-route durations at cycling speed", () => {
    // Same 200 sun-meters: ~2 min walking, under a minute at 4.5 m/s.
    const walk = route("Shortest", 1000, 0.8);
    const bike = { ...walk, travelMode: "bike" as const };
    expect(routeExposureLine(walk)).toBe("2 min in sun");
    expect(routeExposureLine(bike)).toBe("under a minute in sun");
  });
});

describe("routeExposureMinutes", () => {
  it("splits the trip into sunlit and shadowed minutes at walking pace", () => {
    // 840 m at 1.4 m/s is 10 minutes; 25% shadow leaves 7.5 of them in the sun.
    const { sunMinutes, shadowMinutes } = routeExposureMinutes(route("Shortest", 840, 0.25))!;

    expect(sunMinutes).toBeCloseTo(7.5, 10);
    expect(shadowMinutes).toBeCloseTo(2.5, 10);
  });

  it("reports shadowed minutes rather than dropping them", () => {
    // A fully shadowed route is not a zero-exposure route: the UV model still charges
    // it for diffuse sky, and the heat model still has to know how long it lasts.
    const { sunMinutes, shadowMinutes } = routeExposureMinutes(route("Most shadowed", 840, 1))!;

    expect(sunMinutes).toBe(0);
    expect(shadowMinutes).toBeCloseTo(10, 10);
  });

  it("never returns a negative half", () => {
    const { sunMinutes, shadowMinutes } = routeExposureMinutes(route("Odd", 840, 1.4))!;

    expect(sunMinutes).toBeGreaterThanOrEqual(0);
    expect(shadowMinutes).toBeGreaterThanOrEqual(0);
  });
});

const LINE: GeoJSON.Feature<GeoJSON.LineString> = {
  type: "Feature",
  properties: {},
  geometry: { type: "LineString", coordinates: [] },
};

function walkLeg(distanceM: number, shadowCoverage: number): RouteLeg {
  return { type: "walk", geojson: LINE, distanceM, shadowCoverage };
}

/** A 20-minute ride, so any test that sees it in the minutes fails loudly. */
function rideLeg(waitSec?: number, waitExposure?: TransitWaitExposure): RouteLeg {
  return {
    type: "transit",
    geojson: LINE,
    travelTimeSec: 1200,
    ...(waitSec != null ? { waitSec } : {}),
    ...(waitExposure ? { waitExposure } : {}),
    sunExposure: 0.25,
    sunExposureCoverage: 1,
    aboveGroundShare: 1,
  };
}

function transitRoute(legs: RouteLeg[]): RouteOption {
  const walkM = legs.reduce((sum, leg) => sum + (leg.distanceM ?? 0), 0);
  return {
    ...route("Via Bus", walkM, 0, 2400),
    shadowCoverage: transitOutdoorExposure(legs).shadow,
    legs,
  };
}

describe("transit exposure — time outdoors, not walk metres", () => {
  it("counts a wait in full sun while it covers zero metres", () => {
    // 840 m fully shadowed is 10 min; 6 min at a stop in full sun is 6 more.
    const bus = transitRoute([
      walkLeg(420, 1),
      rideLeg(360, { shadow: 0, coverage: 1, boardings: 1 }),
      walkLeg(420, 1),
    ]);
    const minutes = routeExposureMinutes(bus)!;

    expect(minutes.sunMinutes).toBeCloseTo(6, 10);
    expect(minutes.shadowMinutes).toBeCloseTo(10, 10);
    expect(routeShadowLabel(bus)).toBe("63% shadow on foot");
    expect(routeExposureLine(bus)).toBe("6 min in sun");
  });

  it("never counts the ride, however exposed its track", () => {
    // The ride is fully above ground and twenty minutes long; only the walks count.
    const subway = transitRoute([walkLeg(420, 0.5), rideLeg(240), walkLeg(420, 0.5)]);
    const minutes = routeExposureMinutes(subway)!;

    expect(minutes.sunMinutes + minutes.shadowMinutes).toBeCloseTo(10, 10);
  });

  it("does not count an unmodelled platform wait, and says so", () => {
    const subway = transitRoute([walkLeg(420, 0.5), rideLeg(240), walkLeg(420, 0.5)]);

    expect(routeShadowLabel(subway)).toBe("50% shadow on foot");
    expect(routeExposureScope(subway)).toBe("walk only; wait and ride not counted");
  });

  it("names the wait in its scope where the stop was sampled", () => {
    const bus = transitRoute([
      walkLeg(420, 1),
      rideLeg(360, { shadow: 0, coverage: 1, boardings: 1 }),
      walkLeg(420, 1),
    ]);

    expect(routeExposureScope(bus)).toBe("walk and stop wait only; ride not counted");
  });

  it("says unknown rather than quoting the walk when a stop went unanswered", () => {
    // 3 min walked, 10 min at stops the field could not answer for.
    const bus = transitRoute([
      walkLeg(126, 1),
      rideLeg(600, { coverage: 0.2, boardings: 2 }),
      walkLeg(126, 1),
    ]);
    const walk = route("Shortest", 1000, 0.2);

    expect(transitOutdoorExposure(bus.legs!).known).toBe(false);
    expect(routeExposureMinutes(bus)).toBeNull();
    expect(routeShadowLabel(bus)).toBe("shadow unknown");
    expect(routeExposureLine(bus)).toBe("time in sun unknown");
    expect(routeTradeoffLine(bus, walk)).toBe("+28 min, sun exposure unknown");
    expect(routeTradeoffLine(bus, bus)).toBe("Shortest baseline, shadow unknown");
  });

  it("never lends an unanswered wait the walk's shade, however short the wait", () => {
    // 10 min walked in full shadow, 2 min at a stop nobody could see. Giving the
    // stop the walk's share would call two possibly sunny minutes shaded.
    const bus = transitRoute([
      walkLeg(420, 1),
      rideLeg(120, { coverage: 0.5, boardings: 1 }),
      walkLeg(420, 1),
    ]);

    expect(routeExposureMinutes(bus)).toBeNull();
    expect(routeShadowLabel(bus)).toBe("shadow unknown");
  });

  it("reports under a minute, not unknown, for a trip with no time outdoors", () => {
    const subway = transitRoute([walkLeg(0, 1), rideLeg(240), walkLeg(0, 1)]);

    expect(routeExposureLine(subway)).toBe("under a minute in sun");
  });

  it("leaves walk routes exactly as they were", () => {
    expect(routeShadowLabel(route("Shortest", 1000, 0.25))).toBe("25% shadow");
    expect(routeExposureScope(route("Shortest", 1000, 0.25))).toBeNull();
  });
});
