/**
 * S1 study self-tests — the truth marcher's geometry, run under node:test.
 * Gates do not see studies/ (studies/README.md), so these are run by the
 * reproduce command itself, and the note says so.
 *
 * Analytic frame: a flat surface, a 5 m wall, receiver eye at 1.0 m
 * (RECEIVER_M). A ray clears the wall once its height exceeds 5 m, so the
 * shadow reaches (5 − 1)/tan(alt) metres past the wall's sunward face.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Extract the study's functions without running its main(). */
function loadTruthAt() {
  const src = readFileSync(join(HERE, "30-eval.mjs"), "utf8");
  return new Function(
    "RECEIVER_M",
    "MARCH_CAP_M",
    "ATTRIBUTION_RADIUS_M",
    `${src.match(/function truthAt[\s\S]*?\n}\n/)[0]}
     ${src.match(/function landcoverClass[\s\S]*?\n}\n/)[0]}
     return truthAt;`,
  )(1.0, 400, 3);
}

/** A 41×41 m surface (±20 m) with a 5 m wall across east −1..+1 m. */
function wallSurface() {
  const n = 41;
  const extM = 20;
  const surface = {
    n,
    extM,
    cellM: 1,
    centre: [0, 0],
    top: new Float32Array(n * n),
    ground: new Float32Array(n * n),
  };
  for (let r = 0; r < n; r++) for (let c = 19; c <= 21; c++) surface.top[r * n + c] = 5;
  const landcover = {
    data: new Uint8Array(1),
    h: 1,
    w: 1,
    west: -1e9,
    bottom: -1e9,
    east: 1e9,
    north: 1e9,
    resFt: 1,
    ft: 1,
  };
  return { surface, landcover, centre: { cx: 0, cy: 0 } };
}

const ALT45 = Math.PI / 4;
const WEST = Math.PI / 2; // SunCalc azimuth +90°: sun due west, ray marches west

test("truth marcher shadows the lee of a wall, only the lee", () => {
  const truthAt = loadTruthAt();
  const { surface, landcover, centre } = wallSurface();
  // Sun due west: the ray marches west from the receiver, so the wall (east
  // −1..+1) shadows receivers EAST of it. Tip at 45°: (5−1)/1 = 4 m past the
  // east face (east +1) → shadowed up to east +5.
  assert.equal(truthAt(surface, landcover, centre, 3, 0, WEST, ALT45).shadow, 1, "in the lee");
  assert.equal(truthAt(surface, landcover, centre, 6, 0, WEST, ALT45).shadow, 0, "past the tip");
  // Sun due east instead: the ray marches east, and the receiver at +3 is
  // up-sun of the wall — sunlit.
  assert.equal(truthAt(surface, landcover, centre, 3, 0, -WEST, ALT45).shadow, 0, "up-sun side is sunlit");
  // West of the wall, sun due west: nothing between the receiver and the sun.
  assert.equal(truthAt(surface, landcover, centre, -4, 0, WEST, ALT45).shadow, 0, "up-sun side of a west sun");
});

test("shadow length follows the sun's altitude", () => {
  const truthAt = loadTruthAt();
  const { surface, landcover, centre } = wallSurface();
  // At 10°: tip at 4/tan(10°) ≈ 22.7 m past the east face → east +23.7;
  // a receiver at east +12 is shadowed at 10° and sunlit at 45° (tip +5).
  const lowSun = truthAt(surface, landcover, centre, 12, 0, WEST, (10 * Math.PI) / 180);
  assert.equal(lowSun.shadow, 1, "low sun shadows 12 m past the face");
  const highSun = truthAt(surface, landcover, centre, 12, 0, WEST, ALT45);
  assert.equal(highSun.shadow, 0, "45° sun reaches 12 m past the face");
});

test("night answers shadowed without geometry", () => {
  const truthAt = loadTruthAt();
  const { surface, landcover, centre } = wallSurface();
  assert.deepEqual(truthAt(surface, landcover, centre, -4, 0, WEST, -0.1), {
    shadow: 1,
    blocker: "night",
  });
});

