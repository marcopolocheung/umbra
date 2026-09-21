import { describe, expect, it } from "vitest";
import type { CanopyPatch } from "../../canopyRaster/canopyTileStore";
import { lonLatToMercator, mercatorToLonLat } from "../../canopyRaster/tiles";
import {
  type BBox,
  type CanopyRasterProvider,
  type EdgeRef,
  bboxContains,
  createGeometryShadowField,
} from "../../shadowField/ShadowField";
import { createCanopyHeightField } from "../../shadowField/canopyRasterField";
import { RAIN_OPACITY_LEAF_OFF, RAIN_OPACITY_LEAF_ON } from "../opacity";
import { rainDirectionFromWind, verticalRainDirection } from "../direction";

/**
 * Raster canopy through the three rain queries (`sampleRainEdges`, `rainAt`,
 * `sampleRainGrid`) — the plumbing this change added, pinned against the same kind
 * of analytic patches `canopyRasterField.test.ts` uses for the march itself.
 *
 * What is asserted here is not where a band lands (that is the march's file) but
 * what the *field* does with the march: the strength it hands the ray (the rain
 * priors, via the seasonal light figure), the provenance it reports, the confidence
 * it docks when the march's evidence ran out, and that time alone changes nothing.
 *
 * Geometry note that every fixture below shares: edge samples sit at ±4 m sidewalk
 * offsets and walk the edge at ~5 m steps, so a single-pixel crown is something the
 * samples can step over entirely. The casters below are therefore wide blocks, the
 * way the solar file builds them, and every expected value is derived from the
 * crown model (`CROWN_BASE_FRACTION` = 0.35) rather than eyeballed.
 */

const MADRID: [number, number] = [-3.7038, 40.4168];
const RES_M = 2;
const SIZE = 801; // wide enough that a cell bbox + 400 m pad stays inside
const CENTRE = (SIZE - 1) / 2;
const TREE_M = 20;

const LEAF_ON = new Date("2026-07-15T12:00:00Z");
const LEAF_OFF = new Date("2027-01-15T12:00:00Z");

function patchAround(
  heightAt: (col: number, row: number) => number,
  validAt?: (col: number, row: number) => number,
  size = SIZE,
): CanopyPatch {
  const [cx, cy] = lonLatToMercator(MADRID[0], MADRID[1]);
  const mercRes = RES_M / Math.cos((MADRID[1] * Math.PI) / 180);
  const half = (size / 2) * mercRes;
  const [west, south] = mercatorToLonLat(cx - half, cy - half);
  const [east, north] = mercatorToLonLat(cx + half, cy + half);

  const heights = new Uint8Array(size * size);
  let valid: Uint8Array | null = null;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      heights[row * size + col] = heightAt(col, row);
      if (validAt) {
        if (!valid) valid = new Uint8Array(size * size).fill(1);
        valid[row * size + col] = validAt(col, row);
      }
    }
  }
  return {
    heights,
    valid,
    width: size,
    height: size,
    bbox: [west, south, east, north],
    metresPerPixel: RES_M,
    overviewIndex: 0,
    quadkeys: ["test"],
  };
}

/** A coordinate `northM`/`eastM` metres from the patch centre. */
function offset(northM: number, eastM = 0): [number, number] {
  const [cx, cy] = lonLatToMercator(MADRID[0], MADRID[1]);
  const scale = 1 / Math.cos((MADRID[1] * Math.PI) / 180);
  return mercatorToLonLat(cx + eastM * scale, cy + northM * scale);
}

function fieldOver(patch: CanopyPatch) {
  const field = createCanopyHeightField(patch);
  const coverage: BBox = {
    west: patch.bbox[0], south: patch.bbox[1], east: patch.bbox[2], north: patch.bbox[3],
  };
  const provider: CanopyRasterProvider = {
    source: "canopy-raster",
    fieldFor: (bbox) => (bboxContains(coverage, bbox) ? field : null),
  };
  return createGeometryShadowField([], [], [provider]);
}

/**
 * A 20 m-tall canopy block `southM` metres south of centre, 24 m wide (east–west)
 * and 12 m deep — wide enough that every sidewalk sample of an edge through its
 * band lands inside the block's east–west span.
 */
function canopyBlock(southM: number, heightM = TREE_M): CanopyPatch {
  const row = CENTRE + Math.round(southM / RES_M);
  return patchAround(
    (col, r) =>
      Math.abs(col - CENTRE) <= 6 && Math.abs(r - row) <= 3 ? heightM : 0,
  );
}

/** A 20 m east–west edge `northM` metres from the patch centre. */
function edgeAt(northM: number): EdgeRef {
  return { from: offset(northM, -10), to: offset(northM, 10) };
}

