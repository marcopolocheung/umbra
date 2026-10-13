import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../agentLoop";
import { callModel, rolesShareConfig } from "../llmClient";
import { executeTool } from "../tools";
import { authorizeToolCall, candidateIdentities } from "../authority";
import { shadeContext, shadePayload, SHADE_QUERY } from "./shadeFixture";
import { nycDate } from "../shadeWindows";

vi.mock("../llmClient", () => ({ callModel: vi.fn(), rolesShareConfig: vi.fn() }));
vi.mock("../tools", async (original) => ({
  ...(await original<typeof import("../tools")>()),
  executeTool: vi.fn(),
}));
const args = {
  lat: SHADE_QUERY.lat,
  lng: SHADE_QUERY.lng,
  from: "2 PM",
  to: "4 PM",
  radiusM: 400,
  mode: "shade",
};
const calls = (items: Array<{ name: string; args: Record<string, unknown> }>) => ({
  candidates: [
    { content: { role: "model" as const, parts: items.map((functionCall) => ({ functionCall })) } },
  ],
});
const final = {
  candidates: [{ content: { role: "model" as const, parts: [{ text: "Results are ready." }] } }],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(rolesShareConfig).mockReturnValue(true);
  vi.mocked(executeTool).mockImplementation(async (name, a) => {
    if (name === "get_current_context")
      return {
        center: { lat: SHADE_QUERY.lat, lng: SHADE_QUERY.lng },
        locationKnown: true,
        zoom: 15,
      };
    if (name === "find_shade_spots")
      return { ...shadePayload({ date: a.date as string, mode: a.mode as "shade" | "sun" }) };
    if (name === "plot_points") return { ok: true, plotted: 2 };
    return { error: "Unexpected tool" };
  });
});

