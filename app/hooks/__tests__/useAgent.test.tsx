/* @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgent } from "../useAgent";
import { guideNote } from "../../lib/agent/guideNote";
import type { ToolResultEnvelope, VerifiedAnswer } from "../../lib/agent/receipts";

// A pending window read must not repopulate a newly reset conversation.
import { waitFor } from "@testing-library/react";
import { shadeContext, shadePayload } from "../../lib/agent/__tests__/shadeFixture";
import type { AgentContext } from "../../lib/agent/tools";
import { shadeWindowObjectId } from "../../lib/agent/shadeWindows";


const runAgent = vi.fn();
vi.mock("../../lib/agent/agentLoop", () => ({ runAgent }));

const routeTerminal = {
  requestId: "request-7",
  inputVersion: 1,
  planRevision: 7,
  actionId: "action-7",
  retry: 0,
  idempotencyKey: "action-7:0",
  status: "completed" as const,
  metrics: [{ label: "Shortest", distanceM: 100, shadowCoverage: 0.6 }],
  shadowProvenance: null,
};
const routeEvidence: ToolResultEnvelope = {
  resultId: "result-route",
  toolName: "plan_shadowed_route",
  producedAt: "2026-08-08T18:00:00.000Z",
  requestId: "request-7",
  actionId: "action-7",
  planRevision: 7,
  provenance: { category: "application_state", bounded: true },
  fieldProvenance: {},
  payload: routeTerminal,
};
const routeAnswer: VerifiedAnswer = {
  blocks: [{ kind: "claim", claimId: "route-claim" }],
  rejectedProseCount: 0,
  danglingClaimBlocks: 0,
  duplicateClaimProposals: 0,
  receipts: [
    {
      claimId: "route-claim",
      kind: "route",
      subject: "route",
      value: { status: "completed" },
      supportingResultIds: ["result-route"],
      observedAt: routeEvidence.producedAt,
      confidence: "unknown",
      verification: "verified",
      requestId: "request-7",
      actionId: "action-7",
      planRevision: 7,
      mapObjectId: "route:request-7:action-7:7",
    },
  ],
};

describe("useAgent receipt revalidation", () => {
  beforeEach(() => {
    runAgent.mockReset();
    runAgent.mockResolvedValue({
      text: "Route completed — plan revision 7",
      history: [],
      answer: routeAnswer,
      evidence: [routeEvidence],
    });
  });

  it("marks an old route receipt unverified when the map owner advances its revision", async () => {
    let revision = 7;
    const routeObjects = () =>
      revision === 7 ? [{ id: "route:request-7:action-7:7", kind: "route" as const }] : [];
    const { result, rerender } = renderHook(() =>
      useAgent({
        mapRef: { current: null },
        shadowLayerRef: { current: null },
        dateRef: { current: new Date("2026-08-08T18:00:00.000Z") },
        setDate: vi.fn(),
        mapUtcOffsetMin: 0,
        userLocation: null,
        setWaypointA: vi.fn(),
        setWaypointB: vi.fn(),
        setAdditionalWaypoints: vi.fn(),
        createRoutePlanRequest: vi.fn(),
        submitRoutePlan: vi.fn(),
        cancelRoutePlan: vi.fn(),
        getCurrentPlanRevision: () => revision,
        getMapObjects: routeObjects,
        registerMapObjects: vi.fn(),
        setPins: vi.fn(),
        focusMapObject: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.sendMessage("plan a route");
    });
    const current = result.current.messages.at(-1)?.answer?.receipts[0];
    expect(current?.verification).toBe("verified");
    expect(guideNote(result.current.messages.at(-1)!.answer!, [], ["route:request-7:action-7:7"])?.action?.label).toBe("View route");

    revision = 8;
    rerender();
    const superseded = result.current.messages.at(-1)?.answer?.receipts[0];
    expect(superseded).toMatchObject({
      verification: "rejected",
      rejectionReason: "stale_plan_revision",
    });
    expect(guideNote(result.current.messages.at(-1)!.answer!, [], [])).toBeNull();
  });
});

const emptyResult = {
  text: "", history: [], evidence: [],
  answer: { blocks: [], receipts: [], rejectedProseCount: 0, danglingClaimBlocks: 0, duplicateClaimProposals: 0 },
};
function shadeHookArgs() {
  return { ...shadeContext(), mapUtcOffsetMin: -240, userLocation: null,
    getMapObjects: () => [], registerMapObjects: vi.fn(), focusMapObject: vi.fn() };
}

describe("useAgent shade-window lifecycle", () => {
  beforeEach(() => runAgent.mockReset());

  it("clears registered candidates and receipt objects on reset", async () => {
    let ctx!: AgentContext;
    const payload = shadePayload();
    runAgent.mockImplementationOnce(async (options) => {
      ctx = options.ctx;
      ctx.registerShadeCandidates(payload.results.map(spot => ({ spot, requestedDate:payload.requestedDate, mode:payload.mode })));
      ctx.registerMapObjects(payload.results.map(spot => ({ id:shadeWindowObjectId("r",spot.candidateId),kind:"shade_window",lat:spot.lat,lng:spot.lng })));
      return emptyResult;
    });
    const args = shadeHookArgs();
    const { result } = renderHook(() => useAgent(args));
    await act(async () => { await result.current.sendMessage("Find shade from 2 to 4pm"); });
    expect(ctx.getShadeCandidates()).toHaveLength(2);
    expect(ctx.getMapObjects()).toHaveLength(2);
    act(() => result.current.reset());
    expect(ctx.getShadeCandidates()).toEqual([]);
    expect(ctx.getMapObjects()).toEqual([]);
    expect(result.current.messages).toEqual([]);
  });

  it("cancels a pending read and ignores its late registry writes and answer", async () => {
    let ctx!: AgentContext;
    let resolve!: (result: typeof emptyResult) => void;
    runAgent.mockImplementationOnce((options) => {
      ctx = options.ctx;
      return new Promise<typeof emptyResult>(done => { resolve = done; });
    });
    const args = shadeHookArgs();
    const { result } = renderHook(() => useAgent(args));
    let pending!: Promise<void>;
    act(() => { pending = result.current.sendMessage("Find shade from 2 to 4pm"); });
    await waitFor(() => expect(runAgent).toHaveBeenCalled());
    act(() => result.current.reset());
    expect(ctx.signal?.aborted).toBe(true);
    const payload = shadePayload();
    ctx.registerShadeCandidates(payload.results.map(spot => ({spot,requestedDate:payload.requestedDate,mode:payload.mode})));
    ctx.registerMapObjects([{id:"late",kind:"shade_window",lat:40,lng:-73}]);
    expect(ctx.getShadeCandidates()).toEqual([]);
    expect(ctx.getMapObjects()).toEqual([]);
    await act(async () => { resolve(emptyResult); await pending; });
    expect(result.current.messages).toEqual([]);
    expect(result.current.isThinking).toBe(false);
  });
});
