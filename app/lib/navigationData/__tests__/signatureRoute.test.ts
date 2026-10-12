import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { swapSideAgainstCanonical } from "../../routing";
import { routeStreetTypes, streetShadeGroup, streetTypeBreakdown } from "../signatureRoute";
import { createSignatureView } from "../signatureView";
import {
  SIGNATURE_BYTES_PER_SIDE,
  SIGNATURE_COMPONENTS,
  type NavigationShadeShard,
  type NavigationSignatureIndex,
} from "../shardContract";

const prep = join(import.meta.dirname, "..", "..", "..", "..", "server", "navigation-prep");
const model = JSON.parse(readFileSync(join(prep, "models", "signatures-v1.json"), "utf8"));

/**
 * One segment, 10 → 20, whose canonical left sidewalk is type 6 and right is
 * type 0: a canyon side and a sunny side, so a flipped side is visible.
 */
function view() {
  const payload = new Uint8Array(2 * SIGNATURE_BYTES_PER_SIDE);
  payload[SIGNATURE_COMPONENTS] = 6;
  payload[SIGNATURE_BYTES_PER_SIDE + SIGNATURE_COMPONENTS] = 0;
  const index = { model, cells: [] } as unknown as NavigationSignatureIndex;
  const shard = { segments: [[10, 20]] } as unknown as NavigationShadeShard;
  return createSignatureView(index, [{ shard, payload }]);
}

const coordinates = new Map<number, [number, number]>([
  [10, [-73.985, 40.755]],
  [20, [-73.984, 40.756]],
  [30, [-73.983, 40.757]],
]);

describe("street shade groups", () => {
  it("bins the frozen types sunny → shaded by their summer hours", () => {
    expect(model.types.map(streetShadeGroup)).toEqual([1, 4, 2, 2, 1, 3, 3, 1]);
  });
});

describe("routeStreetTypes", () => {
  it("reads the walked sidewalk in the canonical frame", () => {
    // Walking canonically, the traveller's left is the canonical left (type 6).
    expect(routeStreetTypes([10, 20], ["left"], coordinates, view())).toMatchObject([
      { type: 6, group: 3, side: "left" },
    ]);
    // Walking against it, the traveller's left is the canonical right (type 0).
    expect(routeStreetTypes([20, 10], ["left"], coordinates, view())).toMatchObject([
      { type: 0, group: 1, side: "left" },
    ]);
    expect(routeStreetTypes([20, 10], ["right"], coordinates, view())[0].type).toBe(6);
  });

  it("skips edges it cannot place rather than guessing", () => {
    // A null side (a connector), and an edge outside the loaded cells (20 → 30).
    expect(routeStreetTypes([10, 20, 30], [null, "left"], coordinates, view())).toEqual([]);
  });

  it("skips a mid-block snap stretch, whose copied side names no walked kerb", () => {
    // Real snapping copies one parallel edge into the virtual node, so a snap
    // edge's side is fixed, not chosen: colouring it would guess.
    const withSnap = new Map(coordinates).set(-1, [-73.9845, 40.7555]);
    expect(routeStreetTypes([-1, 20], ["left"], withSnap, view())).toEqual([]);
    expect(routeStreetTypes([20, -1], ["left"], withSnap, view())).toEqual([]);
  });

  it("uses the same frame swap as the routing graph", () => {
    expect(swapSideAgainstCanonical(1, 2, "left")).toBe("left");
    expect(swapSideAgainstCanonical(2, 1, "left")).toBe("right");
    expect(swapSideAgainstCanonical(2, 1, swapSideAgainstCanonical(2, 1, "right"))).toBe("right");
  });
});

describe("streetTypeBreakdown", () => {
  // Due-north segments of a given length in metres.
  const seg = (metres: number, group: 1 | 2 | 3 | 4) => ({
    from: [-73.985, 40.755] as [number, number],
    to: [-73.985, 40.755 + metres / 110_540] as [number, number],
    side: "left" as const,
    type: 0,
    group,
  });

  it("weighs groups by walked distance, largest first, folding slivers away", () => {
    expect(streetTypeBreakdown([seg(60, 3), seg(30, 1), seg(5, 4), seg(3, 4), seg(2, 2)])).toBe(
      "Summer shade, by sidewalk: 60% partly shaded · 30% sunny through the day · 8% shaded all day",
    );
  });

  it("says how much of the walk the shares cover when data is missing for part of it", () => {
    expect(streetTypeBreakdown([seg(50, 3)], 50)).toBe("Summer shade, by sidewalk: 100% partly shaded");
    expect(streetTypeBreakdown([seg(50, 3)], 100)).toBe(
      "Summer shade, by sidewalk: 100% partly shaded (of the 50% of the walk with shade data)",
    );
  });

  it("says nothing without segments", () => {
    expect(streetTypeBreakdown([])).toBeNull();
  });
});