describe("shade-window assistant integration", () => {
  it("uses the selected NYC date, registers exact side identities and renders grounded fallback", async () => {
    const ctx = shadeContext();
    vi.mocked(callModel)
      .mockResolvedValueOnce(calls([{ name: "find_shade_spots", args }]))
      .mockResolvedValueOnce(final);
    const result = await runAgent({
      history: [],
      userText: "Find shade near here from 2 to 4pm",
      ctx,
    });
    const call = vi.mocked(executeTool).mock.calls.find(([name]) => name === "find_shade_spots")!;
    expect(call[1]).toMatchObject({
      date: "2026-07-04",
      nearCandidateId: `map-center:${SHADE_QUERY.lat}:${SHADE_QUERY.lng}`,
    });
    expect(ctx.getShadeCandidates()).toHaveLength(2);
    expect(ctx.getShadeCandidates()[0].spot.candidateId).toBe(
      shadePayload().results[0].candidateId,
    );
    expect(
      result.answer.receipts.filter(
        (r) => r.kind === "shade_window" && r.verification === "verified",
      ),
    ).toHaveLength(2);
    expect(result.text).toContain("92% modelled shade");
    expect(result.metrics.shade_window.supported).toBe(2);
    expect(
      vi
        .mocked(executeTool)
        .mock.calls.some(([name]) => name === "set_time" || name === "check_shadow"),
    ).toBe(false);
    const pinArgs = vi.mocked(executeTool).mock.calls.find(([name]) => name === "plot_points")![1];
    expect((pinArgs.points as Array<{ candidateId: string }>).map((p) => p.candidateId)).toEqual(
      shadePayload().results.map((p) => p.candidateId),
    );
  });

  it("supports explicit dates and sun mode without moving the timeline", async () => {
    const ctx = shadeContext();
    const before = ctx.dateRef.current;
    vi.mocked(callModel)
      .mockResolvedValueOnce(
        calls([{ name: "find_shade_spots", args: { ...args, date: "2028-08-03", mode: "sun" } }]),
      )
      .mockResolvedValueOnce(final);
    const result = await runAgent({
      history: [],
      userText: "Find somewhere sunny on August 3 from 2 to 4pm",
      ctx,
    });
    expect(result.text).toContain("2028-08-03");
    expect(result.answer.receipts[0]).toMatchObject({ kind: "shade_window", mode: "sun" });
    expect(ctx.dateRef.current).toBe(before);
  });

  it("deduplicates repeated calls within the turn, but not across turns", async () => {
    const ctx = shadeContext();
    const cache = new Map();
    vi.mocked(callModel)
      .mockResolvedValueOnce(
        calls([
          { name: "find_shade_spots", args },
          { name: "find_shade_spots", args },
        ]),
      )
      .mockResolvedValueOnce(final);
    const first = await runAgent({
      history: [],
      cache,
      userText: "Find shade near here from 2 to 4pm",
      ctx,
    });
    expect(
      vi.mocked(executeTool).mock.calls.filter(([name]) => name === "find_shade_spots"),
    ).toHaveLength(1);
    expect(first.evidence.filter((e) => e.toolName === "find_shade_spots")).toHaveLength(1);
    expect([...cache.keys()].some((key) => key.startsWith("find_shade_spots"))).toBe(false);
    ctx.dateRef.current = new Date("2026-08-08T18:00:00Z");
    vi.mocked(callModel)
      .mockResolvedValueOnce(calls([{ name: "find_shade_spots", args }]))
      .mockResolvedValueOnce(final);
    await runAgent({
      history: first.history,
      evidence: first.evidence,
      cache,
      userText: "Find shade near here from 2 to 4pm",
      ctx,
    });
    expect(
      vi.mocked(executeTool).mock.calls.filter(([name]) => name === "find_shade_spots"),
    ).toHaveLength(2);
    expect(
      vi.mocked(executeTool).mock.calls.filter(([name]) => name === "find_shade_spots")[1][1].date,
    ).toBe(nycDate(ctx.dateRef.current));
  });

  it("does not automatically route through shade alternatives", async () => {
    const ctx = shadeContext();
    vi.mocked(callModel)
      .mockResolvedValueOnce(calls([{ name: "find_shade_spots", args }]))
      .mockResolvedValueOnce(final);
    const result = await runAgent({
      history: [],
      userText: "Find shade alternatives for my walk from 2 to 4pm",
      ctx,
    });
    expect(vi.mocked(executeTool).mock.calls.some(([name]) => name === "plan_shadowed_route")).toBe(
      false,
    );
    expect(result.answer.blocks).toContainEqual({ kind: "notice", code: "shade_alternatives" });
  });

  it("renders specific unavailable evidence and does not revive prior shade claims", async () => {
    const ctx = shadeContext();
    vi.mocked(callModel)
      .mockResolvedValueOnce(calls([{ name: "find_shade_spots", args }]))
      .mockResolvedValueOnce(final);
    const previous = await runAgent({
      history: [],
      userText: "Find shade near here from 2 to 4pm",
      ctx,
    });
    const old = vi.mocked(executeTool).getMockImplementation()!;
    vi.mocked(executeTool).mockImplementation((name, ...rest) =>
      name === "find_shade_spots"
        ? Promise.resolve({ status: "unavailable", reason: "outside_coverage", results: [] })
        : old(name, ...rest),
    );
    vi.mocked(callModel)
      .mockResolvedValueOnce(calls([{ name: "find_shade_spots", args }]))
      .mockResolvedValueOnce(final);
    const result = await runAgent({
      history: previous.history,
      evidence: previous.evidence,
      userText: "Find shade near here from 2 to 4pm",
      ctx,
    });
    expect(result.answer.blocks).toContainEqual({
      kind: "unknown",
      claimKind: "shade_window",
      reason: "outside_coverage",
    });
    expect(result.answer.receipts.filter((r) => r.kind === "shade_window")).toHaveLength(0);
    expect(result.text).toContain("No shade-table data");
  });

  it("accepts a successful GPS lookup as a new exact anchor", async () => {
    const ctx = shadeContext();
    const old = vi.mocked(executeTool).getMockImplementation()!;
    vi.mocked(executeTool).mockImplementation((name, ...rest) => {
      if (name === "get_current_context")
        return Promise.resolve({ center: { lat: 0, lng: 0 }, locationKnown: false, zoom: 2 });
      if (name === "locate_user")
        return Promise.resolve({ lat: SHADE_QUERY.lat, lng: SHADE_QUERY.lng });
      return old(name, ...rest);
    });
    vi.mocked(callModel)
      .mockResolvedValueOnce(calls([{ name: "locate_user", args: {} }]))
      .mockResolvedValueOnce(calls([{ name: "find_shade_spots", args }]))
      .mockResolvedValueOnce(final);
    const result = await runAgent({
      history: [],
      userText: "Find shade near me from 2 to 4pm",
      ctx,
    });
    const lookup = result.evidence.find((entry) => entry.toolName === "locate_user")!;
    expect(
      vi.mocked(executeTool).mock.calls.find(([name]) => name === "find_shade_spots")![1]
        .nearCandidateId,
    ).toBe(`location:${lookup.resultId}`);
    expect(result.metrics.shade_window.supported).toBe(2);
  });

  it("rejects unknown and provider-invented anchors", async () => {
    const ctx = shadeContext();
    vi.mocked(callModel)
      .mockResolvedValueOnce(
        calls([
          {
            name: "find_shade_spots",
            args: { ...args, lat: 0, lng: 0, nearCandidateId: "forged" },
          },
        ]),
      )
      .mockResolvedValueOnce(final);
    const result = await runAgent({
      history: [],
      userText: "Find shade nearby from 2 to 4pm",
      ctx,
    });
    expect(vi.mocked(executeTool).mock.calls.some(([name]) => name === "find_shade_spots")).toBe(
      false,
    );
    expect(result.authorityEvents[0]).toMatchObject({
      decision: "rejected",
      reasonCode: "sensitive_argument_not_application_candidate",
    });
  });

  it("preserves only valid application-tool IDs and keeps provider IDs independent", () => {
    const payload = shadePayload();
    expect(candidateIdentities("r", { ...payload, error: "failed" }, "find_shade_spots")).toEqual(
      [],
    );
    expect(
      candidateIdentities("r", { lat: 40, lng: -73, error: "GPS denied" }, "locate_user"),
    ).toEqual([]);
    expect(candidateIdentities("r", payload, "find_shade_spots")[0].id).toBe(
      payload.results[0].candidateId,
    );
    expect(
      candidateIdentities(
        "r",
        { ...payload, results: [{ ...payload.results[0], candidateId: "forged" }] },
        "find_shade_spots",
      ),
    ).toEqual([]);
    expect(
      candidateIdentities(
        "r",
        { results: [{ lat: 40, lng: -73, candidateId: payload.results[0].candidateId }] },
        "search_places",
      ),
    ).toEqual([{ id: "candidate:r:0", lat: 40, lng: -73 }]);
    expect(
      authorizeToolCall(
        { currentUserText: "Find shade", candidates: [] },
        "find_shade_spots",
        args,
        ["provider_controlled"],
      ).allowed,
    ).toBe(false);
  });
});

