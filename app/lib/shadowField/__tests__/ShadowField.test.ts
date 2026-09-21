import SunCalc from "suncalc";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOW_CONFIDENCE,
  type BBox,
  type CanopyProvider,
  type CanopyRasterProvider,
  type EdgeRef,
  type PrismProvider,
  bboxAroundEdges,
  bboxAroundPoint,
  bboxContains,
  confidenceFor,
  edgeSampleCount,
  createGeometryShadowField,
  QUERY_PAD_M,
  sidewalkOffsets,
  staticCanopyProvider,
  staticPrismProvider,
} from "../ShadowField";
import type { CanopyHeightField } from "../canopyRasterField";
import { type PrismSet, metersPerDegree } from "../geometry";

// ─── A scene with a known sun ─────────────────────────────────────────────────

const LAT = 40.4168;
const LNG = -3.7038;
const { mPerLat, mPerLng } = metersPerDegree(LAT);

/** Midday over Madrid — high sun, short shadows, nothing near the horizon. */
const NOON = new Date("2026-06-21T12:00:00Z");
/** Well after sunset in Madrid on the same day. */
const NIGHT = new Date("2026-06-21T23:30:00Z");

const sun = SunCalc.getPosition(NOON, LAT, LNG);

/**
 * The direction a shadow travels, as a unit vector in metres (east, north).
 * `buildShadowTriangles` shifts a footprint by `(sin az, cos az) × length`, so this
 * is where the shadow lands — which is what makes the expectations below hand-computable.
 */
const SHADOW_DIR: [number, number] = [Math.sin(sun.azimuth), Math.cos(sun.azimuth)];

/** A point `d` metres from the scene origin along the shadow direction. */
function alongShadow(d: number): [number, number] {
  return [LNG + (SHADOW_DIR[0] * d) / mPerLng, LAT + (SHADOW_DIR[1] * d) / mPerLat];
}

/** A point `d` metres from the scene origin across the shadow direction. */
function acrossShadow(d: number): [number, number] {
  return [LNG - (SHADOW_DIR[1] * d) / mPerLng, LAT + (SHADOW_DIR[0] * d) / mPerLat];
}

const HALF_M = 20;
/** Height chosen so the shadow is exactly 40 m long at this sun altitude. */
const SHADOW_LENGTH_M = 40;
const HEIGHT_M = SHADOW_LENGTH_M * Math.tan(sun.altitude);

/** One square building, 40 m on a side, centred on the scene origin. */
function oneBuilding(): PrismSet {
  const dLat = HALF_M / mPerLat;
  const dLng = HALF_M / mPerLng;
  return {
    prisms: [
      {
        heightM: HEIGHT_M,
        ring: [
          [LNG - dLng, LAT - dLat],
          [LNG + dLng, LAT - dLat],
          [LNG + dLng, LAT + dLat],
          [LNG - dLng, LAT + dLat],
          [LNG - dLng, LAT - dLat],
        ],
      },
    ],
    maxHeightM: HEIGHT_M,
  };
}

const WIDE_COVERAGE: BBox = bboxAroundPoint(LNG, LAT, 5000);

function fieldOverOneBuilding(source: PrismProvider["source"] = "tiles") {
  return createGeometryShadowField([staticPrismProvider(oneBuilding(), WIDE_COVERAGE, source)]);
}

// ─── shadowAt ──────────────────────────────────────────────────────────────────

describe("shadowAt", () => {
  it("shadows a point inside the building's cast shadow", () => {
    const field = fieldOverOneBuilding();
    const [lng, lat] = alongShadow(35); // past the 20 m footprint, inside the 40 m shadow

    const sample = field.shadowAt(lng, lat, NOON);

    expect(sample.shadow).toBe(1);
    expect(sample.source).toBe("tiles");
    expect(sample.confidence).toBeGreaterThan(LOW_CONFIDENCE);
  });

  it("leaves a point beyond the shadow's end in full sun, and stays confident about it", () => {
    const field = fieldOverOneBuilding();
    const [lng, lat] = alongShadow(HALF_M + SHADOW_LENGTH_M + 40);

    const sample = field.shadowAt(lng, lat, NOON);

    expect(sample.shadow).toBe(0);
    // "The sun reaches here" is a real answer once buildings are loaded — it must
    // not read as a doubt, or A4 would fall back to the canvas on every sunlit edge.
    expect(sample.confidence).toBeGreaterThan(LOW_CONFIDENCE);
  });

  it("leaves the sun-facing side in full sun", () => {
    const field = fieldOverOneBuilding();
    const [lng, lat] = alongShadow(-35);

    expect(field.shadowAt(lng, lat, NOON).shadow).toBe(0);
  });

  it("leaves a point beside the shadow in full sun", () => {
    const field = fieldOverOneBuilding();
    const [lng, lat] = acrossShadow(60);

    expect(field.shadowAt(lng, lat, NOON).shadow).toBe(0);
  });

  it("reports partial shadow at the shadow's edge, not a hard 0 or 1", () => {
    const field = fieldOverOneBuilding();
    // The 5-offset probe straddles the shadow's end (footprint edge + 40 m).
    const [lng, lat] = alongShadow(HALF_M + SHADOW_LENGTH_M);

    const shadow = field.shadowAt(lng, lat, NOON).shadow;

    expect(shadow).toBeGreaterThan(0);
    expect(shadow).toBeLessThan(1);
  });

  it("reports full, confident shadow everywhere once the sun is down", () => {
    const field = fieldOverOneBuilding();
    const far = field.shadowAt(LNG + 3, LAT + 2, NIGHT);

    expect(far).toEqual({ shadow: 1, source: "none", confidence: 1 });
    expect(field.shadowAt(...alongShadow(35), NIGHT).shadow).toBe(1);
  });

  it("asks the caller to fall back when no source covers the point", () => {
    const narrow = bboxAroundPoint(LNG, LAT, 10); // far too small to contain the query bbox
    const field = createGeometryShadowField([
      staticPrismProvider(oneBuilding(), narrow, "tiles"),
    ]);

    const sample = field.shadowAt(...alongShadow(35), NOON);

    expect(sample).toEqual({ shadow: 0, source: "none", confidence: 0 });
    expect(sample.confidence).toBeLessThan(LOW_CONFIDENCE);
  });

  it("takes the first provider that can speak for the area", () => {
    const empty: PrismSet = { prisms: [], maxHeightM: 1 };
    const field = createGeometryShadowField([
      staticPrismProvider(empty, bboxAroundPoint(LNG, LAT, 10), "tiles"), // cannot cover
      staticPrismProvider(oneBuilding(), WIDE_COVERAGE, "overpass"),
    ]);

    const sample = field.shadowAt(...alongShadow(35), NOON);

    expect(sample.source).toBe("overpass");
    expect(sample.shadow).toBe(1);
  });

  it("hedges when a covering source has no building near the point", () => {
    const empty: PrismSet = { prisms: [], maxHeightM: 1 };
    const field = createGeometryShadowField([
      staticPrismProvider(empty, WIDE_COVERAGE, "tiles"),
    ]);

    const sample = field.shadowAt(LNG, LAT, NOON);

    // Full sun is the honest reading of the geometry, but an empty plaza and an
    // unloaded neighbourhood look identical, so this must not read as certain.
    expect(sample.shadow).toBe(0);
    expect(sample.source).toBe("tiles");
    expect(sample.confidence).toBeLessThan(LOW_CONFIDENCE);
  });
});

