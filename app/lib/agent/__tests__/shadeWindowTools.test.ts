import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeTool,
  normalizeShadeToolArgs,
  shadeQueryFromArgs,
  toolDeclarations,
} from "../tools";
import { findShadeSpots } from "../../navigationData/shadeSpotsSource";
import { authorizeToolCall } from "../authority";
import { shadeContext, shadePayload, SHADE_QUERY } from "./shadeFixture";
import type { RoutePlanRequest } from "../../routePlanJob";

vi.mock("../../navigationData/shadeSpotsSource", async (original) => ({
  ...(await original<typeof import("../../navigationData/shadeSpotsSource")>()),
  findShadeSpots: vi.fn(),
}));
const args = {
  lat: SHADE_QUERY.lat,
  lng: SHADE_QUERY.lng,
  from: "2 PM",
  to: "4 PM",
  radiusM: 400,
  mode: "shade",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(findShadeSpots).mockResolvedValue(shadePayload());
});

describe("shade-window executor", () => {
  it("exposes the area contract without street/similarity modes", () => {
    const declaration = toolDeclarations.find((t) => t.name === "find_shade_spots")!;
    expect(declaration.parameters.required).toEqual([
      "lat",
      "lng",
      "from",
      "to",
      "radiusM",
      "mode",
    ]);
    expect(declaration.parameters.properties).not.toHaveProperty("street");
    expect(declaration.parameters.properties).not.toHaveProperty("likeCandidateId");
  });
  it("defaults to the NYC selected map day and uses the A1 window query", async () => {
    const ctx = shadeContext();
    ctx.getUtcOffsetMin = () => 540;
    ctx.dateRef.current = new Date("2026-07-05T02:00:00Z");
    await executeTool("find_shade_spots", args, ctx);
    expect(findShadeSpots).toHaveBeenCalledWith({ ...SHADE_QUERY, date: "2026-07-04" });
    expect(normalizeShadeToolArgs(args, ctx.dateRef.current).date).toBe("2026-07-04");
    expect(normalizeShadeToolArgs({ ...args, date: "2030-08-03" }, ctx.dateRef.current).date).toBe(
      "2030-08-03",
    );
  });
  it.each([
    { from: "2 PM rubbish" },
    { to: "2 PM" },
    { date: "2026-02-29" },
    { from: "11 PM", to: "2 AM" },
    { radiusM: 300 },
    { date: "" },
    { mode: "rain" },
  ])("rejects malformed %j without loading or mutating", async (invalid) => {
    const ctx = shadeContext();
    ctx.setDate = vi.fn();
    ctx.setPins = vi.fn();
    expect(await executeTool("find_shade_spots", { ...args, ...invalid }, ctx)).toEqual({
      status: "unavailable",
      reason: "invalid_query",
      results: [],
    });
    expect(findShadeSpots).not.toHaveBeenCalled();
    expect(ctx.setDate).not.toHaveBeenCalled();
    expect(ctx.setPins).not.toHaveBeenCalled();
  });
  it("strictly validates and freezes arguments before use", () => {
    expect(shadeQueryFromArgs({ ...args, date: SHADE_QUERY.date })).toEqual(SHADE_QUERY);
    expect(shadeQueryFromArgs({ ...args, date: SHADE_QUERY.date, from: "2" })).toBeNull();
  });
});

function routeSetup() {
  const ctx = shadeContext(),
    payload = shadePayload(),
    spot = payload.results[0];
  ctx.registerShadeCandidates(
    payload.results.map((s) => ({
      spot: s,
      requestedDate: payload.requestedDate,
      mode: payload.mode,
    })),
  );
  const origin = { id: "origin", lat: 40.754, lng: -73.985 };
  const routeArgs = {
    fromLat: origin.lat,
    fromLng: origin.lng,
    fromCandidateId: origin.id,
    toLat: spot.lat,
    toLng: spot.lng,
    toCandidateId: spot.candidateId,
  };
  const mint = (a: Record<string, unknown>) =>
    authorizeToolCall(
      {
        currentUserText: "Route me to the chosen sidewalk",
        candidates: [
          origin,
          ...payload.results.map((s) => ({ id: s.candidateId, lat: s.lat, lng: s.lng })),
        ],
      },
      "plan_shadowed_route",
      a,
      ["current_user_intent", "model_generated", "application_state"],
    ).execution;
  const request = (plan: RoutePlanRequest["plan"]): RoutePlanRequest => ({
    requestId: "req",
    inputVersion: 1,
    planRevision: 1,
    actionId: "action",
    retry: 0,
    idempotencyKey: "action:0",
    plan,
  });
  ctx.createRoutePlanRequest = vi.fn(request);
  ctx.submitRoutePlan = vi.fn(async (r) => ({
    ...r,
    status: "completed" as const,
    metrics: [{ label: "Shortest", distanceM: 100, shadowCoverage: 0.7 }],
    shadowProvenance: null,
  }));
  return { ctx, routeArgs, mint, payload };
}
describe("routing a chosen shade candidate", () => {
  it("uses the existing route job when the selected map departure matches", async () => {
    const { ctx, routeArgs, mint } = routeSetup();
    const result = await executeTool("plan_shadowed_route", routeArgs, ctx, mint(routeArgs));
    expect(result.status).toBe("completed");
    expect(ctx.createRoutePlanRequest).toHaveBeenCalledTimes(1);
    expect(ctx.createRoutePlanRequest).toHaveBeenCalledWith(
      expect.not.objectContaining({ date: expect.anything() }),
    );
  });
  it.each(["2026-07-05T18:00:00Z", "2026-07-04T20:00:00Z"])(
    "rejects incompatible selected departure %s before allocating a job",
    async (at) => {
      const { ctx, routeArgs, mint } = routeSetup();
      ctx.dateRef.current = new Date(at);
      expect(
        await executeTool("plan_shadowed_route", routeArgs, ctx, mint(routeArgs)),
      ).toMatchObject({ code: "shade_route_time" });
      expect(ctx.createRoutePlanRequest).not.toHaveBeenCalled();
      expect(ctx.submitRoutePlan).not.toHaveBeenCalled();
    },
  );
  it("rejects an itinerary through multiple alternatives", async () => {
    const { ctx, routeArgs, mint, payload } = routeSetup();
    const other = payload.results[1];
    const a = {
      ...routeArgs,
      via: [{ lat: other.lat, lng: other.lng, candidateId: other.candidateId }],
    };
    expect(await executeTool("plan_shadowed_route", a, ctx, mint(a))).toMatchObject({
      code: "shade_alternatives",
    });
    expect(ctx.createRoutePlanRequest).not.toHaveBeenCalled();
  });
});
