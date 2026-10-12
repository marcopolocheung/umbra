import SunCalc from "suncalc";
import { describe, expect, it } from "vitest";
import { haversineMeters } from "../../routing";
import { createGeometryShadowField } from "../../shadowField/ShadowField";
import { fromZonedParts } from "../../timezone";
import { createShadeSpotsView, shadeSpots, type ShadeSpotsQuery } from "../shadeSpots";
import { shadeSlotIndex } from "../shadeSlots";
import type { ShadeTableShard } from "../shadeTable";
import type { NavigationStreetNode, NavigationStreetShard } from "../shardContract";

const generation = "nyc-2026-09-18-000000000000";
const bounds = { south: 40.7, west: -74.1, north: 40.8, east: -73.9 };
const node = (
  id: number,
  lon: number,
  lat = 40.755,
  isIntersection = true,
): NavigationStreetNode => ({ id, lon, lat, isIntersection });
const baseNodes = [node(10, -73.9855), node(20, -73.9845)];

function fixture(
  nodes = baseNodes,
  pairs: Array<[number, number]> = [[10, 20]],
  value: (key: string, slot: number) => [number, number] = () => [51, 204],
) {
  nodes = nodes.map((n) => ({ ...n }));
  const nodeOf = new Map(nodes.map((n) => [n.id, n]));
  const street: NavigationStreetShard = {
    version: 1,
    dataset: "nyc-navigation",
    kind: "streets",
    generation,
    geometryBounds: bounds,
    supportBounds: bounds,
    nodes,
    edges: pairs.flatMap(([from, to], index) => {
      const a = nodeOf.get(from)!;
      const b = nodeOf.get(to)!;
      const edge = {
        from,
        to,
        id: `w${Math.min(from, to)}s${index}f`,
        distanceM: haversineMeters([a.lon, a.lat], [b.lon, b.lat]),
        tags: { highway: "residential" },
      };
      return [edge, { ...edge, id: `w${Math.min(from, to)}s${index}r`, from: to, to: from }];
    }),
  };
  const segments = pairs
    .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const blocks = new Map<number, Uint8Array>();
  for (let slot = 0; slot < 768; slot++)
    blocks.set(slot, new Uint8Array(segments.flatMap(([lo, hi]) => value(`${lo},${hi}`, slot))));
  const shade: ShadeTableShard = {
    shard: {
      version: 1,
      dataset: "nyc-navigation",
      kind: "shade",
      generation,
      geometryBounds: bounds,
      supportBounds: bounds,
      slots: 768,
      segments,
      payload: { key: "shades/a.bin", bytes: segments.length * 768 * 2, sha256: "a".repeat(64) },
    },
    blocks,
  };
  return { street, shade, view: createShadeSpotsView([street], [shade]) };
}

const query: ShadeSpotsQuery = {
  lat: 40.755,
  lng: -73.985,
  date: "2026-07-04",
  fromMinutes: 840,
  toMinutes: 960,
  radiusM: 400,
  mode: "shade",
};

function run(overrides: Partial<ShadeSpotsQuery> = {}) {
  return shadeSpots(fixture().view, { ...query, ...overrides });
}