test("landcover attribution reads the class raster", () => {
  const truthAt = loadTruthAt();
  const { surface, centre } = wallSurface();
  // Land-cover raster with x<0 canopy (class 1) and x≥0 building (class 5):
  // a 2-column window from −1e9 to +1e9, each column a half-space.
  const landcover = {
    data: new Uint8Array([1, 5, 1, 5]),
    h: 2,
    w: 2,
    west: -1e9,
    bottom: -1e9,
    east: 1e9,
    north: 1e9,
    resFt: 1e9,
    ft: 1,
  };
  // Wall across east −1..+1, sun due west: a receiver east of the wall at
  // +3 is in the lee; the ray climbs through the wall's east columns (x≥0)
  // → building attribution.
  const hit = truthAt(surface, landcover, centre, 3, 0, WEST, ALT45);
  assert.equal(hit.shadow, 1);
  assert.equal(hit.blocker, "building", "blocker cell is x≥0 → building class");
  // Sun due east instead: the receiver at −3 is in the lee west of the wall,
  // and the ray climbs through the west columns (x<0) → canopy attribution.
  const hitWest = truthAt(surface, landcover, centre, -3, 0, -WEST, ALT45);
  assert.equal(hitWest.shadow, 1);
  assert.equal(hitWest.blocker, "canopy", "blocker cell is x<0 → canopy class");
});

test("a blocker on a road pixel beside a building is attributed to the building", () => {
  const truthAt = loadTruthAt();
  const { surface, centre } = wallSurface();
  // 0.5 ft class pixels over ±40 ft: road (6) everywhere, building (5) only in
  // a strip 1–2 m east of the wall, so the blocking cell itself reads road —
  // the 2017/2021 facade misregistration the radius search exists for.
  const w = 160;
  const data = new Uint8Array(w * w).fill(6);
  const ft = 1200 / 3937;
  for (let r = 0; r < w; r++) {
    for (let c = 0; c < w; c++) {
      const xM = (-40 + (c + 0.5) * 0.5) * ft;
      if (xM > 1.5 && xM < 2.5) data[r * w + c] = 5;
    }
  }
  const landcover = { data, h: w, w, west: -40, bottom: -40, east: 40, north: 40, resFt: 0.5, ft };
  const hit = truthAt(surface, landcover, centre, 3, 0, WEST, ALT45);
  assert.equal(hit.shadow, 1);
  assert.equal(hit.blocker, "building");
  // With no building or canopy pixel anywhere, the caster stays "other".
  const roadOnly = { ...landcover, data: new Uint8Array(w * w).fill(6) };
  assert.equal(truthAt(surface, roadOnly, centre, 3, 0, WEST, ALT45).blocker, "other");
});

test("skipCanopy marches through a tree to the building behind it", () => {
  const truthAt = loadTruthAt();
  const n = 41;
  const extM = 20;
  const surface = { n, extM, cellM: 1, centre: [0, 0], top: new Float32Array(n * n), ground: new Float32Array(n * n) };
  // A 5 m "tree" at east +2 (column 22) and a 40 m "building" at east −6 (column 14).
  for (let r = 0; r < n; r++) {
    surface.top[r * n + 22] = 5;
    surface.top[r * n + 14] = 40;
  }
  // Canopy class east of x=0, building class west of it.
  const landcover = { data: new Uint8Array([5, 1, 5, 1]), h: 2, w: 2, west: -1e9, bottom: -1e9, east: 1e9, north: 1e9, resFt: 1e9, ft: 1 };
  const centre = { cx: 0, cy: 0 };
  // Receiver at east +4, sun due west at 45°: the tree is met first.
  const first = truthAt(surface, landcover, centre, 4, 0, WEST, ALT45);
  assert.equal(first.blocker, "canopy");
  // Trees removed, the 40 m building 10 m away still shadows the point.
  const behind = truthAt(surface, landcover, centre, 4, 0, WEST, ALT45, true);
  assert.deepEqual(behind, { shadow: 1, blocker: "building" });
  // Without the building, trees-removed truth is sun.
  for (let r = 0; r < n; r++) surface.top[r * n + 14] = 0;
  assert.equal(truthAt(surface, landcover, centre, 4, 0, WEST, ALT45, true).shadow, 0);
});

test("blocks cover at least three boroughs", () => {
  const { blocks } = JSON.parse(readFileSync(join(HERE, "blocks.json"), "utf8"));
  assert.ok(blocks.length >= 8, "at least 8 blocks");
  assert.ok(new Set(blocks.map((b) => b.borough)).size >= 3, "at least three boroughs");
});
