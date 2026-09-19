import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBuildings } from "../src/buildings";
import { canonicalJson } from "../src/canonical";

/**
 * Building policy applied to synthetic FeatureServer pages: placeholders and
 * demolition records rejected, feet converted to metres exactly once, typed
 * fallbacks from the feature code then the citywide median, ring repair, and
 * self-intersection rejection — with every decision counted.
 */

interface PageFeature {
  attributes: Record<string, unknown>;
  geometry: { rings: unknown[][] };
}

function page(features: PageFeature[]): string {
  return JSON.stringify({ features, exceededTransferLimit: true });
}

const square = (southWest: [number, number], meters: number): unknown[][] => {
  const d = meters / 111_320;
  const [lng, lat] = southWest;
  return [
    [
      [lng, lat],
      [lng + d, lat],
      [lng + d, lat + d],
      [lng, lat + d],
      [lng, lat],
    ],
  ];
};

test("feature/status policy rejects placeholders and demolition records", () => {
  const result = normalizeBuildings([
    page([
      {
        attributes: {
          DOITT_ID: 1,
          FEATURE_CODE: 1003,
          HEIGHT_ROOF: 12,
          LAST_STATUS_TYPE: "Constructed",
        },
        geometry: { rings: square([-73.98, 40.75], 50) },
      },
      {
        attributes: {
          DOITT_ID: 2,
          FEATURE_CODE: 2100,
          HEIGHT_ROOF: 12,
          LAST_STATUS_TYPE: "Marked For Demolition",
        },
        geometry: { rings: square([-73.97, 40.75], 50) },
      },
      {
        attributes: {
          DOITT_ID: 3,
          FEATURE_CODE: 2100,
          HEIGHT_ROOF: 12,
          LAST_STATUS_TYPE: "Demolition",
        },
        geometry: { rings: square([-73.96, 40.75], 50) },
      },
    ]),
  ]);
  assert.deepEqual(
    result.stats.rejected.filter((entry) => entry.reason === "placeholder"),
    [{ reason: "placeholder", count: 1 }],
  );
  assert.deepEqual(
    result.stats.rejected.filter((entry) => entry.reason === "demolished"),
    [{ reason: "demolished", count: 2 }],
  );
  assert.equal(result.buildings.length, 0);
});

test("feet become metres once; zero and negative are unknown, never zero", () => {
  const result = normalizeBuildings([
    page([
      {
        attributes: {
          DOITT_ID: 10,
          FEATURE_CODE: 2100,
          HEIGHT_ROOF: 100,
          LAST_STATUS_TYPE: "Constructed",
        },
        geometry: { rings: square([-73.981, 40.751], 40) },
      },
      {
        attributes: {
          DOITT_ID: 11,
          FEATURE_CODE: 2100,
          HEIGHT_ROOF: null,
          LAST_STATUS_TYPE: "Constructed",
        },
        geometry: { rings: square([-73.98, 40.751], 40) },
      },
      {
        attributes: {
          DOITT_ID: 12,
          FEATURE_CODE: 2100,
          HEIGHT_ROOF: -5,
          LAST_STATUS_TYPE: "Constructed",
        },
        geometry: { rings: square([-73.979, 40.751], 40) },
      },
    ]),
  ]);
  assert.equal(result.buildings.find((building) => building.doittId === 10)!.heightM, 30.48);
  assert.equal(
    result.buildings.find((building) => building.doittId === 10)!.heightSource,
    "source",
  );
  // The only known height is 30.48 m, so the typed fallback is not zero.
  for (const id of [11, 12]) {
    const building = result.buildings.find((candidate) => candidate.doittId === id)!;
    assert.equal(building.heightM, 30.48);
    assert.equal(building.heightSource, "fallback");
  }
  assert.ok(
    result.buildings.every((building) => building.heightM !== null && building.heightM > 0),
  );
});

test("under-construction keeps a typed fallback, never unknown", () => {
  const result = normalizeBuildings([
    page([
      {
        attributes: {
          DOITT_ID: 20,
          FEATURE_CODE: 5100,
          HEIGHT_ROOF: 200,
          LAST_STATUS_TYPE: "Marked for Construction",
        },
        geometry: { rings: square([-73.99, 40.76], 45) },
      },
      {
        attributes: {
          DOITT_ID: 21,
          FEATURE_CODE: 5100,
          HEIGHT_ROOF: null,
          LAST_STATUS_TYPE: "Marked for Construction",
        },
        geometry: { rings: square([-73.988, 40.76], 45) },
      },
    ]),
  ]);
  const concrete = result.buildings.find((building) => building.doittId === 20)!;
  const missing = result.buildings.find((building) => building.doittId === 21)!;
  assert.equal(concrete.status, "under-construction");
  assert.equal(concrete.heightM, 60.96);
  assert.equal(missing.heightSource, "fallback");
  assert.equal(missing.heightM, 60.96);
});

