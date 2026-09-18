import assert from "node:assert/strict";
import test from "node:test";
import { encodePolyline } from "../src/shapeSlice";
import { checkShard } from "../src/verify";
import { cumulativeMeters, haversineMeters } from "../src/util";

/** Minimal shard that passes every structural check. */
function shard(overrides: Record<string, unknown> = {}): Parameters<typeof checkShard>[1] {
  return {
    kind: "bus-shard",
    stops: [
      { id: "bus:a" },
      { id: "bus:b" },
    ],
    edges: [{ from: "bus:a", to: "bus:b", route: "R1", medianSec: 300 }],
    routes: [{ id: "R1" }],
    headways: [{ route: "R1", hour: 9 }],
    ...overrides,
  } as Parameters<typeof checkShard>[1];
}

test("a well-formed shard passes", () => {
  assert.doesNotThrow(() => checkShard("bus-x.json", shard()));
});

test("headway hours outside 0-27 are rejected", () => {
  // 24-27 are legal: a departure after midnight keeps the previous service
  // day's hour. 28 is not, and nor is a fractional or negative hour.
  assert.doesNotThrow(() => checkShard("bus-x.json", shard({ headways: [{ route: "R1", hour: 27 }] })));
  assert.throws(
    () => checkShard("bus-x.json", shard({ headways: [{ route: "R1", hour: 28 }] })),
    /hour 28/,
  );
  assert.throws(
    () => checkShard("bus-x.json", shard({ headways: [{ route: "R1", hour: -1 }] })),
    /hour -1/,
  );
  assert.throws(
    () => checkShard("bus-x.json", shard({ headways: [{ route: "R1", hour: 9.5 }] })),
    /hour 9.5/,
  );
});

test("published doors must be finite points, with exitOnly true or absent", () => {
  const withDoors = (entrances: unknown) =>
    shard({ stops: [{ id: "bus:a", entrances }, { id: "bus:b" }] });
  assert.doesNotThrow(() => checkShard("s.json", withDoors([])));
  assert.doesNotThrow(() => checkShard("s.json", withDoors([{ lat: 40.75, lon: -73.98, exitOnly: true }])));
  assert.throws(() => checkShard("s.json", withDoors([{ lat: Number.NaN, lon: -73.98 }])), /non-finite/);
  assert.throws(() => checkShard("s.json", withDoors([{ lat: 40.75, lon: -73.98, exitOnly: false }])), /exitOnly/);
  assert.throws(
    () => checkShard("s.json", withDoors(Array.from({ length: 65 }, () => ({ lat: 40.75, lon: -73.98 })))),
    /at most 64/,
  );
});

test("a bus shard may not carry a route none of its edges use", () => {
  assert.throws(
    () => checkShard("bus-x.json", shard({ routes: [{ id: "R1" }, { id: "R2" }] })),
    /route R2 has no edge/,
  );
});

/** The corner of an L from bus:a north to it, then east to bus:b. */
const CORNER = { lat: 40.76, lon: -73.99 };
const GEOM_SHARD = {
  stops: [
    { id: "bus:a", lat: 40.75, lon: -73.99 },
    { id: "bus:b", lat: 40.76, lon: -73.98 },
  ],
  alongTrackM: Math.round(
    cumulativeMeters([{ lat: 40.75, lon: -73.99 }, CORNER, { lat: 40.76, lon: -73.98 }]).pop() ?? 0,
  ),
};

function geomEdge(overrides: Record<string, unknown> = {}) {
  return {
    from: "bus:a",
    to: "bus:b",
    route: "R1",
    medianSec: 300,
    distM: GEOM_SHARD.alongTrackM,
    geom: encodePolyline([CORNER]),
    ...overrides,
  };
}

test("a shard whose geometry re-derives its own distance passes", () => {
  assert.doesNotThrow(() =>
    checkShard("bus-x.json", shard({ stops: GEOM_SHARD.stops, edges: [geomEdge()] })),
  );
});

test("geometry that does not re-derive the distance beside it is rejected", () => {
  // The check that matters is not "does it parse" but "is it the same line the
  // distance was measured along". A slice taken a segment early, or out of the
  // wrong shape, lands somewhere else and stops agreeing with distM.
  assert.throws(
    () =>
      checkShard(
        "bus-x.json",
        shard({
          stops: GEOM_SHARD.stops,
          edges: [geomEdge({ geom: encodePolyline([{ lat: 41.5, lon: -73.0 }]) })],
        }),
      ),
    /reports distM/,
  );
  // The straight chord is ~1.4 km against the L's ~2.0 km: right line, wrong
  // distance, and the client would draw one and quote the other.
  assert.throws(
    () =>
      checkShard(
        "bus-x.json",
        shard({
          stops: GEOM_SHARD.stops,
          edges: [geomEdge({ distM: Math.round(haversineMeters(40.75, -73.99, 40.76, -73.98)) })],
        }),
      ),
    /reports distM/,
  );
});

test("a geom that does not decode is rejected rather than ignored", () => {
  assert.throws(
    () =>
      checkShard(
        "bus-x.json",
        shard({ stops: GEOM_SHARD.stops, edges: [geomEdge({ geom: "not a polyline" })] }),
      ),
    /does not decode|reports distM/,
  );
  assert.throws(
    () => checkShard("bus-x.json", shard({ stops: GEOM_SHARD.stops, edges: [geomEdge({ geom: "" })] })),
    /empty geom/,
  );
});

test("a walked transfer joins one station to one bus stop, walks a whole number of metres, and not less than the crow flies", () => {
  const stops = [
    { id: "bus:a", lat: 40.751, lon: -73.989 },
    { id: "bus:b", lat: 40.752, lon: -73.988 },
    { id: "subway:P1", lat: 40.75, lon: -73.99 },
  ];
  const crowM = haversineMeters(40.75, -73.99, 40.751, -73.989);
  const withTransfer = (transfer: Record<string, unknown>) =>
    shard({ kind: "subway", stops, transfers: [{ minSec: 120, ...transfer }] });
  const walkM = Math.ceil(crowM) + 20;
  assert.doesNotThrow(() =>
    checkShard("subway.json", withTransfer({ from: "subway:P1", to: "bus:a", kind: "walked", walkM })),
  );
  assert.throws(
    () => checkShard("subway.json", withTransfer({ from: "subway:P1", to: "bus:a", kind: "teleport" })),
    /kind teleport/,
  );
  assert.throws(
    () => checkShard("subway.json", withTransfer({ from: "subway:P1", to: "bus:a", kind: "spatial", walkM })),
    /spatial transfer .* carries walkM/,
  );
  assert.throws(
    () => checkShard("subway.json", withTransfer({ from: "bus:a", to: "bus:b", kind: "walked", walkM })),
    /does not join a station to a bus stop/,
  );
  assert.throws(
    () => checkShard("subway.json", withTransfer({ from: "subway:P1", to: "bus:a", kind: "walked", walkM: 12.5 })),
    /walkM 12.5/,
  );
  assert.throws(
    () =>
      checkShard(
        "subway.json",
        withTransfer({ from: "subway:P1", to: "bus:a", kind: "walked", walkM: Math.floor(crowM) - 10 }),
      ),
    /shorter than the straight line/,
  );
});
