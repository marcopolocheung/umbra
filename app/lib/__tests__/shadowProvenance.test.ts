import { describe, expect, it } from "vitest";
import {
  type EdgeShadowSource,
  describeShadowProvenance,
  summarizeShadowSource,
} from "../shadowProvenance";
import type { ShadowSource } from "../shadowField/ShadowField";

/**
 * A straight path of `nodeIds`, every leg the same length unless `lengths` says
 * otherwise — so a test can talk about shares of the path without doing arithmetic.
 */
function pathOf(nodeIds: number[], lengths?: number[]) {
  const distanceFor = (a: number, b: number) => {
    if (!lengths) return 100;
    const i = nodeIds.findIndex((id, idx) => id === a && nodeIds[idx + 1] === b);
    return i === -1 ? 100 : lengths[i];
  };
  return { nodeIds, distanceFor };
}

function shadow(source: ShadowSource, confidence = 0.8): EdgeShadowSource {
  return { source, confidence };
}

/** Entries for consecutive pairs of `nodeIds`, keyed the way routing keys them. */
function entriesFor(nodeIds: number[], samples: Array<EdgeShadowSource | null>) {
  const map = new Map<string, EdgeShadowSource>();
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (!sample) continue;
    const a = nodeIds[i];
    const b = nodeIds[i + 1];
    map.set(`${Math.min(a, b)},${Math.max(a, b)}`, sample);
  }
  return map;
}

describe("summarizeShadowSource", () => {
  it("credits a wholly geometry-sourced route to geometry", () => {
    const { nodeIds, distanceFor } = pathOf([1, 2, 3, 4]);
    const entries = entriesFor(nodeIds, [shadow("tiles"), shadow("tiles"), shadow("tiles")]);

    const p = summarizeShadowSource(nodeIds, entries, distanceFor);

    expect(p.dominant).toBe("tiles");
    expect(p.bySource.tiles).toBe(1);
    expect(p.sampledFraction).toBe(1);
  });

  it("keeps a short weak segment from renaming a long confident route", () => {
    // The bug this guards: summarising the whole graph rather than the chosen path
    // would let a 40%-fallback graph label a route whose own edges are all geometry.
    // Here the canvas edge is 5% of the distance — it must move confidence, not source.
    const nodeIds = [1, 2, 3, 4];
    const { distanceFor } = pathOf(nodeIds, [950, 50, 1000]);
    const entries = entriesFor(nodeIds, [
      shadow("tiles", 0.8),
      shadow("canvas", 0.3),
      shadow("tiles", 0.8),
    ]);

    const p = summarizeShadowSource(nodeIds, entries, distanceFor);

    expect(p.dominant).toBe("tiles");
    expect(p.minConfidence).toBe(0.3);
    expect(p.meanConfidence).toBeGreaterThan(0.7);
  });

  it("refuses to name a dominant source when the path is split evenly", () => {
    const nodeIds = [1, 2, 3];
    const { distanceFor } = pathOf(nodeIds, [500, 500]);
    const entries = entriesFor(nodeIds, [shadow("tiles"), shadow("canvas")]);

    const p = summarizeShadowSource(nodeIds, entries, distanceFor);

    expect(describeShadowProvenance(p)).toBe("mixed sources");
  });

  it("counts unsampled virtual snap edges without letting them dock confidence", () => {
    // Virtual nodes are negative and never sampled. Every route starts and ends on
    // one, so if their absence counted as zero confidence, every route in the app
    // would be labelled low-confidence.
    const nodeIds = [-1, 2, 3, -2];
    const { distanceFor } = pathOf(nodeIds, [20, 960, 20]);
    const entries = entriesFor(nodeIds, [null, shadow("tiles", 0.8), null]);

    const p = summarizeShadowSource(nodeIds, entries, distanceFor);

    expect(p.bySource.none).toBeCloseTo(0.04, 5);
    expect(p.sampledFraction).toBeCloseTo(0.96, 5);
    expect(p.minConfidence).toBe(0.8);
  });

  it("reports nothing sampled as full confidence rather than none", () => {
    const { nodeIds, distanceFor } = pathOf([-1, -2]);

    const p = summarizeShadowSource(nodeIds, new Map(), distanceFor);

    expect(p.sampledFraction).toBe(0);
    expect(p.minConfidence).toBe(1);
    expect(describeShadowProvenance(p)).toBe("source unknown");
  });

  it("has nothing to say about a path with no edges", () => {
    const p = summarizeShadowSource([7], new Map(), () => 100);

    expect(p.dominant).toBe("none");
    expect(p.bySource).toEqual({});
  });
});

describe("describeShadowProvenance", () => {
  const { nodeIds, distanceFor } = pathOf([1, 2, 3, 4]);
  const summarize = (samples: Array<EdgeShadowSource | null>) =>
    describeShadowProvenance(
      summarizeShadowSource(nodeIds, entriesFor(nodeIds, samples), distanceFor)
    );

  it("names geometry for either geometric provider", () => {
    expect(summarize([shadow("tiles"), shadow("tiles"), shadow("tiles")])).toBe(
      "from building geometry"
    );
    expect(summarize([shadow("overpass"), shadow("overpass"), shadow("overpass")])).toBe(
      "from building geometry"
    );
    expect(summarize([shadow("nyc-static"), shadow("nyc-static"), shadow("nyc-static")])).toBe(
      "from building geometry"
    );
  });

  it("names canopy when A7 blended it in, rather than falling through to unknown", () => {
    // `mixed` and `canopy` are what the field emits once a canopy source has geometry
    // for the area. Left unnamed they would have landed on "source unknown", which
    // would have made every tree-lined route read as unsourced.
    expect(summarize([shadow("mixed"), shadow("mixed"), shadow("mixed")])).toBe(
      "from building geometry and tree canopy"
    );
    expect(summarize([shadow("canopy"), shadow("canopy"), shadow("canopy")])).toBe(
      "from tree canopy"
    );
  });

  it("names the map view when the pixel sampler answered", () => {
    expect(summarize([shadow("canvas"), shadow("canvas"), shadow("canvas")])).toBe(
      "from the map view"
    );
  });

  it("says the sun is down rather than claiming a missing source", () => {
    // After sunset the field reports source "none" with full confidence for every
    // edge. That is an answer, not a gap, and must not read as one.
    expect(summarize([shadow("none", 1), shadow("none", 1), shadow("none", 1)])).toBe(
      "sun is below the horizon"
    );
  });

  it("appends the caveat when any sampled edge was weak", () => {
    expect(summarize([shadow("tiles", 0.8), shadow("tiles", 0.2), shadow("tiles", 0.8)])).toBe(
      "from building geometry · low confidence"
    );
  });

  it("does not append the caveat to a mixed route whose edges were all decent", () => {
    // Mixed sources is a statement about provenance, not about doubt: every edge
    // here cleared LOW_CONFIDENCE, so nothing should suggest the number is shaky.
    expect(summarize([shadow("tiles", 0.8), shadow("canvas", 0.6), shadow("tiles", 0.8)])).toBe(
      "mixed sources"
    );
  });
});
