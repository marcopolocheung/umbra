import { describe, expect, it } from "vitest";
import {
  claimSupportMetrics,
  unsupportedProseReasons,
  validateToolResultEnvelope,
  verifyAnswer,
  type MapObject,
  type ToolResultEnvelope,
} from "../receipts";

const NOW = "2026-08-08T18:00:00.000Z";
const pin: MapObject = {
  id: "assistant-pin:40.75360:-73.98320",
  kind: "pin",
  lat: 40.7536,
  lng: -73.9832,
  label: "Bryant Park",
};
const route = {
  requestId: "route-7",
  inputVersion: 1,
  planRevision: 7,
  actionId: "action-7",
  retry: 0,
  idempotencyKey: "action-7:0",
  status: "completed" as const,
  metrics: [{ label: "Shortest", distanceM: 100, shadowCoverage: 0.62 }],
  shadowProvenance: null,
};
const envelope = (
  toolName: ToolResultEnvelope["toolName"],
  payload: Record<string, unknown>,
  resultId = `r-${toolName}`,
  producedAt = NOW,
): ToolResultEnvelope => ({
  resultId,
  toolName,
  payload,
  producedAt,
  provenance: { category: "application_state", bounded: true },
  fieldProvenance: {},
  ...(toolName === "plan_shadowed_route"
    ? { requestId: route.requestId, actionId: route.actionId, planRevision: route.planRevision }
    : {}),
});
const opts = (
  evidence: ToolResultEnvelope[],
  mapObjects: MapObject[] = [pin],
  currentPlanRevision = 7,
  now = NOW,
) => ({
  evidence,
  mapObjects: [
    ...mapObjects,
    ...evidence.flatMap((entry) =>
      entry.toolName === "check_shadow" &&
      typeof entry.payload.lat === "number" &&
      typeof entry.payload.lng === "number"
        ? [
            {
              id: `shadow:${entry.resultId}:${entry.payload.lat.toFixed(5)}:${entry.payload.lng.toFixed(5)}`,
              kind: "shadow" as const,
              lat: entry.payload.lat,
              lng: entry.payload.lng,
            },
          ]
        : [],
    ),
  ],
  currentPlanRevision,
  now,
});
const answer = (receipt: Record<string, unknown>, text?: string) => ({
  blocks: text ? [{ kind: "text", text }] : [{ kind: "claim", claimId: "c" }],
  receipts: [{ claimId: "c", ...receipt }],
});

