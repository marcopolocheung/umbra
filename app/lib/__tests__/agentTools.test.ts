import { afterEach, describe, expect, it, vi } from "vitest";
import { executeTool, toolDeclarations } from "../agent/tools";
import type { AgentContext } from "../agent/tools";
import { geocodeNear } from "../nominatim";
import type { RoutePlan, RoutePlanRequest } from "../routePlanJob";

vi.mock("../nominatim", () => ({ geocodeForward: vi.fn(), geocodeNear: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeCtx(): AgentContext {
  let version = 0;
  return {
    mapRef: { current: null },
    shadowLayerRef: { current: null },
    dateRef: { current: new Date("2026-08-08T12:00:00Z") },
    setDate: vi.fn(),
    getUtcOffsetMin: () => 0,
    getUserLocation: () => null,
    setWaypointA: vi.fn(),
    setWaypointB: vi.fn(),
    setAdditionalWaypoints: vi.fn(),
    createRoutePlanRequest: (plan: RoutePlan) => ({
      requestId: `test-${version + 1}`,
      inputVersion: ++version,
      planRevision: version,
      actionId: `test-action-${version}`,
      retry: 0,
      idempotencyKey: `test:${version}`,
      plan,
    }),
    submitRoutePlan: vi.fn(async (request: RoutePlanRequest) => ({
      requestId: request.requestId,
      inputVersion: request.inputVersion,
      planRevision: request.planRevision,
      actionId: request.actionId,
      retry: request.retry,
      idempotencyKey: request.idempotencyKey,
      status: "completed" as const,
      metrics: [{ label: "Shortest", distanceM: 100, shadowCoverage: 0.5 }],
      shadowProvenance: null,
    })),
    cancelRoutePlan: vi.fn(() => false),
    getCurrentPlanRevision: () => version,
    setPins: vi.fn(),
  };
}

describe("agent route tools", () => {
  it("exposes ordered via stops on plan_shadowed_route", () => {
    const routeTool = toolDeclarations.find((tool) => tool.name === "plan_shadowed_route");
    expect(routeTool?.parameters.properties).toHaveProperty("via");
  });

  it("awaits a terminal multi-stop route result", async () => {
    const ctx = makeCtx();

    const result = await executeTool(
      "plan_shadowed_route",
      {
        fromLat: 40.7,
        fromLng: -74.0,
        fromLabel: "Start cafe",
        toLat: 40.73,
        toLng: -73.98,
        toLabel: "Dinner",
        via: [
          { lat: 40.71, lng: -73.99, label: "Park" },
          { lat: 40.72, lng: -73.985, label: "Museum" },
          { lat: "bad", lng: -73.0 },
        ],
      },
      ctx
    );

    expect(result).toMatchObject({ status: "completed", inputVersion: 1 });
    expect(ctx.submitRoutePlan).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "test-1",
      inputVersion: 1,
      planRevision: 1,
      actionId: "test-action-1",
      retry: 0,
      idempotencyKey: "test:1",
      plan: expect.objectContaining({
        from: [-74.0, 40.7],
        to: [-73.98, 40.73],
        via: [[-73.99, 40.71], [-73.985, 40.72]],
      }),
    }));
  });

  it("clears stale additional waypoints for a two-stop shadowed route", async () => {
    const ctx = makeCtx();

    await executeTool(
      "plan_shadowed_route",
      { fromLat: 1, fromLng: 2, toLat: 3, toLng: 4 },
      ctx
    );

    expect(ctx.submitRoutePlan).toHaveBeenCalledWith(expect.objectContaining({
      plan: expect.objectContaining({ via: [] }),
    }));
  });

  it("fails closed when a context returns a mismatched terminal result", async () => {
    const ctx = makeCtx();
    vi.mocked(ctx.submitRoutePlan).mockResolvedValue({
      requestId: "other", inputVersion: 1, planRevision: 1, actionId: "other", retry: 0, idempotencyKey: "other",
      status: "completed", metrics: [{ label: "Claimed", distanceM: 100, shadowCoverage: 0.5 }], shadowProvenance: null,
    });
    const result = await executeTool("plan_shadowed_route", { fromLat: 1, fromLng: 2, toLat: 3, toLng: 4 }, ctx);
    expect(result).toMatchObject({ status: "error", requestId: "test-1", message: expect.stringContaining("invalid terminal result") });
  });

  it("uses shadow-layer point queries for check_shadow without moving the camera", async () => {
    const flyTo = vi.fn();
    const ctx = makeCtx();
    ctx.mapRef.current = { flyTo } as any;
    ctx.shadowLayerRef.current = {
      queryPointShadow: vi.fn(() => ({ shadowFraction: 0.8, source: "geometry-cache" })),
    } as any;

    const result = await executeTool(
      "check_shadow",
      { lat: 40.7, lng: -74.0, time: "2:00 PM" },
      ctx
    );

    expect(result).toMatchObject({
      shadowFraction: 0.8,
      status: "shadowed",
      source: "geometry-cache",
    });
    expect(flyTo).not.toHaveBeenCalled();
    expect(ctx.setDate).not.toHaveBeenCalled();
  });

  it("checks every listed spot in one check_shadow call", async () => {
    const ctx = makeCtx();
    ctx.shadowLayerRef.current = {
      queryPointShadow: vi.fn((lng: number) => ({
        shadowFraction: lng < -74 ? 0.9 : 0.1,
        source: "geometry-cache",
      })),
    } as any;

    const result = await executeTool(
      "check_shadow",
      { points: [{ lat: 40.7, lng: -74.01, label: "A" }, { lat: 40.7, lng: -73.99 }] },
      ctx
    );

    expect(result.results).toMatchObject([
      { label: "A", lat: 40.7, lng: -74.01, shadowFraction: 0.9, status: "shadowed" },
      { lat: 40.7, lng: -73.99, shadowFraction: 0.1, status: "sunlit" },
    ]);
  });

  it("uses offscreen building geometry for check_shadow without requiring the map", async () => {
    const ctx = makeCtx();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ elements: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTool(
      "check_shadow",
      { lat: 40.7, lng: -74.0, time: "2:00 PM" },
      ctx
    );

    expect(result).toMatchObject({
      shadowFraction: 0,
      status: "sunlit",
      source: "overpass-buildings",
      buildingCount: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.setDate).not.toHaveBeenCalled();
  });
});

// Bryant Park, the anchor every search below is made from.
const ANCHOR = { lat: 40.7536, lng: -73.9832 };
const hit = (name: string, lat: number, lng: number) => ({
  display_name: `${name}, Manhattan, New York`,
  lat: String(lat),
  lon: String(lng),
});

describe("search_places", () => {
  afterEach(() => {
    vi.mocked(geocodeNear).mockReset();
  });

  it("lists the nearest hits first, each with its distance from the anchor", async () => {
    vi.mocked(geocodeNear).mockResolvedValueOnce([
      hit("Rockefeller Plaza", 40.7587, -73.9787), // ~680 m
      hit("Grace Plaza", 40.7545, -73.9845), // ~150 m
    ] as any);

    const result = await executeTool("search_places", { query: "plaza", ...ANCHOR }, makeCtx());
    const results = result.results as { name: string; distanceM: number }[];

    expect(results.map((r) => r.name.split(",")[0])).toEqual(["Grace Plaza", "Rockefeller Plaza"]);
    expect(results[0].distanceM).toBeGreaterThan(100);
    expect(results[0].distanceM).toBeLessThan(200);
    expect(results[1].distanceM).toBeGreaterThan(600);
  });

  it("searches walking distance first — not the whole city", async () => {
    vi.mocked(geocodeNear).mockResolvedValueOnce([hit("Grace Plaza", 40.7545, -73.9845)] as any);

    await executeTool("search_places", { query: "plaza", ...ANCHOR }, makeCtx());

    const radiusDeg = vi.mocked(geocodeNear).mock.calls[0][3];
    // Half-width of the search box, in metres of latitude.
    expect((radiusDeg ?? Infinity) * 111_000).toBeLessThanOrEqual(2000);
  });

  it("widens once when nothing is within walking distance, and says how far it looked", async () => {
    vi.mocked(geocodeNear)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([hit("Riverside Park", 40.8, -73.97)] as any);

    const result = await executeTool("search_places", { query: "park", ...ANCHOR }, makeCtx());

    const [first, second] = vi.mocked(geocodeNear).mock.calls;
    expect(second[3]).toBeGreaterThan(first[3] ?? Infinity);
    expect((result.results as { name: string }[]).map((r) => r.name.split(",")[0])).toEqual(["Riverside Park"]);
    expect(result.searchRadiusKm).toBeGreaterThan(2);
  });
});