// ─── sampleEdges ──────────────────────────────────────────────────────────────

describe("sampleEdges", () => {
  const field = fieldOverOneBuilding();

  it("reports a fully shadowed edge as 1 on both sidewalks", () => {
    const edge: EdgeRef = { from: alongShadow(28), to: alongShadow(50) };

    const [shadow] = field.sampleEdges([edge], NOON);

    expect(shadow.left).toBe(1);
    expect(shadow.right).toBe(1);
    expect(shadow.source).toBe("tiles");
    expect(shadow.buildingSource).toBe("tiles");
    expect(shadow.canopySources).toEqual({ osm: false, raster: false });
  });

  it("reports a fully sunlit edge as 0 on both sidewalks", () => {
    const edge: EdgeRef = { from: acrossShadow(120), to: acrossShadow(200) };

    const [shadow] = field.sampleEdges([edge], NOON);

    expect(shadow.left).toBe(0);
    expect(shadow.right).toBe(0);
  });

  it("reports about half for an edge that runs out of the shadow", () => {
    // Starts just past the footprint, ends as far beyond the shadow's end as it
    // started inside it — so half the samples land in shadow.
    const shadowEnd = HALF_M + SHADOW_LENGTH_M;
    const edge: EdgeRef = { from: alongShadow(HALF_M + 2), to: alongShadow(2 * shadowEnd - HALF_M - 2) };

    const [shadow] = field.sampleEdges([edge], NOON);

    expect(shadow.left).toBeGreaterThan(0.3);
    expect(shadow.left).toBeLessThan(0.7);
  });

  it("distinguishes the two sidewalks of a street running along the shadow's edge", () => {
    // The edge runs across the shadow direction, offset so one sidewalk sits in
    // shadow and the other in sun. This left/right split is the product asset —
    // Track B's "cross to the shadowed side" cue reads exactly this.
    const shadowEnd = HALF_M + SHADOW_LENGTH_M;
    const centre = alongShadow(shadowEnd);
    const across = acrossShadow(30);
    const delta: [number, number] = [across[0] - LNG, across[1] - LAT];
    const edge: EdgeRef = {
      from: [centre[0] - delta[0], centre[1] - delta[1]],
      to: [centre[0] + delta[0], centre[1] + delta[1]],
    };

    const [shadow] = field.sampleEdges([edge], NOON);

    expect(shadow.left).not.toBe(shadow.right);
  });

  it("reports both sidewalks fully shadowed at night", () => {
    const edge: EdgeRef = { from: alongShadow(28), to: alongShadow(50) };

    const [shadow] = field.sampleEdges([edge], NIGHT);

    expect(shadow).toEqual({ left: 1, right: 1, source: "none", confidence: 1 });
  });

  it("returns one result per edge, in order", () => {
    const edges: EdgeRef[] = [
      { from: alongShadow(28), to: alongShadow(50) },
      { from: acrossShadow(120), to: acrossShadow(200) },
    ];

    const result = field.sampleEdges(edges, NOON);

    expect(result).toHaveLength(2);
    expect(result[0].left).toBe(1);
    expect(result[1].left).toBe(0);
  });

  it("samples long edges more densely, matching what useNavigation asks the pixel path for", () => {
    // useNavigation calls sampleBothSidewalks with max(3, ceil(distanceM / 25)); a fixed
    // count here would make A3's disagreement number measure sampling density, not shadow.
    expect(edgeSampleCount(10)).toBe(3);
    expect(edgeSampleCount(75)).toBe(3);
    expect(edgeSampleCount(200)).toBe(8);
    expect(edgeSampleCount(1000)).toBe(40);
  });

  it("samples the sidewalk line itself, without smearing a neighbourhood across it", () => {
    // shadowAt softens a point query over a ±4 m neighbourhood, which is right for
    // "is this terrace shadowed?". Doing the same per edge sample would displace each
    // sidewalk a second time, across the street it belongs to — A3's harness caught
    // exactly that, as a 60pp disagreement on a Madrid street.
    const justOutside = alongShadow(HALF_M + SHADOW_LENGTH_M + 2);

    const point = field.shadowAt(...justOutside, NOON);
    const [edge] = field.sampleEdges([{ from: justOutside, to: justOutside }], NOON);

    expect(point.shadow).toBeGreaterThan(0); // neighbourhood reaches back into shadow
    expect(edge.left).toBe(0); // the point itself is in sun
    expect(edge.right).toBe(0);
  });

  it("handles an empty edge list", () => {
    expect(field.sampleEdges([], NOON)).toEqual([]);
  });

  it("survives a zero-length edge", () => {
    const point = alongShadow(35);
    const [shadow] = field.sampleEdges([{ from: point, to: point }], NOON);

    expect(shadow.left).toBe(1);
    expect(shadow.right).toBe(1);
  });
});

// ─── sweep ────────────────────────────────────────────────────────────────────