it("uses a registered prior sidewalk for a more-like-this follow-up without a new area search", async () => {
  const ctx = shadeContext(),
    p = shadePayload(),
    spot = p.results[0];
  ctx.registerShadeCandidates([
    { spot, requestedDate: p.requestedDate, requestedWindow: p.requestedWindow, mode: p.mode },
  ]);
  vi.mocked(callModel)
    .mockResolvedValueOnce(
      calls([{ name: "find_shade_spots", args: { likeCandidateId: spot.candidateId } }]),
    )
    .mockResolvedValueOnce(final);
  const result = await runAgent({
    history: [],
    userText: "Find more sidewalks with a shade pattern like the first one",
    ctx,
  });
  const call = vi.mocked(executeTool).mock.calls.find(([name]) => name === "find_shade_spots")!;
  expect(call[1]).toMatchObject({
    likeCandidateId: spot.candidateId,
    nearCandidateId: spot.candidateId,
    date: p.requestedDate,
    from: "2:00 PM",
    to: "4:00 PM",
    radiusM: 400,
  });
  expect(
    result.answer.receipts.some((r) => r.kind === "shade_window" && r.verification === "verified"),
  ).toBe(true);
});

// Production smoke 2026-10-13: Gemini labelled its pins "cafe-0", and the
// authority layer refused the plot.
describe("model argument drift seen in production", () => {
  it("falls back to this turn's verified evidence when the written answer verifies nothing", async () => {
    const ctx = shadeContext();
    const misshapen = JSON.stringify({
      blocks: [{ kind: "claim", claimId: "c1" }],
      receipts: [{ claimId: "c1", kind: "shade", candidateId: "x", supportingResultIds: ["r"] }],
    });
    vi.mocked(callModel)
      .mockResolvedValueOnce(calls([{ name: "find_shade_spots", args }]))
      .mockResolvedValueOnce({
        candidates: [{ content: { role: "model" as const, parts: [{ text: misshapen }] } }],
      });
    const result = await runAgent({
      history: [],
      userText: "Find shade near here from 2 to 4pm",
      ctx,
    });
    expect(result.text).not.toContain("Accessibility");
    expect(
      result.answer.receipts.filter(
        (r) => r.kind === "shade_window" && r.verification === "verified",
      ),
    ).toHaveLength(2);
  });

  it("never rebuilds an unverified answer from an earlier turn's evidence", async () => {
    const ctx = shadeContext();
    vi.mocked(callModel)
      .mockResolvedValueOnce(calls([{ name: "find_shade_spots", args }]))
      .mockResolvedValueOnce(final);
    const first = await runAgent({
      history: [],
      userText: "Find shade near here from 2 to 4pm",
      ctx,
    });
    const nothingVerifies = JSON.stringify({
      blocks: [{ kind: "unknown", claimKind: "accessibility" }],
      receipts: [{ claimId: "a", kind: "accessibility", value: "unknown" }],
    });
    vi.mocked(callModel).mockResolvedValueOnce({
      candidates: [{ content: { role: "model" as const, parts: [{ text: nothingVerifies }] } }],
    });
    const second = await runAgent({
      history: first.history,
      evidence: first.evidence,
      userText: "Is the first one step-free?",
      ctx,
    });
    expect(second.answer.receipts.map((r) => r.kind)).toEqual(["accessibility"]);
  });

  it("pins a named candidate whose coordinates come back at lower precision (#353)", async () => {
    const ctx = shadeContext();
    const [a] = shadePayload().results;
    const echo = (v: number) => Number(v.toPrecision(13));
    vi.mocked(callModel)
      .mockResolvedValueOnce(calls([{ name: "find_shade_spots", args }]))
      .mockResolvedValueOnce(
        calls([
          {
            name: "plot_points",
            args: {
              points: [{ lat: echo(a.lat) + 1e-11, lng: echo(a.lng), candidateId: a.candidateId }],
            },
          },
        ]),
      )
      .mockResolvedValueOnce(final);
    const result = await runAgent({
      history: [],
      userText: "Find shade near here from 2 to 4pm",
      ctx,
    });
    expect(result.authorityEvents.find((e) => e.tool === "plot_points")).toMatchObject({
      decision: "accepted",
    });
    const plotted = vi.mocked(executeTool).mock.calls.find(([name]) => name === "plot_points")![1];
    expect((plotted.points as Array<{ lat: number; lng: number }>)[0]).toMatchObject({
      lat: a.lat,
      lng: a.lng,
    });
  });

  it("does not snap a named candidate's coordinates that are actually elsewhere", async () => {
    const ctx = shadeContext();
    const [a] = shadePayload().results;
    vi.mocked(callModel)
      .mockResolvedValueOnce(calls([{ name: "find_shade_spots", args }]))
      .mockResolvedValueOnce(
        calls([
          {
            name: "plot_points",
            args: { points: [{ lat: a.lat + 1e-6, lng: a.lng, candidateId: a.candidateId }] },
          },
        ]),
      )
      .mockResolvedValueOnce(final);
    const result = await runAgent({
      history: [],
      userText: "Find shade near here from 2 to 4pm",
      ctx,
    });
    expect(result.authorityEvents.find((e) => e.tool === "plot_points")).toMatchObject({
      decision: "rejected",
      reasonCode: "sensitive_argument_not_application_candidate",
    });
  });

  it("gives an invented pin label the app identity only on exact candidate coordinates", async () => {
    const ctx = shadeContext();
    const [a, b] = shadePayload().results;
    vi.mocked(callModel)
      .mockResolvedValueOnce(calls([{ name: "find_shade_spots", args }]))
      .mockResolvedValueOnce(
        calls([
          {
            name: "plot_points",
            args: {
              points: [
                { lat: a.lat, lng: a.lng, label: "A", candidateId: "cafe-0" },
                { lat: b.lat + 0.01, lng: b.lng, label: "B", candidateId: "cafe-1" },
              ],
            },
          },
        ]),
      )
      .mockResolvedValueOnce(final);
    const result = await runAgent({
      history: [],
      userText: "Find shade near here from 2 to 4pm",
      ctx,
    });
    // The second point is not a candidate anywhere, so the whole plot stays refused.
    expect(result.authorityEvents.filter((e) => e.tool === "plot_points")[0]).toMatchObject({
      decision: "rejected",
      reasonCode: "sensitive_argument_not_application_candidate",
    });
    vi.mocked(callModel)
      .mockReset()
      .mockResolvedValueOnce(
        calls([
          {
            name: "plot_points",
            args: { points: [{ lat: a.lat, lng: a.lng, label: "A", candidateId: "cafe-0" }] },
          },
        ]),
      )
      .mockResolvedValueOnce(final);
    vi.mocked(rolesShareConfig).mockReturnValue(true);
    const next = await runAgent({
      history: result.history,
      userText: "Show the first one on the map",
      ctx,
    });
    expect(next.authorityEvents.find((e) => e.tool === "plot_points")).toMatchObject({
      decision: "accepted",
    });
    const plotted = vi
      .mocked(executeTool)
      .mock.calls.filter(([name]) => name === "plot_points")
      .at(-1)![1];
    expect((plotted.points as Array<{ candidateId: string }>)[0].candidateId).toBe(a.candidateId);
  });
});
