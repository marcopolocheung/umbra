import { describe, expect, it } from "vitest";
import { assembleTileBounds, buildCoverageIndex, type GenerationIdentity } from "../artifacts";
import type { ComposedTile } from "../compose";
import { NumericFieldService } from "../service";
import { STORED_SIZE } from "../types";

const generation = "nyc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-v2";
const identity: GenerationIdentity = { recipeHash: "a".repeat(64), datumHash: "b".repeat(64), hierarchyHash: "c".repeat(64), normalizerHash: "d".repeat(64), compositorHash: "e".repeat(64), treeModelHash: "f".repeat(64), receiverHash: "1".repeat(64) };
function fixturePage(): ComposedTile { const size = STORED_SIZE * STORED_SIZE; return { groundQ: new Int32Array(size), buildingTopQ: new Int32Array(size), crownBaseQ: new Int32Array(size), crownTopQ: new Int32Array(size), flagsAndMaterial: new Uint32Array(size), provenanceIndex: new Uint32Array(size) }; }
function service(loader: ConstructorParameters<typeof NumericFieldService>[0]["loadPages"], budgetBytes = 20_000_000) {
  const coverage = buildCoverageIndex({ generation, availableTiles: ["18/0/0"], activationTiles: ["18/0/0"], activationRule: "fixture", activationBoundary: null });
  const bounds = assembleTileBounds(generation, new Map([["18/0/0", { minG: 0, maxG: 0, maxTopQ: 0, maxCrownQ: 0, coverage: 0 as const }]]));
  return new NumericFieldService({ coverage, bounds, identity, loadPages: loader, cellSizeM: 1, budgetBytes });
}

describe("batch numeric service", () => {
  it("loads a planned page once for both sidewalk sides and carries identities/accounting", async () => {
    let calls = 0; const tile = fixturePage();
    const field = service(async (request) => { calls++; expect(request.pages).toEqual(["18/0/0"]); return { generation, pages: new Map([["18/0/0", tile]]) }; });
    const [edge] = await field.queryEdges([{ id: "edge", left: [{ eastM: .5, northM: .5, tile: "18/0/0" }], right: [{ eastM: 1.5, northM: .5, tile: "18/0/0" }] }], { azimuth: -Math.PI / 2, altitude: .5 });
    expect(calls).toBe(1); expect(edge.left).toMatchObject({ value: null, complete: false, outcome: "missing-page" });
    // The conservative planner intentionally requires possible sunward pages;
    // this tiny fixture demonstrates incomplete, never a fabricated sunny edge.
    expect(edge.identity.generation).toBe(generation);
  });

  it("keeps budget, stale generation and cancelled requests incomplete", async () => {
    const page = fixturePage();
    const lowBudget = service(async () => ({ generation, pages: new Map([["18/0/0", page]]) }), 1);
    expect((await lowBudget.queryPoints([{ eastM: .5, northM: .5, tile: "18/0/0" }], { azimuth: 0, altitude: .5 }))[0]).toMatchObject({ value: null, outcome: "budget" });
    const controller = new AbortController(); controller.abort();
    expect((await lowBudget.queryPoints([{ eastM: .5, northM: .5, tile: "18/0/0" }], { azimuth: 0, altitude: .5 }, { signal: controller.signal }))[0]).toMatchObject({ outcome: "cancelled" });
    expect((await lowBudget.queryPoints([{ eastM: .5, northM: .5, tile: "18/0/0" }], { azimuth: 0, altitude: .5 }, { generation: "old" }))[0]).toMatchObject({ outcome: "stale-generation" });
  });
});