test("non-building casters publish as other with typed heights", () => {
  const result = normalizeBuildings([
    page([
      {
        attributes: {
          DOITT_ID: 30,
          FEATURE_CODE: 2110,
          HEIGHT_ROOF: 20,
          LAST_STATUS_TYPE: "Constructed",
        },
        geometry: { rings: square([-74.01, 40.78], 30) },
      },
      {
        attributes: {
          DOITT_ID: 31,
          FEATURE_CODE: 1002,
          HEIGHT_ROOF: 50,
          LAST_STATUS_TYPE: "Constructed",
        },
        geometry: { rings: square([-74.0, 40.78], 30) },
      },
      {
        attributes: {
          DOITT_ID: 32,
          FEATURE_CODE: 1001,
          HEIGHT_ROOF: null,
          LAST_STATUS_TYPE: "Alteration",
        },
        geometry: { rings: square([-73.99, 40.78], 30) },
      },
    ]),
  ]);
  const skybridge = result.buildings.find((building) => building.doittId === 30)!;
  const tank = result.buildings.find((building) => building.doittId === 31)!;
  const canopyFallback = result.buildings.find((building) => building.doittId === 32)!;
  assert.equal(skybridge.status, "other");
  assert.equal(tank.status, "other");
  assert.equal(canopyFallback.status, "other");
  // Typed fallback is the median of the feature code's own known heights
  // (none here) falling back to the citywide median of 20 ft and 50 ft.
  // Citywide median of the two known heights (20 ft, 50 ft) in metres.
  assert.equal(canopyFallback.heightSource, "fallback");
  assert.equal(canopyFallback.heightM, Math.round(((20 + 50) / 2) * 0.3048 * 100) / 100);
});

test("rings are repaired deterministically and self-intersection rejects", () => {
  const open = [
    [-73.955, 40.755],
    [-73.954, 40.755],
    [-73.954, 40.756],
    [-73.955, 40.756],
  ] as [number, number][];
  const dupes = [
    [-73.949, 40.755],
    [-73.948, 40.755],
    [-73.948, 40.755],
    [-73.948, 40.756],
    [-73.949, 40.756],
    [-73.949, 40.755],
  ] as [number, number][];
  const bowtie = [
    [-73.944, 40.755],
    [-73.942, 40.757],
    [-73.942, 40.755],
    [-73.944, 40.757],
    [-73.944, 40.755],
  ] as [number, number][];
  const result = normalizeBuildings([
    page([
      {
        attributes: {
          DOITT_ID: 40,
          FEATURE_CODE: 2100,
          HEIGHT_ROOF: 10,
          LAST_STATUS_TYPE: "Constructed",
        },
        geometry: { rings: [open] },
      },
      {
        attributes: {
          DOITT_ID: 41,
          FEATURE_CODE: 2100,
          HEIGHT_ROOF: 10,
          LAST_STATUS_TYPE: "Constructed",
        },
        geometry: { rings: [dupes] },
      },
      {
        attributes: {
          DOITT_ID: 42,
          FEATURE_CODE: 2100,
          HEIGHT_ROOF: 10,
          LAST_STATUS_TYPE: "Constructed",
        },
        geometry: { rings: [bowtie] },
      },
    ]),
  ]);
  assert.equal(result.stats.repairedRings, 2);
  assert.deepEqual(
    result.stats.rejected.filter((entry) => entry.reason === "invalid-rings"),
    [{ reason: "invalid-rings", count: 1 }],
  );
  const repaired = [...result.buildings].map((building) => building.doittId);
  assert.deepEqual(repaired, [40, 41]);
  for (const building of result.buildings) {
    for (const ring of building.rings) {
      const first = ring[0];
      const last = ring[ring.length - 1];
      assert.equal(first[0], last[0]);
      assert.equal(first[1], last[1]);
    }
  }
});

test("duplicate DOITT_ID publishes once and is counted", () => {
  const result = normalizeBuildings([
    page([
      {
        attributes: {
          DOITT_ID: 50,
          FEATURE_CODE: 2100,
          HEIGHT_ROOF: 10,
          LAST_STATUS_TYPE: "Constructed",
        },
        geometry: { rings: square([-73.94, 40.755], 40) },
      },
      {
        attributes: {
          DOITT_ID: 50,
          FEATURE_CODE: 2100,
          HEIGHT_ROOF: 12,
          LAST_STATUS_TYPE: "Correction",
        },
        geometry: { rings: square([-73.94, 40.755], 40) },
      },
    ]),
  ]);
  assert.equal(result.buildings.length, 1);
  assert.deepEqual(
    result.stats.rejected.filter((entry) => entry.reason === "duplicate-doitt-id"),
    [{ reason: "duplicate-doitt-id", count: 1 }],
  );
});

test("normalized serialization is canonical and stable", () => {
  const source = [
    page([
      {
        attributes: {
          DOITT_ID: 60,
          FEATURE_CODE: 2100,
          HEIGHT_ROOF: 12,
          LAST_STATUS_TYPE: "Constructed",
        },
        geometry: { rings: square([-73.93, 40.755], 35) },
      },
    ]),
  ];
  const first = normalizeBuildings(source);
  const second = normalizeBuildings(source);
  assert.equal(canonicalJson(first.buildings), canonicalJson(second.buildings));
});
