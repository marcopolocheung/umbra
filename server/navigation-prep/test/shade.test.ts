import assert from "node:assert/strict";
import { test } from "node:test";
import { computeShadeCell, type ShadeCellInput } from "../src/shade";
import { SHADE_BYTES_PER_SEGMENT, SHADE_SLOT_COUNT } from "../../../app/lib/navigationData/shadeSlots";

/**
 * A tiny two-segment cell beside one 30 m building, with no canopy and no
 * raster (the canopy directory is deliberately absent). Enough to pin the
 * payload shape, determinism, and the night/day split without any frozen input.
 */
function fixtureInput(): ShadeCellInput {
  const a: [number, number] = [-73.9855, 40.755];
  const b: [number, number] = [-73.985, 40.755];
  const c: [number, number] = [-73.985, 40.7555];
  const bounds = { south: 40.7549, west: -73.9856, north: 40.7556, east: -73.9849 };
  return {
    key: "z14-0-0",
    geometryBounds: bounds,
    supportBounds: bounds,
    segments: [
      [1, 2],
      [2, 3],
    ],
    edges: [
      { from: a, to: b },
      { from: b, to: c },
    ],
    buildings: [
      {
        rings: [
          [
            [-73.98535, 40.75505],
            [-73.9852, 40.75505],
            [-73.9852, 40.75525],
            [-73.98535, 40.75525],
            [-73.98535, 40.75505],
          ],
        ],
        heightM: 30,
      },
    ],
    canopy: [],
  };
}

const canopyInputs = { chmv2Dir: "/nonexistent/chmv2", osmVegetationPath: "/nonexistent/osm.json" };

test("shade cell payload is segments × 768 slots × 2 bytes", async () => {
  const result = await computeShadeCell(fixtureInput(), canopyInputs);
  assert.equal(result.segments, 2);
  assert.equal(result.slots, SHADE_SLOT_COUNT);
  assert.equal(result.bytes.byteLength, 2 * SHADE_SLOT_COUNT * SHADE_BYTES_PER_SEGMENT);
});

test("a night slot is fully shadowed (255) and a summer noon slot is not", async () => {
  const result = await computeShadeCell(fixtureInput(), canopyInputs);
  // January (month 0), 05:00 → slot 0: the sun is down in NYC.
  const nightOffset = 0 * 2 * SHADE_BYTES_PER_SEGMENT;
  assert.equal(result.bytes[nightOffset], 255);
  assert.equal(result.bytes[nightOffset + 1], 255);
  // July (month 6), 12:00 → slot 28: sun up, so at least one side is sampled
  // below full shadow.
  const noonOffset = (6 * 64 + 28) * 2 * SHADE_BYTES_PER_SEGMENT;
  const left = result.bytes[noonOffset];
  const right = result.bytes[noonOffset + 1];
  assert.ok(left < 255 || right < 255, `expected a lit noon side, got ${left}/${right}`);
});

test("a seam edge reaching past the cell still sees its casters (#294)", async () => {
  // The owner cell publishes a seam edge whose far endpoint lies ~800 m outside
  // its bounds. The field's query box spans every endpoint plus its pad, so a
  // provider gated on the cell's padded bounds declined it — and the build
  // wrote that "no geometry" answer as 0 shade. Here a 200 m tower stands
  // south of the edge's near end: in January at noon it must shade it.
  const input = fixtureInput();
  const near: [number, number] = [-73.9852, 40.7555];
  const far: [number, number] = [-73.9852, 40.7627];
  input.segments = [[1, 2]];
  input.edges = [{ from: near, to: far }];
  input.buildings = [
    {
      rings: [
        [
          [-73.9856, 40.7550],
          [-73.9848, 40.7550],
          [-73.9848, 40.7553],
          [-73.9856, 40.7553],
          [-73.9856, 40.7550],
        ],
      ],
      heightM: 200,
    },
  ];
  const result = await computeShadeCell(input, canopyInputs);
  // January (month 0), 12:00 → slot 28.
  const offset = (0 * 64 + 28) * SHADE_BYTES_PER_SEGMENT;
  const left = result.bytes[offset];
  const right = result.bytes[offset + 1];
  assert.ok(left > 0 || right > 0, `expected the tower's shadow, got ${left}/${right}`);
});

test("the same cell builds to identical bytes (determinism)", async () => {
  const first = await computeShadeCell(fixtureInput(), canopyInputs);
  const second = await computeShadeCell(fixtureInput(), canopyInputs);
  assert.deepEqual(Buffer.from(first.bytes), Buffer.from(second.bytes));
});