describe("shadeSpots table arithmetic and ranking", () => {
  it("returns exact byte fractions, mean and chronological half-open samples", () => {
    const { view } = fixture(baseNodes, [[10, 20]], (_key, slot) => [slot % 2 ? 51 : 102, 204]);
    const answer = shadeSpots(view, query);
    expect(answer.results.map((spot) => spot.side)).toEqual(["right", "left"]);
    const left = answer.results[1];
    expect(left.hours.map((sample) => sample.shade)).toEqual(
      [102, 51, 102, 51, 102, 51, 102, 51].map((byte) => byte / 255),
    );
    expect(left.meanShade).toBeCloseTo(76.5 / 255, 15);
    expect(left.hours.map((sample) => sample.minutes)).toEqual([
      840, 855, 870, 885, 900, 915, 930, 945,
    ]);
    expect(left.hours[0].slot).toBe(shadeSlotIndex(6, 36));
    expect(left.candidateId).toBe(`${generation}:10,20:left`);
    expect(left.effectiveWindow).toEqual({ fromMinutes: 840, toMinutes: 960 });
    expect(answer.reasons).toEqual([]);
  });

  it("ties mathematically equal means even with different sample distributions", () => {
    const { view } = fixture(baseNodes, [[10, 20]], (_key, slot) => [slot % 2 ? 51 : 153, 102]);
    const answer = shadeSpots(view, query);
    expect(answer.results.map((spot) => spot.meanShade)).toEqual([102 / 255, 102 / 255]);
    expect(answer.results.map((spot) => spot.side)).toEqual(["left", "right"]);
  });

  it("sun mode reverses the shade preference", () => {
    expect(run({ mode: "sun" }).results.map((spot) => spot.side)).toEqual(["left", "right"]);
  });

  it("caps results at four and breaks equal scores by distance then identity", () => {
    const nodes = [
      ...baseNodes,
      node(30, -73.9842),
      node(40, -73.9838),
      node(50, -73.9832),
      node(60, -73.9828),
    ];
    const { view } = fixture(
      nodes,
      [
        [50, 60],
        [30, 40],
        [10, 20],
      ],
      () => [128, 128],
    );
    const answer = shadeSpots(view, query);
    expect(answer.results).toHaveLength(4);
    expect(answer.results.map((spot) => spot.segmentKey)).toEqual([
      "10,20",
      "10,20",
      "30,40",
      "30,40",
    ]);
    expect(answer.results.slice(0, 2).map((spot) => spot.side)).toEqual(["left", "right"]);
  });

  it("includes the radius boundary, excludes outside, and uses centreline distance", () => {
    const { view } = fixture();
    const lng =
      query.lng - ((200 / 6371000) * (180 / Math.PI)) / Math.cos((query.lat * Math.PI) / 180);
    // Haversine is slightly below 200 m for this same-latitude offset.
    expect(shadeSpots(view, { ...query, lng, radiusM: 200 }).results).toHaveLength(2);
    expect(shadeSpots(view, { ...query, lng: lng - 0.000001, radiusM: 200 }).results).toHaveLength(
      0,
    );
    expect(shadeSpots(view, { ...query, lng: lng - 0.000001, radiusM: 200 }).reasons).toContain(
      "no-candidates",
    );
  });

  it("drops segments below 15 m, but retains a 15 m segment", () => {
    const { street, shade } = fixture();
    for (const edge of street.edges) edge.distanceM = 14.999;
    expect(shadeSpots(createShadeSpotsView([street], [shade]), query).results).toEqual([]);
    for (const edge of street.edges) edge.distanceM = 15;
    expect(shadeSpots(createShadeSpotsView([street], [shade]), query).results).toHaveLength(2);
  });
});