describe("raster canopy through sampleRainEdges", () => {
  it("shelters an edge under a crown at the leaf-on rain prior, and labels the raster", () => {
    // The edge rides through the block itself (block 12 m south, edge 8–16 m south
    // of centre covers it); vertical rain protects the ground the crown stands on.
    const under = edgeAt(-14);
    const [shelter] = fieldOver(canopyBlock(12))
      .sampleRainEdges([under], verticalRainDirection(), LEAF_ON);

    // Between 0 and the prior: a crown is not a wall, and the sidewalk offsets put
    // some samples at the block's edge.
    expect(shelter.left).toBeGreaterThan(0);
    expect(shelter.left).toBeLessThanOrEqual(RAIN_OPACITY_LEAF_ON);
    expect(shelter.canopySources?.raster).toBe(true);
    expect(shelter.canopySources?.osm).toBe(false);
    expect(shelter.source).toBe("canopy");
  });

  it("displaces shelter downwind under a tilted ray, in the ray's direction", () => {
    const field = fieldOver(canopyBlock(0));
    // Rain FROM the north at 45°: the band sits 7–20 m south of the block, so an
    // edge at −24 m is inside it; an edge under the block's own trunk is not —
    // a crown based at 35% of 20 m leaves its own ground sunlit at 45°.
    const band = edgeAt(-24);
    const trunk = edgeAt(2);
    const direction = rainDirectionFromWind(0, 9); // 45° tilt
    const [bandEdge] = field.sampleRainEdges([band], direction, LEAF_ON);
    const [trunkEdge] = field.sampleRainEdges([trunk], direction, LEAF_ON);

    expect(bandEdge.left).toBeGreaterThan(0);
    expect(trunkEdge.left).toBe(0);
  });

  it("reverses the sheltered side when the wind bearing reverses", () => {
    const field = fieldOver(canopyBlock(0));
    const north = edgeAt(12); // inside the 7–20 m band north of the block
    const south = edgeAt(-24); // inside the band south of it
    const fromNorth = field.sampleRainEdges([north, south], rainDirectionFromWind(0, 9), LEAF_ON);
    const fromSouth = field.sampleRainEdges([north, south], rainDirectionFromWind(180, 9), LEAF_ON);

    expect(fromNorth[0].left).toBe(0); // upwind: between the ground and the source
    expect(fromNorth[1].left).toBeGreaterThan(0); // downwind band
    expect(fromSouth[0].left).toBeGreaterThan(0);
    expect(fromSouth[1].left).toBe(0);
  });

  it("applies the leaf-off rain prior out of season", () => {
    const under = edgeAt(-14);
    const leafOn = fieldOver(canopyBlock(12))
      .sampleRainEdges([under], verticalRainDirection(), LEAF_ON)[0];
    const leafOff = fieldOver(canopyBlock(12))
      .sampleRainEdges([under], verticalRainDirection(), LEAF_OFF)[0];

    // Same geometry, one season apart: the strength is the prior and only the prior.
    expect(leafOff.left).toBeGreaterThan(0);
    expect(leafOff.left).toBeLessThanOrEqual(RAIN_OPACITY_LEAF_OFF + 1e-9);
    expect(leafOn.left).toBeGreaterThan(leafOff.left);
  });

  it("keeps the same shelter when only the time changes under fixed wind", () => {
    const field = fieldOver(canopyBlock(0));
    const band = edgeAt(-24);
    const direction = rainDirectionFromWind(90, 6);
    // Same wind, same leaf state, one hour apart: nothing in the rain answer
    // should read the clock — geometry, strength and confidence all ignore it.
    const a = field.sampleRainEdges([band], direction, new Date("2026-07-15T10:00:00Z"))[0];
    const b = field.sampleRainEdges([band], direction, new Date("2026-07-15T11:00:00Z"))[0];
    expect(b.left).toBeCloseTo(a.left, 10);
    expect(b.right).toBeCloseTo(a.right, 10);
    expect(b.confidence).toBeCloseTo(a.confidence, 10);
  });

  it("docks confidence when the march leaves the patch before clearing the crown", () => {
    // A 60 m canopy wall 600 m south of centre, and an edge 10 m further south.
    // Rain FROM the south at 5° makes the ray climb southward: it leaves the
    // patch ~190 m in, at ~17 m of height — still inside the wall's 21–60 m
    // band — so the march is cut off mid-evidence and the dock applies.
    const wallRow = CENTRE + 300; // 600 m south of centre
    const patch = patchAround((_col, row) => (row === wallRow ? 60 : 0));
    const field = fieldOver(patch);
    const edge = edgeAt(-610);
    const [truncated] = field.sampleRainEdges([edge], rainDirectionFromWind(180, 0.79), LEAF_ON);
    expect(truncated.confidence).toBeLessThan(1);
    // The mirror image: an edge NORTH of a 20 m wall with rain from the south at
    // 45° sits inside the wall's 7–20 m lee band, and the ray clears the crown
    // well inside the patch — so the march completes and confidence is undocked.
    const interior = patchAround((_col, row) => (row === CENTRE ? 20 : 0));
    const [inside] = fieldOver(interior).sampleRainEdges([edgeAt(8)], rainDirectionFromWind(180, 9), LEAF_ON);
    expect(inside.confidence).toBeGreaterThan(truncated.confidence);
  });
});