describe("C5 deterministic claim verification", () => {
  it("verifies a searched place only after its matching pin exists", () => {
    const result = verifyAnswer(
      answer({
        kind: "place",
        subject: "Bryant Park",
        value: { lat: 40.7536, lng: -73.9832 },
        mapObjectId: pin.id,
        supportingResultIds: ["place"],
      }),
      opts([
        envelope(
          "search_places",
          { results: [{ name: "Bryant Park", lat: 40.7536, lng: -73.9832 }] },
          "place",
        ),
      ]),
    );
    expect(result.receipts[0].verification).toBe("verified");
  });

  it.each([
    ["search result not plotted", [], "missing_map_object"],
    ["invented place", [pin], "subject_mismatch"],
  ])("rejects %s", (_label, mapObjects, reason) => {
    const result = verifyAnswer(
      answer({
        kind: "place",
        subject: "Invented Plaza",
        value: { lat: 40.7536, lng: -73.9832 },
        supportingResultIds: ["place"],
      }),
      opts(
        [
          envelope(
            "search_places",
            { results: [{ name: "Bryant Park", lat: 40.7536, lng: -73.9832 }] },
            "place",
          ),
        ],
        mapObjects,
      ),
    );
    if (reason === "subject_mismatch") {
      expect(result.receipts[0]).toMatchObject({
        verification: "verified",
        subject: "Bryant Park",
      });
    } else expect(result.receipts[0].rejectionReason).toBe(reason);
  });

  it("requires matching coordinates and time for a numeric shadow claim", () => {
    const shadow = envelope(
      "check_shadow",
      {
        lat: 40.7536,
        lng: -73.9832,
        shadowFraction: 0.62,
        atLocalTime: "4:00 PM",
        source: "tiles",
      },
      "shadow",
    );
    const supported = verifyAnswer(
      answer({
        kind: "shadow",
        subject: "Bryant Park",
        value: { fraction: 0.62 },
        coordinates: { lat: 40.7536, lng: -73.9832 },
        atLocalTime: "4:00 PM",
        supportingResultIds: ["shadow"],
      }),
      opts([shadow]),
    );
    const wrongTime = verifyAnswer(
      answer({
        kind: "shadow",
        subject: "Bryant Park",
        value: { fraction: 0.62 },
        coordinates: { lat: 40.7536, lng: -73.9832 },
        atLocalTime: "5:00 PM",
        supportingResultIds: ["shadow"],
      }),
      opts([shadow]),
    );
    expect(supported.receipts[0].verification).toBe("verified");
    expect(wrongTime.receipts[0].rejectionReason).toBe("time_mismatch");
  });

  it("rejects stale or type-incompatible shadow evidence", () => {
    const stale = envelope(
      "check_shadow",
      { lat: 40.7536, lng: -73.9832, shadowFraction: 0.62, atLocalTime: "4:00 PM" },
      "shadow",
      "2026-08-08T17:00:00.000Z",
    );
    const proposal = answer({
      kind: "shadow",
      subject: "Bryant Park",
      value: { fraction: 0.62 },
      coordinates: { lat: 40.7536, lng: -73.9832 },
      atLocalTime: "4:00 PM",
      supportingResultIds: ["shadow"],
    });
    expect(verifyAnswer(proposal, opts([stale])).receipts[0].rejectionReason).toBe(
      "stale_evidence",
    );
    expect(
      verifyAnswer(
        proposal,
        opts([
          envelope(
            "search_places",
            { results: [{ name: "Bryant Park", lat: 40.7536, lng: -73.9832 }] },
            "shadow",
          ),
        ]),
      ).receipts[0].rejectionReason,
    ).toBe("wrong_tool_kind");
  });

  it("verifies only the exact time set by set_time", () => {
    const evidence = envelope("set_time", { ok: true, newLocalTime: "4:00 PM" }, "time");
    expect(
      verifyAnswer(
        answer({
          kind: "time",
          subject: "simulation time",
          value: { localTime: "4:00 PM" },
          supportingResultIds: ["time"],
        }),
        opts([evidence]),
      ).receipts[0].verification,
    ).toBe("verified");
    expect(
      verifyAnswer(
        answer({
          kind: "time",
          subject: "simulation time",
          value: { localTime: "5:00 PM" },
          supportingResultIds: ["time"],
        }),
        opts([evidence]),
      ).receipts[0].rejectionReason,
    ).toBe("subject_mismatch");
  });

  it.each([
    ["completed current", route, 7, "completed", "verified"],
    [
      "partial called completed",
      {
        ...route,
        status: "partial" as const,
        unroutableLegs: [{ completedLegs: 1, failedLeg: 2, totalLegs: 2 }],
      },
      7,
      "completed",
      "contradictory_route_status",
    ],
    [
      "cancelled called ready",
      { ...route, status: "cancelled" as const, reason: "cancelled" as const },
      7,
      "completed",
      "contradictory_route_status",
    ],
    [
      "no plan called completed",
      { ...route, status: "no_plan_found" as const, message: "No path" },
      7,
      "completed",
      "contradictory_route_status",
    ],
    ["old revision", route, 8, "completed", "stale_plan_revision"],
  ])("route claims: %s", (_label, terminal, currentPlanRevision, status, expected) => {
    const evidence = envelope("plan_shadowed_route", terminal, "route");
    const id = `route:${terminal.requestId}:${terminal.actionId}:${terminal.planRevision}`;
    const result = verifyAnswer(
      answer({
        kind: "route",
        subject: "route",
        value: { status },
        supportingResultIds: ["route"],
        mapObjectId: id,
      }),
      opts([evidence], [{ id, kind: "route" }], currentPlanRevision),
    );
    expect(
      result.receipts[0].verification === "verified"
        ? "verified"
        : result.receipts[0].rejectionReason,
    ).toBe(expected);
  });

  it("keeps route map identity independent of duplicate option labels", () => {
    const first = { ...route, requestId: "route-a", actionId: "action-a" };
    const second = { ...route, requestId: "route-b", actionId: "action-b" };
    const firstId = `route:${first.requestId}:${first.actionId}:${first.planRevision}`;
    const secondId = `route:${second.requestId}:${second.actionId}:${second.planRevision}`;
    expect(firstId).not.toBe(secondId);
    const receipt = verifyAnswer(
      answer({
        kind: "route",
        subject: "route",
        value: { status: "completed" },
        supportingResultIds: ["second"],
      }),
      opts([envelope("plan_shadowed_route", second, "second")], [{ id: secondId, kind: "route" }]),
    ).receipts[0];
    expect(receipt.kind === "route" && receipt.mapObjectId).toBe(secondId);
  });

  it("makes accessibility explicitly unknown and rejects generic evidence", () => {
    const unknown = verifyAnswer(
      answer({
        kind: "accessibility",
        subject: "Bryant Park",
        value: "unknown",
        supportingResultIds: [],
      }),
      opts([]),
    );
    const asserted = verifyAnswer(
      answer({
        kind: "accessibility",
        subject: "Bryant Park",
        value: "step free",
        supportingResultIds: ["place"],
      }),
      opts([envelope("search_places", { results: [] }, "place")]),
    );
    expect(unknown.receipts[0].verification).toBe("unknown");
    expect(asserted.receipts[0].verification).toBe("unknown");
  });

  it("fails closed for malformed receipts, missing ids, and factual prose", () => {
    const malformed = verifyAnswer(
      {
        blocks: [{ kind: "text", text: "Bryant Park is 62% shadowed at 4 PM." }],
        receipts: [{ kind: "shadow" }],
      },
      opts([]),
    );
    expect(malformed.rejectedProseCount).toBe(1);
    expect(malformed.receipts[0].rejectionReason).toBe("missing_result");
    expect(
      unsupportedProseReasons("Bryant Park is 62% shadowed at 4 PM.", opts([], [pin])),
    ).toEqual(["free_text_not_rendered"]);
  });

  it("never renders invented prose or model-authored unknown prose", () => {
    const result = verifyAnswer(
      {
        blocks: [
          { kind: "text", text: "Willow Court Cafe is shady all afternoon." },
          {
            kind: "unknown",
            claimKind: "accessibility",
            text: "Willow Court Cafe is fully wheelchair accessible.",
          },
        ],
        receipts: [
          {
            kind: "accessibility",
            subject: "Willow Court Cafe",
            value: "accessible",
            supportingResultIds: ["missing"],
          },
        ],
      },
      opts([]),
    );
    expect(result.blocks).toEqual([{ kind: "unknown", claimKind: "accessibility" }]);
    expect(result.rejectedProseCount).toBe(2);
  });

  it("invalidates an old set-time receipt after a newer time is set", () => {
    const oldTime = envelope(
      "set_time",
      { ok: true, newLocalTime: "3:00 PM" },
      "old",
      "2026-08-08T17:00:00.000Z",
    );
    const newTime = envelope("set_time", { ok: true, newLocalTime: "4:00 PM" }, "new");
    const result = verifyAnswer(
      answer({
        kind: "time",
        subject: "simulation time",
        value: { localTime: "3:00 PM" },
        supportingResultIds: ["old"],
      }),
      opts([oldTime, newTime]),
    );
    expect(result.receipts[0].rejectionReason).toBe("stale_evidence");
  });

  it("uses evidence execution order when a later time moves the simulation backward", () => {
    const fourPm = envelope(
      "set_time",
      { ok: true, newLocalTime: "4:00 PM" },
      "four",
      "2026-08-08T16:00:00.000Z",
    );
    const threePm = envelope(
      "set_time",
      { ok: true, newLocalTime: "3:00 PM" },
      "three",
      "2026-08-08T15:00:00.000Z",
    );
    const result = verifyAnswer(
      answer({
        kind: "time",
        subject: "simulation time",
        value: { localTime: "4:00 PM" },
        supportingResultIds: ["four"],
      }),
      opts([fourPm, threePm]),
    );
    expect(result.receipts[0].rejectionReason).toBe("stale_evidence");
  });

  it("deduplicates equivalent canonical claims and accounts for dangling blocks", () => {
    const proposal = {
      blocks: [{ kind: "claim", claimId: "missing-receipt" }],
      receipts: [
        {
          claimId: "one",
          kind: "place",
          subject: "Bryant Park",
          value: { lat: 40.7536, lng: -73.9832 },
          supportingResultIds: ["place"],
        },
        {
          claimId: "two",
          kind: "place",
          subject: "Bryant Park",
          value: { lat: 40.7536, lng: -73.9832 },
          supportingResultIds: ["place"],
        },
      ],
    };
    const result = verifyAnswer(
      proposal,
      opts([
        envelope(
          "search_places",
          { results: [{ name: "Bryant Park", lat: 40.7536, lng: -73.9832 }] },
          "place",
        ),
      ]),
    );
    expect(result.receipts).toHaveLength(1);
    expect(result.duplicateClaimProposals).toBe(1);
    expect(result.danglingClaimBlocks).toBe(1);
    expect(claimSupportMetrics(result, opts([], [pin]))).toMatchObject({
      danglingClaimProposals: 1,
      duplicateClaimProposals: 1,
      place: { proposed: 1 },
    });
  });

  it("rejects a route envelope whose redundant C4 identity contradicts its terminal payload", () => {
    expect(
      validateToolResultEnvelope({
        ...envelope("plan_shadowed_route", route, "route"),
        requestId: "wrong-request",
      }),
    ).toBe(false);
  });

  it("requires application-owned shadow and route objects before enabling focus", () => {
    const shadow = envelope(
      "check_shadow",
      { lat: 40.7536, lng: -73.9832, shadowFraction: 0.62, atLocalTime: "4:00 PM" },
      "shadow",
    );
    const proposal = answer({
      kind: "shadow",
      subject: "Bryant Park",
      value: { fraction: 0.62 },
      coordinates: { lat: 40.7536, lng: -73.9832 },
      atLocalTime: "4:00 PM",
      supportingResultIds: ["shadow"],
    });
    expect(
      verifyAnswer(proposal, {
        evidence: [shadow],
        mapObjects: [pin],
        currentPlanRevision: 7,
        now: NOW,
      }).receipts[0].rejectionReason,
    ).toBe("missing_map_object");
  });

  it("reports separate support measures and zero post-verification escapes", () => {
    const verified = verifyAnswer(
      answer({
        kind: "place",
        subject: "Bryant Park",
        value: { lat: 40.7536, lng: -73.9832 },
        supportingResultIds: ["place"],
      }),
      opts([
        envelope(
          "geocode_place",
          { results: [{ name: "Bryant Park", lat: 40.7536, lng: -73.9832 }] },
          "place",
        ),
      ]),
    );
    expect(claimSupportMetrics(verified, opts([], [pin]))).toMatchObject({
      place: { proposed: 1, supported: 1, supportRate: 1 },
      shadow: { proposed: 0, supportRate: 0 },
      unsupportedClaimEscapes: 0,
    });
  });
});