describe("shadeSpots window and representative day", () => {
  it("snaps and discloses 2:07–4:03, without changing requested values", () => {
    const answer = run({ fromMinutes: 847, toMinutes: 963 });
    expect(answer.requestedWindow).toEqual({ fromMinutes: 847, toMinutes: 963 });
    expect(answer.effectiveWindow).toEqual({ fromMinutes: 840, toMinutes: 960 });
    expect(answer.reasons).toContain("snapped");
    expect(run({ fromMinutes: 848 }).effectiveWindow?.fromMinutes).toBe(855);
  });

  it("returns an empty window when snapping erases a short request", () => {
    const answer = run({ fromMinutes: 841, toMinutes: 842 });
    expect(answer.results).toEqual([]);
    expect(answer.effectiveWindow).toBeNull();
    expect(answer.reasons).toContain("empty-window");
  });

  it("clips at table limits instead of repeating a clamped edge column", () => {
    const answer = run({ fromMinutes: 0, toMinutes: 1440 });
    expect(answer.effectiveWindow).toEqual({ fromMinutes: 300, toMinutes: 1260 });
    expect(answer.reasons).toContain("table-clipped");
    expect(run({ fromMinutes: 0, toMinutes: 240 }).reasons).toContain("empty-window");
    expect(run({ fromMinutes: 1275, toMinutes: 1440 }).reasons).toContain("empty-window");
  });

  it.each(["2026-01-01", "2032-01-31", "2026-07-04", "2040-07-30"])(
    "uses month, fixed year and NYC zone for %s",
    (date) => {
      const answer = run({ date });
      expect(answer.basis).toEqual({
        representativeDate: `2026-${date.slice(5, 7)}-15`,
        zone: "America/New_York",
        slotMinutes: 15,
      });
      expect(answer.results[0].hours[0].slot).toBe(
        shadeSlotIndex(Number(date.slice(5, 7)) - 1, 36),
      );
    },
  );

  it.each([
    { date: "2026-02-29" },
    { date: "2026-04-31" },
    { date: "2026-13-01" },
    { date: "today" },
    { fromMinutes: 960, toMinutes: 840 },
    { fromMinutes: 840, toMinutes: 840 },
    { fromMinutes: -1 },
    { toMinutes: 1441 },
    { fromMinutes: 840.5 },
    { lat: Number.NaN },
    { lng: 181 },
    { radiusM: 300 },
    { mode: "rain" },
  ])("rejects invalid queries: %j", (invalid) => {
    expect(() => run(invalid as Partial<ShadeSpotsQuery>)).toThrow();
  });

  it("accepts valid leap days without using their day for the table", () => {
    expect(run({ date: "2028-02-29" }).basis.representativeDate).toBe("2026-02-15");
  });
});

describe("shadeSpots daylight", () => {
  it.each(["shade", "sun"] as const)(
    "excludes night in %s mode and retains fully shaded daylight",
    (mode) => {
      const { view } = fixture(baseNodes, [[10, 20]], () => [255, 255]);
      const answer = shadeSpots(view, {
        ...query,
        date: "2026-01-07",
        fromMinutes: 900,
        toMinutes: 1200,
        mode,
      });
      expect(answer.reasons).toContain("daylight-clipped");
      expect(answer.results).toHaveLength(2);
      for (const spot of answer.results) {
        expect(spot.meanShade).toBe(1);
        for (const { minutes } of spot.hours) {
          const at = fromZonedParts(
            "America/New_York",
            2026,
            0,
            15,
            Math.floor(minutes / 60),
            minutes % 60,
          );
          expect(SunCalc.getPosition(at, query.lat, query.lng).altitude).toBeGreaterThan(0);
        }
        expect(spot.effectiveWindow.toMinutes).toBeLessThan(1200);
        expect(spot.effectiveWindow.toMinutes).toBe(spot.hours.at(-1)!.minutes + 15);
      }
      const night = shadeSpots(view, {
        ...query,
        date: "2026-01-07",
        fromMinutes: 1140,
        toMinutes: 1200,
        mode,
      });
      expect(night.results).toEqual([]);
      expect(night.reasons).toContain("night");
    },
  );

  it("uses the same daylight mask as the geometry shadow sweep, including short distant batch members", () => {
    const nodes = [...baseNodes, node(30, -74.03, 40.72), node(40, -74.02999, 40.72)];
    const { view, shade } = fixture(
      nodes,
      [
        [30, 40],
        [10, 20],
      ],
      () => [255, 255],
    );
    const positions = new Map(nodes.map((n) => [n.id, [n.lon, n.lat] as [number, number]]));
    const edges = shade.shard.segments.map(([lo, hi]) => ({
      from: positions.get(lo)!,
      to: positions.get(hi)!,
    }));
    const times = Array.from({ length: 64 }, (_, slot) =>
      fromZonedParts("America/New_York", 2026, 0, 15, 5 + Math.floor(slot / 4), (slot % 4) * 15),
    );
    const sweep = createGeometryShadowField([]).sweep(edges, times);
    const expected = times
      .map((_time, slot) => slot)
      .filter((slot) => sweep[slot][0].confidence !== 1 || sweep[slot][0].source !== "none");
    const answer = shadeSpots(view, {
      ...query,
      date: "2026-01-01",
      fromMinutes: 300,
      toMinutes: 1260,
    });
    expect(answer.results[0].hours.map((h) => h.slot)).toEqual(expected);
  });
});

