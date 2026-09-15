import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../agent/agentLoop";
import { callModel, rolesShareConfig } from "../agent/llmClient";
import { executeTool } from "../agent/tools";
import type { AgentContext } from "../agent/tools";
import type { LlmPart, LlmResponse } from "../agent/llmClient";
import type { RoutePlan } from "../routePlanJob";

vi.mock("../agent/llmClient", () => ({
  callModel: vi.fn(),
  rolesShareConfig: vi.fn(),
}));

vi.mock("../agent/tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/tools")>()),
  executeTool: vi.fn(),
  toolDeclarations: [],
}));

const mockCallModel = vi.mocked(callModel);
const mockRolesShareConfig = vi.mocked(rolesShareConfig);
const mockExecuteTool = vi.mocked(executeTool);

const ROUTE_PINS = [
  { lat: 40.7, lng: -74, candidateId: "test:route:from" },
  { lat: 40.73, lng: -73.98, candidateId: "test:route:to" },
];

function modelResponse(parts: LlmPart[]): LlmResponse {
  return { candidates: [{ content: { role: "model", parts } }] };
}

function makeCtx(): AgentContext {
  let version = 0;
  let mapObjects: import("../agent/receipts").MapObject[] = [];
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
    submitRoutePlan: vi.fn(),
    cancelRoutePlan: vi.fn(() => false),
    getCurrentPlanRevision: () => version,
    getMapObjects: () => mapObjects,
    registerMapObjects: (objects) => {
      mapObjects = [...mapObjects, ...objects];
    },
    setPins: (pins) => {
      mapObjects = pins.map((pin) => ({
        id: pin.objectId ?? `assistant-pin:${pin.lat.toFixed(5)}:${pin.lng.toFixed(5)}`,
        kind: "pin" as const,
        lat: pin.lat,
        lng: pin.lng,
        label: pin.label,
      }));
    },
  };
}

