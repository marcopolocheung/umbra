import { describe, expect, it } from "vitest";
import { guideNote } from "../guideNote";
import { verifyAnswer, type MapObject, type ToolResultEnvelope } from "../receipts";

const now = "2026-08-08T18:00:00.000Z";
const pinA = { id: "pin:a", kind: "pin" as const, lat: 40.75, lng: -73.98 };
const pinB = { id: "pin:b", kind: "pin" as const, lat: 40.76, lng: -73.99 };
const routeId = "route:request-a:action-a:7";
const routeObject = { id: routeId, kind: "route" as const };
const placeEvidence: ToolResultEnvelope = {
  resultId: "places", toolName: "search_places", producedAt: now,
  provenance: { category: "application_state", bounded: true }, fieldProvenance: {},
  payload: { results: [
    { name: "Park A", lat: pinA.lat, lng: pinA.lng },
    { name: "Park B", lat: pinB.lat, lng: pinB.lng },
  ] },
};
const terminal = {
  requestId: "request-a", actionId: "action-a", planRevision: 7,
  inputVersion: 1, retry: 0, idempotencyKey: "action-a:0",
  status: "completed" as const,
  metrics: [{ label: "Shortest", distanceM: 100, shadowCoverage: 0.6 }],
  shadowProvenance: null,
};
const routeEvidence: ToolResultEnvelope = {
  resultId: "route", toolName: "plan_shadowed_route", producedAt: now,
  requestId: terminal.requestId, actionId: terminal.actionId, planRevision: terminal.planRevision,
  provenance: { category: "application_state", bounded: true }, fieldProvenance: {},
  payload: terminal,
};
const proposal = {
  // None of these model-controlled display fields may become a guide note or action.
  text: "Open listing at https://example.invalid",
  action: { label: "Open listing", url: "https://example.invalid" },
  blocks: [{ kind: "text", text: "Open listing" }],
  receipts: [
    { kind: "place", subject: "Fake A", value: { lat: pinA.lat, lng: pinA.lng }, supportingResultIds: ["places"] },
    { kind: "place", subject: "Fake B", value: { lat: pinB.lat, lng: pinB.lng }, supportingResultIds: ["places"] },
    { kind: "route", subject: "fake route", value: { status: "completed" }, supportingResultIds: ["route"], mapObjectId: "route:invented" },
  ],
};
const checked = (mapObjects: MapObject[] = [pinA, pinB, routeObject], revision = 7) =>
  verifyAnswer(proposal, { evidence: [placeEvidence, routeEvidence], mapObjects, currentPlanRevision: revision, now });

describe("assistant guide note", () => {
  it("uses current pin order and the verified route identity, never model text or actions", () => {
    const answer = checked();
    const note = guideNote(answer, [pinB.id, pinA.id], [routeId]);
    expect(note?.text).toContain("Stops 1 and 2 are pinned");
    expect(note?.claimIds).toEqual([
      answer.receipts[1].claimId, answer.receipts[0].claimId, answer.receipts[2].claimId,
    ]);
    expect(note?.action).toEqual({ label: "View route", mapObjectId: routeId });
    expect(JSON.stringify(note)).not.toMatch(/example|Open listing|invented|Fake/);
  });

  it("drops stale stops and route actions when their current map identities disappear", () => {
    const answer = checked([pinA, routeObject], 8);
    const note = guideNote(answer, [pinA.id], []);
    expect(note?.text).toMatch(/^Stop 1 is pinned/);
    expect(note?.action).toBeUndefined();
    expect(guideNote(checked([], 8), [], [])).toBeNull();
  });

  it("describes a verified partial route accurately and suppresses an old map route", () => {
    const partial = {
      ...terminal, status: "partial" as const,
      unroutableLegs: [{ completedLegs: 0, failedLeg: 1, totalLegs: 2 }],
    };
    const evidence = { ...routeEvidence, payload: partial };
    const answer = verifyAnswer(
      { receipts: [{ kind: "route", subject: "route", value: { status: "partial" }, supportingResultIds: ["route"] }] },
      { evidence: [evidence], mapObjects: [routeObject], currentPlanRevision: 7, now },
    );
    expect(guideNote(answer, [], [routeId])?.action?.label).toBe("View partial route");
    expect(guideNote(answer, [], ["route:other:action:7"])).toBeNull();
  });
});