describe("shadeSpots sides and topology", () => {
  it.each([
    [baseNodes, "North", "South", "lat"],
    [[node(10, -73.985, 40.7545), node(20, -73.985, 40.7555)], "West", "East", "lng"],
    [[node(20, -73.9855), node(10, -73.9845)], "South", "North", "lat"],
    [[node(10, -73.9855, 40.7545), node(20, -73.9845, 40.7555)], "Northwest", "Southeast", "lat"],
  ] as const)(
    "labels and offsets canonical sidewalks correctly",
    (nodes, leftCompass, rightCompass, axis) => {
      const { view } = fixture([...nodes]);
      const answer = shadeSpots(view, query);
      const left = answer.results.find((spot) => spot.side === "left")!;
      const right = answer.results.find((spot) => spot.side === "right")!;
      expect(left.label).toMatch(new RegExp(`^${leftCompass}-side`));
      expect(right.label).toMatch(new RegExp(`^${rightCompass}-side`));
      const positive = leftCompass === "North" || leftCompass === "Northwest";
      expect(left[axis] > right[axis]).toBe(positive);
    },
  );

  it("uses an optional supplied name, otherwise keeps coordinates in the label", () => {
    const { street, shade } = fixture();
    const answer = shadeSpots(
      createShadeSpotsView([street], [shade], new Map([["10,20", "W 42nd St"]])),
      query,
    );
    expect(answer.results.map((spot) => spot.label)).toEqual([
      "W 42nd St, south side",
      "W 42nd St, north side",
    ]);
    expect(run().results[0].label).toContain("near 40.");
  });

  it("deduplicates a subdivided block face despite reversed node ordering", () => {
    const nodes = [node(10, -73.986), node(30, -73.985, 40.755, false), node(20, -73.984)];
    const { view } = fixture(
      nodes,
      [
        [10, 30],
        [30, 20],
      ],
      (key) => (key === "10,30" ? [204, 51] : [51, 204]),
    );
    const answer = shadeSpots(view, query);
    expect(answer.results).toHaveLength(2);
    expect(new Set(answer.results.map((spot) => spot.blockFaceId)).size).toBe(2);
    expect(answer.results.map((spot) => spot.meanShade)).toEqual([204 / 255, 51 / 255]);
  });

  it("keeps short edges in topology but never returns them", () => {
    const nodes = [
      node(10, -73.986),
      node(20, -73.9851, 40.755, false),
      node(30, -73.985, 40.755, false),
      node(40, -73.984),
    ];
    const { view } = fixture(nodes, [
      [10, 20],
      [20, 30],
      [30, 40],
    ]);
    const answer = shadeSpots(view, query);
    expect(answer.results).toHaveLength(2);
    expect(answer.results.some((spot) => spot.segmentKey === "20,30")).toBe(false);
  });

  it("separates blocks at intersections and branches, and handles closed chains", () => {
    const nodes = [node(10, -73.986), node(20, -73.985), node(30, -73.984)];
    expect(
      shadeSpots(
        fixture(nodes, [
          [10, 20],
          [20, 30],
        ]).view,
        query,
      ).results,
    ).toHaveLength(4);
    const loop = [
      node(10, -73.9855, 40.7545, false),
      node(20, -73.9845, 40.7545, false),
      node(30, -73.985, 40.7555, false),
    ];
    const answer = shadeSpots(
      fixture(loop, [
        [10, 20],
        [20, 30],
        [30, 10],
      ]).view,
      query,
    );
    expect(answer.results).toHaveLength(2);
  });

  it("splits block faces at a branch even when its intersection flag is false", () => {
    const nodes = [
      node(10, -73.986),
      node(20, -73.985, 40.755, false),
      node(30, -73.984),
      node(40, -73.985, 40.756),
    ];
    const { view } = fixture(
      nodes,
      [
        [10, 20],
        [20, 30],
        [20, 40],
      ],
      (key) => [key === "10,20" ? 204 : key === "20,30" ? 153 : 102, 51],
    );
    expect(
      shadeSpots(view, query)
        .results.slice(0, 3)
        .map((spot) => spot.segmentKey),
    ).toEqual(["10,20", "20,30", "20,40"]);
  });

  it("is byte-for-byte deterministic across shuffled street/shade shards and reverse directed edges", () => {
    const a = fixture();
    const b = fixture([node(30, -73.9842), node(40, -73.9838)], [[30, 40]]);
    b.shade.shard.payload.key = "shades/b.bin";
    const expected = shadeSpots(
      createShadeSpotsView([a.street, b.street], [a.shade, b.shade]),
      query,
    );
    a.street.edges.reverse();
    b.street.edges.reverse();
    a.street.nodes.reverse();
    const actual = shadeSpots(
      createShadeSpotsView([b.street, a.street], [b.shade, a.shade]),
      query,
    );
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  });
});