describe("sweep", () => {
  it("matches N separate sampleEdges calls exactly", () => {
    const field = fieldOverOneBuilding();
    const edges: EdgeRef[] = [
      { from: alongShadow(28), to: alongShadow(50) },
      { from: acrossShadow(60), to: acrossShadow(120) },
    ];
    const times = [
      new Date("2026-06-21T08:00:00Z"),
      new Date("2026-06-21T12:00:00Z"),
      new Date("2026-06-21T17:00:00Z"),
      new Date("2026-06-21T23:30:00Z"),
    ];

    const swept = field.sweep(edges, times);

    expect(swept).toHaveLength(times.length);
    times.forEach((when, i) => {
      expect(swept[i]).toEqual(field.sampleEdges(edges, when));
    });
  });

  it("returns one empty row per time for no edges", () => {
    const field = fieldOverOneBuilding();

    expect(field.sweep([], [NOON, NIGHT])).toEqual([[], []]);
  });

  /**
   * The one-building case above cannot see what A6 actually changed. The sweep now
   * shares a caster preparation, a sun-cell partition and a footprint grid across
   * every hour, and none of those three exists unless the batch spans more than one
   * `SUN_CELL_M` cell and the prism set clears `GRID_MIN_CASTERS`. This corpus does
   * both: 100 buildings under a 6 km route that crosses several cells, swept across
   * a full day including the hours either side of sunrise and sunset.
   *
   * **What this cannot catch, deliberately.** Both sides now run the same `planBatch` and
   * the same prepared casters, so this is self-consistency: it pins A6's acceptance
   * criterion — *"results match N individual `sampleEdges` calls exactly"* — and nothing
   * else. Change the sun-cell size and both sides move together and this still passes.
   * What anchors the numbers to what `main` produced is the frozen pre-index reference in
   * `shadowIndex.test.ts`, not this.
   */
  it("still matches sampleEdges exactly across many cells, buildings and hours", () => {
    const prisms: PrismSet = { prisms: [], maxHeightM: 90 };
    for (let i = 0; i < 100; i++) {
      const eastM = (i % 10) * 600 + 40;
      const northM = Math.floor(i / 10) * 90;
      const w = eastM / mPerLng;
      const sth = northM / mPerLat;
      const e = (eastM + 45) / mPerLng;
      const n = (northM + 45) / mPerLat;
      prisms.prisms.push({
        heightM: 12 + ((i * 17) % 78),
        ring: [
          [LNG + w, LAT + sth],
          [LNG + e, LAT + sth],
          [LNG + e, LAT + n],
          [LNG + w, LAT + n],
          [LNG + w, LAT + sth],
        ],
      });
    }

    const edges: EdgeRef[] = [];
    for (let i = 0; i < 60; i++) {
      const eastM = i * 100;
      edges.push({
        from: [LNG + eastM / mPerLng, LAT + ((i % 3) * 30) / mPerLat],
        to: [LNG + (eastM + 100) / mPerLng, LAT + (((i + 1) % 3) * 30) / mPerLat],
      });
    }

    const coverage = bboxAroundEdges(edges, 5000);
    if (!coverage) throw new Error("no edges");
    const field = createGeometryShadowField([staticPrismProvider(prisms, coverage, "tiles")]);

    const times: Date[] = [];
    for (let hour = 3; hour <= 21; hour++) {
      times.push(new Date(Date.UTC(2026, 5, 21, hour, 20, 0)));
    }

    const swept = field.sweep(edges, times);

    // Guard against a vacuous pass: the corpus has to produce partial shadow, not a
    // day of all-sun or all-night rows that would agree for the wrong reason.
    const shadows = swept.flat().flatMap((edge) => [edge.left, edge.right]);
    expect(shadows.some((value) => value > 0 && value < 1)).toBe(true);

    times.forEach((when, i) => {
      expect(swept[i]).toEqual(field.sampleEdges(edges, when));
    });
  });
});

// ─── ready ────────────────────────────────────────────────────────────────────

