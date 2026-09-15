/* @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgent } from "../useAgent";
import type { ToolResultEnvelope, VerifiedAnswer } from "../../lib/agent/receipts";

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

    revision = 8;
    rerender();
    const superseded = result.current.messages.at(-1)?.answer?.receipts[0];
    expect(superseded).toMatchObject({
      verification: "rejected",
      rejectionReason: "stale_plan_revision",
    });
  });
});