describe("shadeSpots incomplete data", () => {
  it("skips missing required blocks instead of averaging a shorter window", () => {
    const { street, shade } = fixture();
    shade.blocks.delete(shadeSlotIndex(6, 37));
    const answer = shadeSpots(createShadeSpotsView([street], [shade]), query);
    expect(answer.results).toEqual([]);
    expect(answer.skippedSegments).toBe(1);
    expect(answer.reasons).toEqual(["incomplete-data", "no-data"]);
  });

  it("can return complete candidates while reporting missing segment data", () => {
    const a = fixture();
    const b = fixture([node(30, -73.9842), node(40, -73.9838)], [[30, 40]]);
    b.shade.shard.payload.key = "shades/b.bin";
    b.shade.blocks.clear();
    const answer = shadeSpots(
      createShadeSpotsView([a.street, b.street], [a.shade, b.shade]),
      query,
    );
    expect(answer.results).toHaveLength(2);
    expect(answer.reasons).toContain("incomplete-data");
  });

  it("does not repartition an incomplete shade shard", () => {
    const { street, shade } = fixture();
    shade.shard.segments.push([30, 40]);
    for (const [slot, block] of shade.blocks)
      shade.blocks.set(slot, new Uint8Array([...block, 51, 204]));
    const view = createShadeSpotsView([street], [shade]);
    expect(view.missingGeometry).toBe(1);
    const answer = shadeSpots(view, query);
    expect(answer.results).toEqual([]);
    expect(answer.reasons).toContain("incomplete-data");
  });

  it("reports empty and uncovered datasets without inventing values", () => {
    const empty = shadeSpots(createShadeSpotsView([], []), query);
    expect(empty.generation).toBeNull();
    expect(empty.reasons).toContain("no-data");
    const { street } = fixture();
    expect(shadeSpots(createShadeSpotsView([street], []), query).reasons).toContain("no-data");
  });

  it("excludes negative virtual IDs", () => {
    const { street } = fixture([node(-1, -73.9855), node(20, -73.9845)], [[-1, 20]]);
    expect(shadeSpots(createShadeSpotsView([street], []), query).results).toEqual([]);
  });

  it("rejects mixed and quarantined generations", () => {
    const { street, shade } = fixture();
    shade.shard.generation = "other";
    expect(() => createShadeSpotsView([street], [shade])).toThrow(/one navigation generation/);
    street.generation = shade.shard.generation = "nyc-2026-09-18-b94934cd765a";
    expect(() => createShadeSpotsView([street], [shade])).toThrow(/quarantined/);
  });

  it("rejects conflicting geometry, duplicate shade rows and malformed blocks", () => {
    const a = fixture();
    const b = fixture();
    b.street.nodes[0] = { ...b.street.nodes[0], lat: 40.76 };
    expect(() => createShadeSpotsView([a.street, b.street], [a.shade])).toThrow(/disagree/);
    expect(() => createShadeSpotsView([a.street], [a.shade, a.shade])).toThrow(/duplicate/);
    a.shade.blocks.set(0, new Uint8Array(1));
    expect(() => createShadeSpotsView([a.street], [a.shade])).toThrow(/slot block/);
  });
});