describe("ready", () => {
  it("loads every provider that offers a preload", async () => {
    const loaded: BBox[] = [];
    const provider: PrismProvider = {
      source: "overpass",
      prismsFor: () => null,
      load: async (bbox) => {
        loaded.push(bbox);
      },
    };
    const withoutLoad: PrismProvider = { source: "tiles", prismsFor: () => null };

    await createGeometryShadowField([provider, withoutLoad]).ready(WIDE_COVERAGE);

    expect(loaded).toEqual([WIDE_COVERAGE]);
  });

  describe("cancellation and absolute deadlines", () => {
    afterEach(() => vi.useRealTimers());

    it("shares one absolute budget and starts no cell work after it expires", async () => {
      vi.useFakeTimers();
      const signals: AbortSignal[] = [];
      const load = vi.fn(
        async (_bbox: BBox, signal?: AbortSignal) =>
          new Promise<void>((resolve) => {
            if (signal) signals.push(signal);
            signal?.addEventListener("abort", () => resolve(), { once: true });
          }),
      );
      const provider: PrismProvider = {
        source: "overpass",
        prismsFor: () => null,
        load,
      };
      const field = createGeometryShadowField([provider]);
      const deadlineAt = Date.now() + 25;
      const options = { deadlineAt };

      const broad = field.ready(WIDE_COVERAGE, options);
      await vi.advanceTimersByTimeAsync(25);
      await broad;
      await field.readyEdges([
        { from: [LNG, LAT], to: [LNG + 0.001, LAT] },
      ], options);

      expect(load).toHaveBeenCalledTimes(1);
      expect(signals[0].aborted).toBe(true);
      expect(Date.now()).toBe(deadlineAt);
    });

    it("drops serialized Overpass work that expires while queued", async () => {
      vi.useFakeTimers();
      let finishFirst = () => {};
      const firstGate = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      const load = vi.fn(async () => firstGate);
      const provider: PrismProvider = {
        source: "overpass",
        prismsFor: () => null,
        load,
      };
      const field = createGeometryShadowField([provider]);

      const first = field.ready(WIDE_COVERAGE, {
        deadlineAt: Date.now() + 1000,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(load).toHaveBeenCalledTimes(1);

      const queued = field.readyEdges([
        { from: [LNG, LAT], to: [LNG + 0.001, LAT] },
      ], { deadlineAt: Date.now() + 10 });
      await vi.advanceTimersByTimeAsync(10);
      await queued;

      finishFirst();
      await first;
      await Promise.resolve();
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("lets raster work outlive readiness but keeps the route cancellation signal", async () => {
      vi.useFakeTimers();
      let rasterSignal: AbortSignal | undefined;
      const raster: CanopyRasterProvider = {
        source: "canopy-raster",
        fieldFor: () => null,
        load: async (_bbox, signal) => {
          rasterSignal = signal;
          return new Promise<void>(() => {});
        },
      };
      const route = new AbortController();
      const field = createGeometryShadowField([], [], [raster]);
      const ready = field.ready(WIDE_COVERAGE, {
        signal: route.signal,
        deadlineAt: Date.now() + 10,
      });

      await vi.advanceTimersByTimeAsync(10);
      await ready;
      expect(rasterSignal).toBe(route.signal);
      expect(rasterSignal?.aborted).toBe(false);

      route.abort();
      expect(rasterSignal?.aborted).toBe(true);
    });
  });
});

// ─── readiness cache (A2) ─────────────────────────────────────────────────────

describe("readiness cache", () => {
  // A provider that resolves nothing and counts what it was asked to preload.
  function countingProvider(loaded: BBox[], pendingSignals?: AbortSignal[]) {
    const provider: PrismProvider = {
      source: "overpass",
      prismsFor: () => null,
      load: async (bbox, signal) => {
        loaded.push(bbox);
        if (!pendingSignals) return;
        await new Promise<void>((resolve) => {
          if (signal) pendingSignals.push(signal);
          signal?.addEventListener("abort", () => resolve(), { once: true });
          if (signal?.aborted) resolve();
        });
      },
    };
    return provider;
  }

  it("returns a cached answer for a bbox `ready()` already resolved", async () => {
    const loaded: BBox[] = [];
    const field = createGeometryShadowField([countingProvider(loaded)]);

    await field.ready(WIDE_COVERAGE);
    await field.ready(WIDE_COVERAGE);

    expect(loaded).toEqual([WIDE_COVERAGE]);
  });

  it("still loads a different bbox whose readiness was never resolved", async () => {
    const elsewhere = bboxAroundPoint(LNG + 0.02, LAT, 500);
    const loaded: BBox[] = [];
    const field = createGeometryShadowField([countingProvider(loaded)]);

    await field.ready(WIDE_COVERAGE);
    await field.ready(elsewhere);

    expect(loaded).toEqual([WIDE_COVERAGE, elsewhere]);
  });

  it("re-resolves the same bbox under a different generation", async () => {
    let generation: string | null = "nyc-2026-09-18-aaaaaaaaaaaa";
    const loaded: BBox[] = [];
    const field = createGeometryShadowField([countingProvider(loaded)], [], [], {
      generationOf: () => generation,
    });

    await field.ready(WIDE_COVERAGE);
    await field.ready(WIDE_COVERAGE);
    generation = "nyc-2026-09-19-bbbbbbbbbbbb";
    await field.ready(WIDE_COVERAGE);

    expect(loaded).toEqual([WIDE_COVERAGE, WIDE_COVERAGE]);
  });

  it("reuses per-cell readiness for the same edges, and only loads new cells", async () => {
    const loaded: BBox[] = [];
    const field = createGeometryShadowField([countingProvider(loaded)]);
    // Two cells, 0.1° apart (the file's edge-cell coverage fixture).
    const near: EdgeRef = {
      from: [LNG - 10 / mPerLng, LAT],
      to: [LNG + 10 / mPerLng, LAT],
    };
    const far: EdgeRef = {
      from: [LNG + 0.1 - 10 / mPerLng, LAT],
      to: [LNG + 0.1 + 10 / mPerLng, LAT],
    };
    // A third cell further along the grid line.
    const third: EdgeRef = {
      from: [LNG + 0.2 - 10 / mPerLng, LAT],
      to: [LNG + 0.2 + 10 / mPerLng, LAT],
    };

    await field.readyEdges([near, far]);
    await field.readyEdges([near, far]);
    expect(loaded).toHaveLength(2);

    await field.readyEdges([near, far, third]);
    expect(loaded).toHaveLength(3);
  });

  it("does not cache readiness the deadline cut short", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const loaded: BBox[] = [];
      const field = createGeometryShadowField([countingProvider(loaded, signals)]);

      const aborted = field.ready(WIDE_COVERAGE, { deadlineAt: Date.now() + 25 });
      await vi.advanceTimersByTimeAsync(25);
      await aborted;
      expect(loaded).toHaveLength(1);

      // A fresh pass over the same bbox gets a fresh load: the aborted pass
      // recorded nothing.
      const retry = field.ready(WIDE_COVERAGE, { deadlineAt: Date.now() + 25 });
      await vi.advanceTimersByTimeAsync(25);
      await retry;
      expect(loaded).toHaveLength(2);
      expect(signals.every((s) => s.aborted)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── coverage ─────────────────────────────────────────────────────────────────

describe("coverage", () => {
  const area = bboxAroundPoint(LNG, LAT, 200);

  it("reports the source that would answer, without building any geometry", () => {
    const result = fieldOverOneBuilding().coverage(area, NOON);

    expect(result.source).toBe("tiles");
    expect(result.confidence).toBe(confidenceFor("tiles", sun.altitude, 1));
  });

  it("agrees with what sampleEdges then reports for the same area and time", () => {
    const field = fieldOverOneBuilding();
    const edge: EdgeRef = { from: acrossShadow(-50), to: acrossShadow(50) };

    const promised = field.coverage(bboxAroundEdges([edge], QUERY_PAD_M)!, NOON);
    const delivered = field.sampleEdges([edge], NOON)[0];

    expect(promised.source).toBe(delivered.source);
    expect(promised.confidence).toBe(delivered.confidence);
  });

  it("reports no confidence at all when no provider covers the area", () => {
    const elsewhere = bboxAroundPoint(LNG + 40, LAT, 200);

    expect(fieldOverOneBuilding().coverage(elsewhere, NOON)).toEqual({
      source: "none",
      confidence: 0,
    });
  });

  it("is fully confident after sunset, when no geometry is needed to answer", () => {
    // Not the same "none" as an uncovered area: the sun being down is an
    // astronomical certainty, and a caller must not fall back on it.
    expect(fieldOverOneBuilding().coverage(area, NIGHT)).toEqual({
      source: "none",
      confidence: 1,
    });
  });

  it("docks a source whose geometry is only partly there", () => {
    // A provider that answers with a decimated set is the failure this guards: it
    // has buildings, so the no-geometry factor says nothing, and without the
    // completeness multiplier the field would route on it at the full tile prior.
    const partial = {
      ...staticPrismProvider(oneBuilding(), WIDE_COVERAGE, "tiles"),
      completeness: () => 0.5,
    };
    const result = createGeometryShadowField([partial]).coverage(area, NOON);

    expect(result.source).toBe("tiles");
    expect(result.confidence).toBeLessThan(LOW_CONFIDENCE);
  });

  it("docks a source that covers the area but holds no buildings", () => {
    const empty = staticPrismProvider({ prisms: [], maxHeightM: 0 }, WIDE_COVERAGE, "overpass");
    const result = createGeometryShadowField([empty]).coverage(area, NOON);

    expect(result.source).toBe("overpass");
    expect(result.confidence).toBeLessThan(LOW_CONFIDENCE);
  });
});

describe("edge-cell readiness and coverage", () => {
  const near: EdgeRef = {
    from: [LNG - 10 / mPerLng, LAT],
    to: [LNG + 10 / mPerLng, LAT],
  };
  const far: EdgeRef = {
    from: [LNG + 0.1 - 10 / mPerLng, LAT],
    to: [LNG + 0.1 + 10 / mPerLng, LAT],
  };

  it("returns the same minimum confidence the per-cell samples later deliver", () => {
    const provider: PrismProvider = {
      source: "tiles",
      prismsFor: (bbox) => ((bbox.west + bbox.east) / 2 < LNG + 0.05 ? oneBuilding() : null),
    };
    const field = createGeometryShadowField([provider]);
    const samples = field.sampleEdges([near, far], NOON);
    expect(field.coverageEdges([near, far], NOON).confidence).toBe(
      Math.min(...samples.map((sample) => sample.confidence)),
    );
  });

  it("loads each padded cell rather than one route-wide rectangle", async () => {
    const loaded: BBox[] = [];
    const provider: PrismProvider = {
      source: "overpass",
      prismsFor: () => null,
      load: async (bbox) => {
        loaded.push(bbox);
      },
    };
    await createGeometryShadowField([provider]).readyEdges([near, far]);
    expect(loaded).toHaveLength(2);
    expect(loaded.every((bbox) => bboxRadiusForTest(bbox) < 1000)).toBe(true);
  });
});

function bboxRadiusForTest(bbox: BBox): number {
  const scale = metersPerDegree((bbox.south + bbox.north) / 2);
  return Math.hypot(
    ((bbox.east - bbox.west) * scale.mPerLng) / 2,
    ((bbox.north - bbox.south) * scale.mPerLat) / 2,
  );
}

// ─── Confidence ───────────────────────────────────────────────────────────────

describe("confidenceFor", () => {
  const HIGH_SUN = Math.PI / 4;

  it("trusts tiles more than Overpass", () => {
    expect(confidenceFor("tiles", HIGH_SUN, 3)).toBeGreaterThan(
      confidenceFor("overpass", HIGH_SUN, 3)
    );
  });

  it("places the static snapshot between tiles and Overpass", () => {
    // The documented prior: verified bytes and pinned heights beat live OSM,
    // but an explicit unknown-height fraction keeps it below per-building
    // render heights.
    expect(confidenceFor("nyc-static", HIGH_SUN, 3)).toBeLessThan(
      confidenceFor("tiles", HIGH_SUN, 3)
    );
    expect(confidenceFor("nyc-static", HIGH_SUN, 3)).toBeGreaterThan(
      confidenceFor("overpass", HIGH_SUN, 3)
    );
  });

  it("docks confidence when the covering source holds no buildings", () => {
    expect(confidenceFor("tiles", HIGH_SUN, 0)).toBeLessThan(confidenceFor("tiles", HIGH_SUN, 1));
    expect(confidenceFor("tiles", HIGH_SUN, 0)).toBeLessThan(LOW_CONFIDENCE);
  });

  it("does not dock for a point that merely sits outside every shadow", () => {
    // The count is "buildings this source knows about", not "buildings in reach".
    // Keying it off reach would push almost every sunlit sample to the fallback path.
    expect(confidenceFor("tiles", HIGH_SUN, 40)).toBe(confidenceFor("tiles", HIGH_SUN, 1));
  });

  it("falls off as the sun approaches the horizon", () => {
    const noon = confidenceFor("tiles", HIGH_SUN, 5);
    const lateAfternoon = confidenceFor("tiles", (5 * Math.PI) / 180, 5);
    const sunset = confidenceFor("tiles", 0.0001, 5);

    expect(lateAfternoon).toBeLessThan(noon);
    expect(sunset).toBeLessThan(lateAfternoon);
  });

  it("stops penalising once the sun is comfortably up", () => {
    expect(confidenceFor("tiles", (10 * Math.PI) / 180, 5)).toBe(
      confidenceFor("tiles", Math.PI / 3, 5)
    );
  });

  it("never leaves the 0–1 range", () => {
    for (const altitude of [0.0001, 0.05, 0.2, 1.4]) {
      for (const inReach of [0, 12]) {
        for (const source of ["tiles", "overpass", "nyc-static"] as const) {
          const c = confidenceFor(source, altitude, inReach);
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

// ─── Geometry helpers ─────────────────────────────────────────────────────────

describe("sidewalkOffsets", () => {
  it("offsets 4 m perpendicular to the edge, one side each way", () => {
    const edge: EdgeRef = { from: [LNG, LAT], to: [LNG + 0.01, LAT] }; // due east
    const { left, right } = sidewalkOffsets(edge);

    expect(left[0]).toBeCloseTo(0, 12);
    expect(left[1] * mPerLat).toBeCloseTo(4, 1);
    expect(right[0]).toBeCloseTo(-left[0], 12);
    expect(right[1]).toBeCloseTo(-left[1], 12);
  });

  it("collapses to no offset for a zero-length edge", () => {
    const point: [number, number] = [LNG, LAT];

    expect(sidewalkOffsets({ from: point, to: point })).toEqual({ left: [0, 0], right: [0, 0] });
  });
});

describe("bbox helpers", () => {
  it("pads a point bbox by the requested metres", () => {
    const bbox = bboxAroundPoint(LNG, LAT, 100);

    expect((bbox.north - LAT) * mPerLat).toBeCloseTo(100, 6);
    expect((bbox.east - LNG) * mPerLng).toBeCloseTo(100, 6);
  });

  it("covers every edge endpoint plus padding", () => {
    const edges: EdgeRef[] = [
      { from: [LNG, LAT], to: [LNG + 0.01, LAT + 0.01] },
      { from: [LNG - 0.02, LAT - 0.005], to: [LNG, LAT] },
    ];

    const bbox = bboxAroundEdges(edges, 50);

    expect(bbox).not.toBeNull();
    expect(bbox?.west).toBeLessThan(LNG - 0.02);
    expect(bbox?.east).toBeGreaterThan(LNG + 0.01);
    expect(bbox?.south).toBeLessThan(LAT - 0.005);
    expect(bbox?.north).toBeGreaterThan(LAT + 0.01);
  });

  it("has no bbox for no edges", () => {
    expect(bboxAroundEdges([], 50)).toBeNull();
  });

  it("only contains a bbox it fully encloses", () => {
    const outer = bboxAroundPoint(LNG, LAT, 500);

    expect(bboxContains(outer, bboxAroundPoint(LNG, LAT, 100))).toBe(true);
    expect(bboxContains(outer, bboxAroundPoint(LNG, LAT, 900))).toBe(false);
    expect(bboxContains(outer, bboxAroundPoint(LNG + 0.02, LAT, 100))).toBe(false);
  });
});

// ─── Canopy (A7) ──────────────────────────────────────────────────────────────

describe("canopy", () => {
  /** Far enough across the shadow direction that no building shadow reaches it. */
  const GROVE = acrossShadow(300);
  const CANOPY_OPACITY = 0.9;

  /** A 60 m square of crown, 9 m tall on a 3 m trunk — one patch, hand-sized. */
  function canopyPatch(opacity = CANOPY_OPACITY): PrismSet {
    const half = 30;
    const dLat = half / mPerLat;
    const dLng = half / mPerLng;
    return {
      prisms: [
        {
          heightM: 9,
          baseM: 3,
          opacity,
          ring: [
            [GROVE[0] - dLng, GROVE[1] - dLat],
            [GROVE[0] + dLng, GROVE[1] - dLat],
            [GROVE[0] + dLng, GROVE[1] + dLat],
            [GROVE[0] - dLng, GROVE[1] + dLat],
            [GROVE[0] - dLng, GROVE[1] - dLat],
          ],
        },
      ],
      maxHeightM: 9,
    };
  }

  /** A 20 m edge through the middle of the grove, across the shadow direction. */
  const underGrove: EdgeRef = {
    from: [GROVE[0] - 10 / mPerLng, GROVE[1]],
    to: [GROVE[0] + 10 / mPerLng, GROVE[1]],
  };

  const tiles = () => staticPrismProvider(oneBuilding(), WIDE_COVERAGE, "tiles");
  const canopy = (set = canopyPatch()) => staticCanopyProvider(set, WIDE_COVERAGE);

  it("reports canopy shadow where buildings report none", () => {
    const without = createGeometryShadowField([tiles()]).sampleEdges([underGrove], NOON)[0];
    const with_ = createGeometryShadowField([tiles()], [canopy()]).sampleEdges(
      [underGrove], NOON
    )[0];

    expect(without.left).toBe(0);
    expect(without.right).toBe(0);
    expect(with_.left).toBeGreaterThan(0.5);
    expect(with_.right).toBeGreaterThan(0.5);
  });

  it("reports the crown's opacity, not full shadow", () => {
    // The whole reason `shadow` is a fraction rather than a boolean. A crown that read
    // 1 here would let routing price a plane tree exactly like a tower.
    const [edge] = createGeometryShadowField([tiles()], [canopy()]).sampleEdges(
      [underGrove], NOON
    );
    expect(edge.left).toBeCloseTo(CANOPY_OPACITY, 10);
    expect(edge.left).toBeLessThan(1);
  });

  it("lets an opaque building win outright where the two overlap", () => {
    // A crown standing over a building's shadow cannot make the ground darker than 1.
    const inBuildingShadow: EdgeRef = {
      from: alongShadow(25),
      to: alongShadow(35),
    };
    const overEverything: PrismSet = {
      prisms: [
        {
          heightM: 9,
          baseM: 3,
          opacity: CANOPY_OPACITY,
          ring: [
            [LNG - 0.01, LAT - 0.01],
            [LNG + 0.01, LAT - 0.01],
            [LNG + 0.01, LAT + 0.01],
            [LNG - 0.01, LAT + 0.01],
            [LNG - 0.01, LAT - 0.01],
          ],
        },
      ],
      maxHeightM: 9,
    };
    const [edge] = createGeometryShadowField(
      [tiles()], [staticCanopyProvider(overEverything, WIDE_COVERAGE)]
    ).sampleEdges([inBuildingShadow], NOON);
    expect(edge.left).toBe(1);
  });

  it("labels the answer mixed, and docks it for resting on a crown model", () => {
    const buildingsOnly = createGeometryShadowField([tiles()]).sampleEdges([underGrove], NOON)[0];
    const [edge] = createGeometryShadowField([tiles()], [canopy()]).sampleEdges(
      [underGrove], NOON
    );

    expect(buildingsOnly.source).toBe("tiles");
    expect(edge.source).toBe("mixed");
    expect(edge.buildingSource).toBe("tiles");
    expect(edge.canopySources).toEqual({ osm: true, raster: false });
    expect(edge.confidence).toBeLessThan(buildingsOnly.confidence);
    // Still worth routing on: more information, not less.
    expect(edge.confidence).toBeGreaterThan(LOW_CONFIDENCE);
  });

  it("answers from canopy alone below LOW_CONFIDENCE when no building source can", () => {
    // A tree layer knows nothing about the tower across the street, so an answer
    // resting on it alone is a request to fall back rather than a routing input.
    const [edge] = createGeometryShadowField([], [canopy()]).sampleEdges([underGrove], NOON);
    expect(edge.source).toBe("canopy");
    expect(edge.confidence).toBeLessThan(LOW_CONFIDENCE);
    expect(edge.confidence).toBeGreaterThan(0);
  });

  it("changes nothing when the canopy source cannot speak for the area", () => {
    // The provider contract's one hard rule, from the canopy side: declining an area
    // must be indistinguishable from there being no canopy provider at all.
    const elsewhere = bboxAroundPoint(LNG + 5, LAT, 100);
    const declines: CanopyProvider = {
      source: "canopy",
      prismsFor: (bbox) => (bboxContains(elsewhere, bbox) ? canopyPatch() : null),
    };
    const without = createGeometryShadowField([tiles()]).sampleEdges([underGrove], NOON)[0];
    const declined = createGeometryShadowField([tiles()], [declines]).sampleEdges(
      [underGrove], NOON
    )[0];
    expect(declined).toEqual(without);
  });

  it("does not dock an area a canopy source covered and found bare", () => {
    // "I looked and there are no trees" is knowledge, not a gap — so it neither adds
    // shadow nor costs confidence, and the label stays the building source's.
    const bare = staticCanopyProvider({ prisms: [], maxHeightM: 1 }, WIDE_COVERAGE);
    const without = createGeometryShadowField([tiles()]).sampleEdges([underGrove], NOON)[0];
    const covered = createGeometryShadowField([tiles()], [bare]).sampleEdges(
      [underGrove], NOON
    )[0];
    expect(covered).toEqual(without);
  });

  it("halves nothing: the 0.5 preference weight is not folded into the fraction", () => {
    // #244 keeps perceived intensity (0.5, for a route cost model) apart from
    // transmittance (the opacity here). If a future change multiplies them, this fails.
    const [edge] = createGeometryShadowField([tiles()], [canopy()]).sampleEdges(
      [underGrove], NOON
    );
    expect(edge.left).toBeCloseTo(CANOPY_OPACITY, 10);
  });

  it("reports the blended source from coverage(), building no geometry", () => {
    const area = bboxAroundEdges([underGrove], QUERY_PAD_M) as BBox;
    const field = createGeometryShadowField([tiles()], [canopy()]);
    expect(field.coverage(area, NOON).source).toBe("mixed");
    expect(field.coverage(area, NOON).confidence).toBe(
      field.sampleEdges([underGrove], NOON)[0].confidence
    );
  });

  it("blends canopy into a point probe too", () => {
    const field = createGeometryShadowField([tiles()], [canopy()]);
    const sample = field.shadowAt(GROVE[0], GROVE[1], NOON);
    expect(sample.shadow).toBeCloseTo(CANOPY_OPACITY, 10);
    expect(sample.source).toBe("mixed");
  });

  it("sweeps N times to exactly what N samples produce", () => {
    // A6's parity guarantee, re-asserted with canopy in play: the sweep now resolves a
    // seasonal source per time, and it must still be the same floats.
    const times = [4, 8, 12, 16, 20].map(
      (hour) => new Date(Date.UTC(2026, 5, 21, hour, 0, 0))
    );
    const field = createGeometryShadowField([tiles()], [canopy()]);
    const swept = field.sweep([underGrove], times);
    times.forEach((when, i) => {
      expect(swept[i]).toEqual(field.sampleEdges([underGrove], when));
    });
  });

  it("preloads canopy sources alongside building ones", async () => {
    const loaded: string[] = [];
    const building: PrismProvider = {
      source: "overpass",
      prismsFor: () => null,
      load: async () => {
        loaded.push("overpass");
      },
    };
    const trees: CanopyProvider = {
      source: "canopy",
      prismsFor: () => null,
      load: async () => {
        loaded.push("canopy");
      },
    };
    await createGeometryShadowField([building], [trees]).ready(WIDE_COVERAGE);
    expect(loaded.sort()).toEqual(["canopy", "overpass"]);
  });
});

// ─── Canopy from the raster (A8d) ─────────────────────────────────────────────

describe("raster canopy", () => {
  /** Far enough across the shadow direction that no building shadow reaches it. */
  const GROVE = acrossShadow(300);
  const RASTER_OPACITY = 0.9;

  /** A 20 m edge through the middle of the grove, across the shadow direction. */
  const underGrove: EdgeRef = {
    from: [GROVE[0] - 10 / mPerLng, GROVE[1]],
    to: [GROVE[0] + 10 / mPerLng, GROVE[1]],
  };

  const tiles = () => staticPrismProvider(oneBuilding(), WIDE_COVERAGE, "tiles");

  /**
   * A height field with no raster behind it.
   *
   * `canopyRasterField.test.ts` is where the march itself is pinned against known
   * geometry. What `ShadowField` owns is the plumbing — which source wins a point,
   * what the answer is labelled, what it is worth, and whether the footprints ever
   * reach the mask — and a fake field states each of those without a patch of pixels
   * standing between the assertion and the thing asserted.
   */
  function fakeField(opts?: {
    opacity?: number;
    maxHeightM?: number;
    validFraction?: number;
    shades?: (lng: number, lat: number) => boolean;
    maskedWith?: Array<unknown>;
    /** What `masked()` returns. Defaults to the field itself — nothing subtracted. */
    afterMask?: () => CanopyHeightField;
  }): CanopyHeightField {
    const opacity = opts?.opacity ?? RASTER_OPACITY;
    const shades = opts?.shades ?? (() => true);
    const self: CanopyHeightField = {
      validFraction: opts?.validFraction ?? 1,
      maxHeightM: opts?.maxHeightM ?? 12,
      masked(footprints) {
        opts?.maskedWith?.push(footprints);
        return opts?.afterMask ? opts.afterMask() : self;
      },
      // The sun and the moment are folded into the answer on purpose. A stub that
      // ignored them would let the sweep-parity test below pass while `sweep` handed
      // the raster the wrong hour — which is the one thing that test exists to catch.
      shadeFor: (azimuth, altitude, when) => ({
        opacityAt: (lng, lat) =>
          shades(lng, lat)
            ? opacity * (0.5 + 0.5 * Math.abs(Math.sin(azimuth + altitude + when.getTime() / 1e9)))
            : 0,
      }),
      // The rain path samples by ray; this fake answers with the same shape so the
      // solar stub's story (shades where `shades` says) carries over unchanged.
      sampleFor: (ray) => ({
        sample: (lng, lat) => ({
          protection: shades(lng, lat) ? ray.strength : 0,
          complete: true,
        }),
      }),
    };
    return self;
  }

  const raster = (field = fakeField()): CanopyRasterProvider => ({
    source: "canopy-raster",
    fieldFor: (bbox) => (bboxContains(WIDE_COVERAGE, bbox) ? field : null),
  });

  /**
   * What `fakeField`'s stub reports for the sun over the grove — the blend's expected
   * value. Over the grove, not over the scene origin: `ShadowField` fixes one sun per
   * cell at the cell's own centroid, which for `underGrove` is `GROVE` itself.
   */
  const groveSun = SunCalc.getPosition(NOON, GROVE[1], GROVE[0]);
  const expectedShade = (field = fakeField()) =>
    field.shadeFor(groveSun.azimuth, groveSun.altitude, NOON).opacityAt(GROVE[0], GROVE[1]);

  it("reports canopy shade where buildings report none", () => {
    const without = createGeometryShadowField([tiles()]).sampleEdges([underGrove], NOON)[0];
    const with_ = createGeometryShadowField([tiles()], [], [raster()]).sampleEdges(
      [underGrove], NOON
    )[0];

    expect(without.left).toBe(0);
    expect(with_.left).toBeCloseTo(expectedShade(), 10);
    expect(with_.right).toBeCloseTo(expectedShade(), 10);
    // Below 1: a crown is not a wall, whatever the raster says about its height.
    expect(with_.left).toBeLessThan(1);
  });

  it("lets an opaque building win outright where the two overlap", () => {
    const inBuildingShadow: EdgeRef = { from: alongShadow(25), to: alongShadow(35) };
    const [edge] = createGeometryShadowField([tiles()], [], [raster()]).sampleEdges(
      [inBuildingShadow], NOON
    );
    expect(edge.left).toBe(1);
  });

  it("takes the darker of the two canopy sources, never their sum", () => {
    // The same row of plane trees is in OSM and in the raster. Compounding 0.6 and 0.9
    // into 0.96 would count one tree twice; the answer is the darker of the two, which
    // is the rule `opacityAt` already applies between two crowns inside one index.
    const thinCanopy: PrismSet = {
      prisms: [
        {
          heightM: 9,
          baseM: 3,
          opacity: 0.6,
          ring: [
            [GROVE[0] - 0.001, GROVE[1] - 0.001],
            [GROVE[0] + 0.001, GROVE[1] - 0.001],
            [GROVE[0] + 0.001, GROVE[1] + 0.001],
            [GROVE[0] - 0.001, GROVE[1] + 0.001],
            [GROVE[0] - 0.001, GROVE[1] - 0.001],
          ],
        },
      ],
      maxHeightM: 9,
    };
    const [edge] = createGeometryShadowField(
      [tiles()], [staticCanopyProvider(thinCanopy, WIDE_COVERAGE)], [raster()]
    ).sampleEdges([underGrove], NOON);

    expect(expectedShade()).toBeGreaterThan(0.6);
    expect(edge.left).toBeCloseTo(expectedShade(), 10);
    expect(edge.canopySources).toEqual({ osm: true, raster: true });
  });

  it("hands the building footprints to the mask, once per prism set", () => {
    // A8c's footprint subtraction, and the only place both sources are in hand.
    const maskedWith: Array<unknown> = [];
    const field = createGeometryShadowField(
      [tiles()], [], [raster(fakeField({ maskedWith }))]
    );
    field.sampleEdges([underGrove], NOON);

    // One call for the whole batch, not one per edge, and it is the resolved
    // building set that arrives — the same array `PREPARED` is keyed on.
    expect(maskedWith).toHaveLength(1);
    expect(maskedWith[0]).toEqual(oneBuilding().prisms);
  });

  it("does not label an answer canopy when every tree it had stood on a roof", () => {
    // Footprint subtraction can leave nothing standing. The label and the dock must
    // describe the evidence the number was computed from — the masked field — or the
    // route card says "and tree canopy" over a street the raster contributed nothing to.
    const rooftopsOnly = raster(
      fakeField({ afterMask: () => fakeField({ maxHeightM: 0, shades: () => false }) })
    );
    const buildingsOnly = createGeometryShadowField([tiles()]).sampleEdges([underGrove], NOON)[0];
    const field = createGeometryShadowField([tiles()], [], [rooftopsOnly]);

    expect(field.sampleEdges([underGrove], NOON)[0]).toEqual(buildingsOnly);
    expect(field.shadowAt(GROVE[0], GROVE[1], NOON).source).toBe("tiles");

    // `coverage()` cannot mask — it builds no geometry — so it stays the upper bound.
    const area = bboxAroundEdges([underGrove], QUERY_PAD_M) as BBox;
    expect(field.coverage(area, NOON).source).toBe("mixed");
  });

  it("does not rasterise footprints to answer coverage()", () => {
    // `coverage()` promises to build no geometry — it is the cheap up-front check that
    // decides whether A4b reads the map canvas at all.
    const maskedWith: Array<unknown> = [];
    const area = bboxAroundEdges([underGrove], QUERY_PAD_M) as BBox;
    const result = createGeometryShadowField(
      [tiles()], [], [raster(fakeField({ maskedWith }))]
    ).coverage(area, NOON);

    expect(maskedWith).toHaveLength(0);
    expect(result.source).toBe("mixed");
  });

  it("scores the raster above OSM's crowns and still below LOW_CONFIDENCE alone", () => {
    const fromRaster = createGeometryShadowField([], [], [raster()]).sampleEdges(
      [underGrove], NOON
    )[0];

    expect(fromRaster.source).toBe("canopy");
    expect(fromRaster.confidence).toBeLessThan(LOW_CONFIDENCE);
    expect(fromRaster.confidence).toBeGreaterThan(confidenceFor("canopy", sun.altitude, 1));
  });

  it("docks the answer for the share of the patch the raster never populated", () => {
    const whole = createGeometryShadowField([], [], [raster()]).sampleEdges(
      [underGrove], NOON
    )[0];
    const holed = createGeometryShadowField(
      [], [], [raster(fakeField({ validFraction: 0.5 }))]
    ).sampleEdges([underGrove], NOON)[0];

    expect(holed.confidence).toBeCloseTo(whole.confidence * 0.5, 10);
  });

  it("does not dock an area the raster covered and found bare", () => {
    // Nothing standing in the patch is knowledge, not a gap: no shade, no label
    // change, no confidence cost.
    const bare = raster(fakeField({ maxHeightM: 0, shades: () => false }));
    const without = createGeometryShadowField([tiles()]).sampleEdges([underGrove], NOON)[0];
    const covered = createGeometryShadowField([tiles()], [], [bare]).sampleEdges(
      [underGrove], NOON
    )[0];

    expect(covered).toEqual(without);
  });

  it("changes nothing when the raster source cannot speak for the area", () => {
    const elsewhere = bboxAroundPoint(LNG + 5, LAT, 100);
    const declines: CanopyRasterProvider = {
      source: "canopy-raster",
      fieldFor: (bbox) => (bboxContains(elsewhere, bbox) ? fakeField() : null),
    };
    const without = createGeometryShadowField([tiles()]).sampleEdges([underGrove], NOON)[0];
    const declined = createGeometryShadowField([tiles()], [], [declines]).sampleEdges(
      [underGrove], NOON
    )[0];

    expect(declined).toEqual(without);
  });

  it("blends the raster into a point probe too", () => {
    const field = createGeometryShadowField([tiles()], [], [raster()]);
    const sample = field.shadowAt(GROVE[0], GROVE[1], NOON);

    expect(sample.shadow).toBeGreaterThan(0.5);
    expect(sample.source).toBe("mixed");
  });

  it("sweeps N times to exactly what N samples produce", () => {
    // A6's parity guarantee again, with the raster in play: the sweep resolves and
    // masks the field once and rebuilds only the march, and it must still be the
    // same floats.
    const times = [4, 8, 12, 16, 20].map((hour) => new Date(Date.UTC(2026, 5, 21, hour, 0, 0)));
    const field = createGeometryShadowField([tiles()], [], [raster()]);
    const swept = field.sweep([underGrove], times);

    times.forEach((when, i) => {
      expect(swept[i]).toEqual(field.sampleEdges([underGrove], when));
    });
  });

  it("preloads the raster beside the Overpass chain rather than behind it", async () => {
    // The raster is byte-range reads against source.coop, which shares neither a host
    // nor a rate limit with Overpass. Queueing it behind two Overpass calls would make
    // a route wait for nothing.
    const order: string[] = [];
    let openGate = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const building: PrismProvider = {
      source: "overpass",
      prismsFor: () => null,
      load: async () => {
        await gate;
        order.push("overpass");
      },
    };
    const tiles: CanopyRasterProvider = {
      source: "canopy-raster",
      fieldFor: () => null,
      load: async () => {
        order.push("raster");
        openGate();
      },
    };

    await createGeometryShadowField([building], [], [tiles]).ready(WIDE_COVERAGE);
    expect(order).toEqual(["raster", "overpass"]);
  });
});