describe("runAgent fallback plotting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRolesShareConfig.mockReturnValue(false);
    mockExecuteTool.mockImplementation(async (name) => {
      if (name === "get_current_context") {
        return { center: { lat: 40.7, lng: -74 }, zoom: 14, locationKnown: true };
      }
      if (name === "search_places") {
        return {
          results: [
            { name: "Bryant Park", lat: 40.7536, lng: -73.9832 },
            { name: "Grace Plaza", lat: 40.752, lng: -73.985 },
          ],
        };
      }
      if (name === "plot_points") {
        return { ok: true, plotted: 2 };
      }
      if (name === "plan_shadowed_route")
        return {
          requestId: "fallback-route",
          inputVersion: 1,
          planRevision: 1,
          actionId: "fallback-action",
          retry: 0,
          idempotencyKey: "fallback:0",
          status: "completed",
          metrics: [{ label: "Shortest", distanceM: 100, shadowCoverage: 0.5 }],
          shadowProvenance: null,
        };
      return { ok: true };
    });
  });

  it("plots gathered place candidates when the model finishes without plot_points", async () => {
    mockCallModel
      .mockResolvedValueOnce(
        modelResponse([
          { functionCall: { name: "search_places", args: { query: "shadowed parks" } } },
        ]),
      )
      .mockResolvedValueOnce(modelResponse([{ text: "Try Bryant Park around 3 PM." }]))
      .mockResolvedValueOnce(modelResponse([{ text: "Bryant Park is plotted for your walk." }]));

    const toolEvents: string[] = [];
    const result = await runAgent({
      history: [],
      userText: "Plan a shadowed afternoon",
      ctx: makeCtx(),
      onToolEvent: (event) => toolEvents.push(event.name),
    });

    expect(
      result.answer.receipts.some(
        (receipt) => receipt.kind === "place" && receipt.verification === "verified",
      ),
    ).toBe(true);
    expect(toolEvents).toEqual(["search_places", "plot_points"]);
    expect(mockExecuteTool).toHaveBeenCalledWith(
      "plot_points",
      {
        points: [
          {
            candidateId: "candidate:result-1:0",
            label: "Bryant Park",
            lat: 40.7536,
            lng: -73.9832,
          },
          {
            candidateId: "candidate:result-1:1",
            label: "Grace Plaza",
            lat: 40.752,
            lng: -73.985,
          },
        ],
      },
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockCallModel.mock.calls[2][0].systemInstruction?.parts[0].text).toContain(
      "Map state guarantee",
    );
  });

  it("does not plot a fallback when the model already called plot_points", async () => {
    mockCallModel
      .mockResolvedValueOnce(
        modelResponse([
          {
            functionCall: {
              name: "plot_points",
              args: { points: [{ lat: 40.7536, lng: -73.9832, label: "Bryant Park" }] },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(modelResponse([{ text: "Pinned Bryant Park." }]));

    await runAgent({
      history: [],
      userText: "Show Bryant Park",
      ctx: makeCtx(),
      pins: [{ lat: 40.7536, lng: -73.9832, candidateId: "test:bryant" }],
    });

    const plotCalls = mockExecuteTool.mock.calls.filter(([name]) => name === "plot_points");
    expect(plotCalls).toHaveLength(1);
  });

  it("still plots fallback points on the same-model fast path", async () => {
    mockRolesShareConfig.mockReturnValue(true);
    mockCallModel
      .mockResolvedValueOnce(
        modelResponse([
          { functionCall: { name: "search_places", args: { query: "shadowed plazas" } } },
        ]),
      )
      .mockResolvedValueOnce(modelResponse([{ text: "Use Bryant Park first." }]));

    const result = await runAgent({
      history: [],
      userText: "Plan a shadowed walk",
      ctx: makeCtx(),
    });

    expect(
      result.answer.receipts.some(
        (receipt) => receipt.kind === "place" && receipt.verification === "verified",
      ),
    ).toBe(true);
    expect(mockExecuteTool).toHaveBeenCalledWith(
      "plot_points",
      expect.objectContaining({ points: expect.any(Array) }),
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockCallModel).toHaveBeenCalledTimes(2);
  });
});

describe("terminal route results", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRolesShareConfig.mockReturnValue(false);
    mockExecuteTool.mockImplementation(async (name) => {
      if (name === "get_current_context") {
        return { center: { lat: 40.7, lng: -74 }, zoom: 14, locationKnown: true };
      }
      if (name === "plan_shadowed_route") {
        return {
          requestId: "route-1",
          inputVersion: 1,
          planRevision: 1,
          actionId: "route-action",
          retry: 0,
          idempotencyKey: "route:intent",
          status: "cancelled",
          reason: "cancelled",
        };
      }
      return { ok: true };
    });
  });

  it("returns a cancelled route terminal state to model history and never writes a success narration", async () => {
    mockCallModel
      .mockResolvedValueOnce(
        modelResponse([
          {
            functionCall: {
              name: "plan_shadowed_route",
              args: { fromLat: 40.7, fromLng: -74, toLat: 40.73, toLng: -73.98 },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(modelResponse([{ text: "The route is ready." }]));

    const result = await runAgent({
      history: [],
      userText: "Route me",
      ctx: makeCtx(),
      pins: ROUTE_PINS,
    });

    expect(result.text).toContain("cancelled");
    expect(result.text).not.toMatch(/route (is )?(completed|ready)|calculation started/i);
    expect(mockCallModel).toHaveBeenCalledTimes(2);
    const terminal = result.history
      .flatMap((content) => content.parts)
      .find((part) => part.functionResponse?.name === "plan_shadowed_route");
    expect(terminal?.functionResponse?.response).toMatchObject({ status: "cancelled" });
  });

  it("fails closed instead of narrating success for a malformed terminal result", async () => {
    mockExecuteTool.mockImplementation(async (name) => {
      if (name === "get_current_context") return { center: { lat: 40.7, lng: -74 } };
      if (name === "plan_shadowed_route")
        return { status: "completed", metrics: [], shadowProvenance: null };
      return { ok: true };
    });
    mockCallModel
      .mockResolvedValueOnce(
        modelResponse([
          {
            functionCall: {
              name: "plan_shadowed_route",
              args: { fromLat: 40.7, fromLng: -74, toLat: 40.73, toLng: -73.98 },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(modelResponse([{ text: "The route is ready." }]));
    const result = await runAgent({
      history: [],
      userText: "Route me",
      ctx: makeCtx(),
      pins: ROUTE_PINS,
    });
    expect(result.text).toContain("invalid terminal result");
  });

  it("sabotage: a legacy started acknowledgement never becomes route success", async () => {
    mockExecuteTool.mockImplementation(async (name) => {
      if (name === "get_current_context") return { center: { lat: 40.7, lng: -74 } };
      if (name === "plan_shadowed_route") return { ok: true, note: "Route calculation started." };
      return { ok: true };
    });
    mockCallModel
      .mockResolvedValueOnce(
        modelResponse([
          {
            functionCall: {
              name: "plan_shadowed_route",
              args: { fromLat: 40.7, fromLng: -74, toLat: 40.73, toLng: -73.98 },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(modelResponse([{ text: "Your route is ready." }]));

    const result = await runAgent({
      history: [],
      userText: "Route me",
      ctx: makeCtx(),
      pins: ROUTE_PINS,
    });

    expect(result.text).toContain("invalid terminal result");
    expect(result.text).not.toMatch(/started|ready|completed/i);
  });

  it.each([
    [
      {
        status: "partial",
        metrics: [{ label: "Shortest", distanceM: 100, shadowCoverage: 0.5 }],
        shadowProvenance: null,
        unroutableLegs: [{ completedLegs: 1, failedLeg: 2, totalLegs: 2 }],
      },
      /partial route/i,
    ],
    [{ status: "no_plan_found", message: "No connected walkable path." }, /couldn't find/i],
    [{ status: "error", message: "Routing provider unavailable." }, /couldn't complete/i],
  ] as const)(
    "narrates terminal %o without claiming a completed route",
    async (outcome, expected) => {
      const terminal = {
        requestId: "route-1",
        inputVersion: 1,
        planRevision: 1,
        actionId: "route-action",
        retry: 0,
        idempotencyKey: "route:intent",
        ...outcome,
      };
      mockExecuteTool.mockImplementation(async (name) => {
        if (name === "get_current_context") return { center: { lat: 40.7, lng: -74 } };
        if (name === "plan_shadowed_route") return terminal;
        return { ok: true };
      });
      mockCallModel
        .mockResolvedValueOnce(
          modelResponse([
            {
              functionCall: {
                name: "plan_shadowed_route",
                args: { fromLat: 40.7, fromLng: -74, toLat: 40.73, toLng: -73.98 },
              },
            },
          ]),
        )
        .mockResolvedValueOnce(modelResponse([{ text: "Your route is ready." }]));

      const result = await runAgent({
        history: [],
        userText: "Route me",
        ctx: makeCtx(),
        pins: ROUTE_PINS,
      });

      expect(result.text).toMatch(expected);
      expect(result.text).not.toMatch(/route (is )?(ready|completed)/i);
    },
  );
});
