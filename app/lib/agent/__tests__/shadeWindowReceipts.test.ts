import { describe, expect, it } from "vitest";
import {
  verifyAnswer,
  validateToolResultEnvelope,
  receiptLabel,
  unknownLabel,
  type ToolResultEnvelope,
  type MapObject,
} from "../receipts";
import { shadePayload, SHADE_QUERY } from "./shadeFixture";
import {
  shadeClockMinutes,
  shadeWindowObjectId,
  isShadeWindowPayload,
  shadeTimelineRows,
  shadeRouteTimeMatches,
} from "../shadeWindows";

const payload = shadePayload();
const spot = payload.results[0];
const evidence: ToolResultEnvelope = {
  resultId: "shade-r",
  toolName: "find_shade_spots",
  producedAt: "2026-07-04T18:00:00Z",
  sourceVersion: payload.generation,
  provenance: { category: "application_state", bounded: true },
  fieldProvenance: {},
  payload,
};
const objects: MapObject[] = payload.results.map((s) => ({
  id: shadeWindowObjectId(evidence.resultId, s.candidateId),
  kind: "shade_window",
  lat: s.lat,
  lng: s.lng,
  label: s.label,
}));
const proposal = {
  kind: "shade_window",
  candidateId: spot.candidateId,
  requestedDate: payload.requestedDate,
  requestedWindow: payload.requestedWindow,
  value: { meanShade: spot.meanShade },
  supportingResultIds: [evidence.resultId],
};
const verify = (overrides: Record<string, unknown> = {}, mapObjects = objects, result = evidence) =>
  verifyAnswer(
    { receipts: [{ ...proposal, ...overrides }] },
    { evidence: [result], mapObjects, currentPlanRevision: 1, now: "2030-01-01T00:00:00Z" },
  );

describe("shade-window receipts", () => {
  it("canonicalizes labels, exact values, all hours and generation", () => {
    const answer = verify({ subject: "Invented café with a seat" });
    expect(answer.receipts[0]).toMatchObject({
      kind: "shade_window",
      verification: "verified",
      subject: spot.label,
      candidateId: spot.candidateId,
      requestedDate: "2026-07-04",
      value: { meanShade: 235 / 255, hours: spot.hours },
      sourceVersion: payload.generation,
      basis: payload.basis,
    });
    expect(receiptLabel(answer.receipts[0])).toContain("92% modelled shade");
    expect(validateToolResultEnvelope(evidence)).toBe(true);
    expect(
      verifyAnswer(
        { receipts: answer.receipts },
        {
          evidence: [evidence],
          mapObjects: objects,
          currentPlanRevision: 1,
          now: evidence.producedAt,
        },
      ).receipts[0].verification,
    ).toBe("verified");
  });

  it("allows whole-percentage rounding but rejects changed values", () => {
    expect(verify({ value: { meanShade: 0.92 } }).receipts[0].verification).toBe("verified");
    for (const meanShade of [0.91, 0.93, spot.meanShade + 1 / 255, NaN, 1.1])
      expect(verify({ value: { meanShade } }).receipts[0].verification).toBe("rejected");
  });

  it("checks every proposed hour against exact slots and displayed precision", () => {
    expect(
      verify({ value: { meanShade: spot.meanShade, hours: [{ ...spot.hours[0], shade: 0.92 }] } })
        .receipts[0].verification,
    ).toBe("verified");
    for (const h of [
      { ...spot.hours[0], shade: 0.91 },
      { ...spot.hours[0], minutes: 841 },
      { ...spot.hours[0], slot: 999 },
    ])
      expect(
        verify({ value: { meanShade: spot.meanShade, hours: [h] } }).receipts[0].verification,
      ).toBe("rejected");
  });

  it.each([
    { candidateId: "forged" },
    { candidateId: payload.results[1].candidateId },
    { requestedDate: "2026-07-15" },
    { requestedWindow: { fromMinutes: 855, toMinutes: 960 } },
    { supportingResultIds: ["missing"] },
  ])("rejects incompatible proposals %j", (overrides) => {
    expect(verify(overrides).receipts[0].verification).toBe("rejected");
  });

  it("requires exact map identity and coordinates, including opposite sidewalks", () => {
    expect(verify({}, [objects[1]]).receipts[0].rejectionReason).toBe("missing_map_object");
    expect(verify({}, [{ ...objects[0], lat: objects[1].lat }]).receipts[0].verification).toBe(
      "rejected",
    );
  });

  it("rejects wrong tool kinds and mismatched source generations", () => {
    expect(
      verify({}, objects, { ...evidence, toolName: "check_shadow" }).receipts[0].rejectionReason,
    ).toBe("wrong_tool_kind");
    expect(validateToolResultEnvelope({ ...evidence, sourceVersion: "other" })).toBe(false);
    expect(
      validateToolResultEnvelope({
        ...evidence,
        provenance: { category: "provider_controlled", bounded: true },
      }),
    ).toBe(false);
  });

  it("never renders stray model percentages or times", () => {
    const answer = verifyAnswer(
      { blocks: [{ kind: "text", text: "73% shady until 9:45 AM" }], receipts: [proposal] },
      {
        evidence: [evidence],
        mapObjects: objects,
        currentPlanRevision: 1,
        now: evidence.producedAt,
      },
    );
    expect(answer.rejectedProseCount).toBe(1);
    expect(JSON.stringify(answer.blocks)).not.toContain("73%");
    expect(answer.blocks[0].kind).toBe("claim");
  });

  it("creates a specific unavailable block from current evidence without trusting model prose", () => {
    const unavailable: ToolResultEnvelope = {
      ...evidence,
      payload: { status: "unavailable", reason: "outside_coverage", results: [] },
    };
    const answer = verifyAnswer(
      {},
      {
        evidence: [unavailable],
        mapObjects: [],
        currentPlanRevision: 1,
        now: evidence.producedAt,
        currentShadeResultIds: [evidence.resultId],
      },
    );
    expect(answer.blocks).toEqual([
      { kind: "unknown", claimKind: "shade_window", reason: "outside_coverage" },
    ]);
    expect(unknownLabel("shade_window", "outside_coverage")).toContain("No shade-table data");
    expect(
      verifyAnswer(
        {},
        {
          evidence: [unavailable],
          mapObjects: [],
          currentPlanRevision: 1,
          now: evidence.producedAt,
        },
      ).blocks,
    ).not.toContainEqual(answer.blocks[0]);
  });

  it("deduplicates identical unavailable notices from multiple current searches", () => {
    const first: ToolResultEnvelope = {
      ...evidence,
      payload: { status: "unavailable", reason: "outside_coverage", results: [] },
    };
    const second = { ...first, resultId: "other" };
    const answer = verifyAnswer(
      {},
      {
        evidence: [first, second],
        mapObjects: [],
        currentPlanRevision: 1,
        now: evidence.producedAt,
        currentShadeResultIds: [first.resultId, second.resultId],
      },
    );
    expect(answer.blocks).toEqual([
      { kind: "unknown", claimKind: "shade_window", reason: "outside_coverage" },
    ]);
  });

  it("retains verified claims alongside a partial-coverage notice", () => {
    const partial = { ...evidence, payload: { ...payload, reasons: ["incomplete-data"] } };
    const answer = verifyAnswer(
      { receipts: [proposal] },
      {
        evidence: [partial],
        mapObjects: objects,
        currentPlanRevision: 1,
        now: evidence.producedAt,
        currentShadeResultIds: [evidence.resultId],
      },
    );
    expect(answer.receipts[0].verification).toBe("verified");
    expect(answer.blocks).toContainEqual({ kind: "notice", code: "shade_partial" });
  });
});