describe("raster canopy through rainAt", () => {
  it("shelters a point under a crown at the rain prior, labelled canopy", () => {
    const patch = canopyBlock(0);
    const sample = fieldOver(patch).rainAt(
      MADRID[0], MADRID[1], verticalRainDirection(), LEAF_ON,
    );
    expect(sample.shelter).toBeCloseTo(RAIN_OPACITY_LEAF_ON, 5);
    expect(sample.source).toBe("canopy");
    expect(sample.canopySources?.raster).toBe(true);
    expect(sample.confidence).toBeGreaterThan(0);
  });

  it("displaces a point's shelter downwind under a tilted ray", () => {
    const field = fieldOver(canopyBlock(0));
    const direction = rainDirectionFromWind(0, 9); // from the north, 45°
    // 12 m south of the block: inside the 7–20 m band.
    const [lng, lat] = offset(-12);
    const band = field.rainAt(lng, lat, direction, LEAF_ON);
    // Under the trunk: outside the band.
    const trunk = field.rainAt(MADRID[0], MADRID[1], direction, LEAF_ON);
    expect(band.shelter).toBeCloseTo(RAIN_OPACITY_LEAF_ON, 5);
    expect(trunk.shelter).toBe(0);
  });

  it("reports an incomplete vertical march over nodata as unknown, not dry", () => {
    // A block whose centre pixel the raster never populated, sampled exactly there.
    const block = canopyBlock(0);
    const patch = patchAround(
      (col, row) => (Math.abs(col - CENTRE) <= 6 && Math.abs(row - CENTRE) <= 3 ? TREE_M : 0),
      (col, row) => (col === CENTRE && row === CENTRE ? 0 : 1),
    );
    void block;
    const sample = fieldOver(patch).rainAt(MADRID[0], MADRID[1], verticalRainDirection(), LEAF_ON);
    expect(sample.shelter).toBe(0);
    // The raster spoke — incompletely — so the provenance still names it.
    expect(sample.canopySources?.raster).toBe(true);
  });
});

describe("raster canopy through sampleRainGrid", () => {
  /** A small painted area around the patch centre. */
  function gridBounds(): BBox {
    const [west, south] = offset(-40, -40);
    const [east, north] = offset(40, 40);
    return { west, south, east, north };
  }

  it("paints shelter over the crown itself under calm rain", () => {
    const grid = fieldOver(canopyBlock(0))
      .sampleRainGrid(gridBounds(), 20, 20, verticalRainDirection(), LEAF_ON);
    // Vertical rain: shelter exactly where the crown stands — the middle rows.
    let shelteredRows = new Set<number>();
    let max = 0;
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        const v = grid.values[r * grid.cols + c];
        if (v > 0) { shelteredRows.add(r); if (v > max) max = v; }
      }
    }
    // The block is 12 m deep inside an 80 m / 20-cell tall grid → 3 middle rows.
    expect(shelteredRows.size).toBeGreaterThanOrEqual(2);
    expect(shelteredRows.size).toBeLessThanOrEqual(4);
    expect(max).toBeLessThanOrEqual(RAIN_OPACITY_LEAF_ON + 1e-6);
    expect(max).toBeGreaterThan(0);
    // And the middle of the grid, not an edge.
    for (const r of shelteredRows) expect(Math.abs(r - 9.5)).toBeLessThanOrEqual(3);
  });

  it("moves the sheltered rows downwind under a tilted ray", () => {
    const field = fieldOver(canopyBlock(0));
    const calm = field.sampleRainGrid(gridBounds(), 20, 20, verticalRainDirection(), LEAF_ON);
    const wind = field.sampleRainGrid(gridBounds(), 20, 20, rainDirectionFromWind(0, 9), LEAF_ON);
    // Rain from the north → the band moves south → larger row indices.
    const centreRow = (g: typeof calm) => {
      let sum = 0;
      let n = 0;
      for (let r = 0; r < g.rows; r++) {
        for (let c = 0; c < g.cols; c++) {
          if (g.values[r * g.cols + c] > 0) { sum += r; n++; }
        }
      }
      return sum / Math.max(1, n);
    };
    expect(centreRow(wind)).toBeGreaterThan(centreRow(calm));
    // Reversing the wind moves it back the other way.
    const fromSouth = field.sampleRainGrid(gridBounds(), 20, 20, rainDirectionFromWind(180, 9), LEAF_ON);
    expect(centreRow(fromSouth)).toBeLessThan(centreRow(wind));
  });
});