describe("shade-window validation and presentation", () => {
  it.each([
    ["2:07 PM", 847],
    ["14:07", 847],
    ["12 AM", 0],
    ["12:00 PM", 720],
    ["2 PM", 840],
    ["23:59", 1439],
  ])("parses %s", (text, minutes) => expect(shadeClockMinutes(text)).toBe(minutes));
  it.each([
    "2",
    "14:07 garbage",
    "2 PM garbage",
    "14:07:30",
    "13 PM",
    "24:00",
    "2:77 PM",
    "-2:00",
    "",
    null,
  ])("rejects malformed clock %s", (text) => expect(shadeClockMinutes(text)).toBeNull());
  it("validates all evidence fields rather than accepting arbitrary numeric-looking results", () => {
    expect(isShadeWindowPayload(payload)).toBe(true);
    expect(
      isShadeWindowPayload({
        ...payload,
        basis: { slotMinutes: 15, zone: "America/New_York", representativeDate: "2026-07-15" },
      }),
    ).toBe(true);
    for (const patch of [
      { basis: { ...payload.basis, representativeDate: "2026-08-15" } },
      { generation: "other" },
      { results: [{ ...spot, meanShade: 0.73 }] },
      { results: [{ ...spot, candidateId: "forged" }] },
      { results: [{ ...spot, hours: [{ ...spot.hours[0], shade: 0.73 }] }] },
    ])
      expect(isShadeWindowPayload({ ...payload, ...patch })).toBe(false);
  });
  it("keeps short windows at quarter hours and aggregates only present long-window samples", () => {
    expect(shadeTimelineRows(spot.hours, "shade")).toHaveLength(8);
    const longer = shadePayload({ fromMinutes: 855, toMinutes: 1080 }).results[0];
    const rows = shadeTimelineRows(longer.hours, "sun");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ fromMinutes: 855, toMinutes: 900 });
    expect(rows[0].fraction).toBe(1 - 235 / 255);
  });
  it("routing retains the selected map date and time model", () => {
    const candidate = { spot, requestedDate: payload.requestedDate, mode: payload.mode };
    expect(shadeRouteTimeMatches(candidate, new Date("2026-07-04T18:00:00Z"))).toBe(true);
    expect(shadeRouteTimeMatches(candidate, new Date("2026-07-05T18:00:00Z"))).toBe(false);
    expect(shadeRouteTimeMatches(candidate, new Date("2026-07-04T20:00:00Z"))).toBe(false);
    expect(SHADE_QUERY.date).toBe(payload.requestedDate);
  });
});
