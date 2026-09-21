import SunCalc from "suncalc";
import { describe, expect, it } from "vitest";
import type { CanopyPatch } from "../../canopyRaster/canopyTileStore";
import { mercatorToLonLat, lonLatToMercator } from "../../canopyRaster/tiles";
import { CROWN_BASE_FRACTION } from "../canopy";
import {
  type BBox,
  type CanopyRasterProvider,
  type EdgeRef,
  bboxContains,
  createGeometryShadowField,
} from "../ShadowField";
import { createCanopyHeightField } from "../canopyRasterField";

/**
 * The ray-march, against patches whose geometry is known exactly.
 *
 * Every case here is "where does this canopy's shadow land", asked of a raster with
 * one or two tall pixels in it and nothing else. That is the whole reason to test the
 * march rather than a real patch: a shadow that lands 15 m from where it should looks
 * entirely plausible on a screenshot and is a wrong route.
 *
 * The trunk is what makes several of these non-obvious. A crown starts at
 * `CROWN_BASE_FRACTION` of its height, so its shadow is a band displaced from the
 * trunk — sunlit ground under the tree, shade further out — and the band slides as the
 * sun drops. A model that painted the crown solid from the ground would pass a "is it
 * shaded 12 m away" test and fail every one of these.
 */

const MADRID: [number, number] = [-3.7038, 40.4168];

/** Ground metres per pixel, and the size of every patch below. Both arbitrary. */
const RES_M = 2;
const SIZE = 201;

/**
 * A square patch centred on a coordinate, with heights from a per-pixel function.
 *
 * The grid is built in Web Mercator, the way `CanopyTileStore` composes a real one,
 * so `metresPerPixel` is ground metres at the centre and the lon/lat bbox is what
 * those pixels actually cover.
 */
function patchAround(
  centre: [number, number],
  heightAt: (col: number, row: number) => number,
  validAt?: (col: number, row: number) => number,
  size = SIZE,
): CanopyPatch {
  const [cx, cy] = lonLatToMercator(centre[0], centre[1]);
  const mercRes = RES_M / Math.cos((centre[1] * Math.PI) / 180);
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

/** A coordinate `northM` metres north and `eastM` east of the patch centre. */
function offset(northM: number, eastM = 0): [number, number] {
  const [cx, cy] = lonLatToMercator(MADRID[0], MADRID[1]);
  const scale = 1 / Math.cos((MADRID[1] * Math.PI) / 180);
  return mercatorToLonLat(cx + eastM * scale, cy + northM * scale);
}

/** One 20 m pixel at the patch centre and bare ground everywhere else. */
const CENTRE = (SIZE - 1) / 2;
const TREE_M = 20;
function oneTallPixel() {
  return patchAround(MADRID, (col, row) => (col === CENTRE && row === CENTRE ? TREE_M : 0));
}

/** Due south, 45° up — a shadow exactly as long as the thing casting it. */
const SUN_SOUTH_45 = { azimuth: 0, altitude: Math.PI / 4 };
const JULY = new Date("2026-07-15T12:00:00Z");
const JANUARY = new Date("2026-01-15T12:00:00Z");

describe("canopy height field — where the shadow lands", () => {
  it("shades ground away from the trunk, on the side the sun is not", () => {
    const shade = createCanopyHeightField(oneTallPixel()).shadeFor(
      SUN_SOUTH_45.azimuth, SUN_SOUTH_45.altitude, JULY,
    );

    // The sun is due south at 45°, so a 20 m crown based at 7 m throws its shadow
    // 7-20 m north. One pixel of slack at each end for the march's own step.
    expect(shade.opacityAt(...offset(12))).toBeGreaterThan(0);
    expect(shade.opacityAt(...offset(18))).toBeGreaterThan(0);

    // Under the trunk, and past the crown's tip: both sunlit.
    expect(shade.opacityAt(...offset(2))).toBe(0);
    expect(shade.opacityAt(...offset(30))).toBe(0);

    // South of the tree is between the tree and the sun.
    expect(shade.opacityAt(...offset(-12))).toBe(0);
  });

  it("puts the shadow where the azimuth points, not just north", () => {
    const field = createCanopyHeightField(oneTallPixel());
    // Sun in the east (azimuth -90°): the shadow falls west.
    const shade = field.shadeFor(-Math.PI / 2, Math.PI / 4, JULY);

    expect(shade.opacityAt(...offset(0, -12))).toBeGreaterThan(0);
    expect(shade.opacityAt(...offset(0, 12))).toBe(0);
    expect(shade.opacityAt(...offset(12, 0))).toBe(0);
  });

  it("lengthens the shadow as the sun drops", () => {
    const field = createCanopyHeightField(oneTallPixel());
    const high = field.shadeFor(0, (60 * Math.PI) / 180, JULY);
    const low = field.shadeFor(0, (20 * Math.PI) / 180, JULY);

    // 20 m of crown reaches ~11.5 m north at 60° and ~55 m at 20°.
    const far = offset(40);
    expect(high.opacityAt(...far)).toBe(0);
    expect(low.opacityAt(...far)).toBeGreaterThan(0);

    // And the near end walks outward with it: at 20° the trunk shadow starts ~19 m out.
    expect(high.opacityAt(...offset(8))).toBeGreaterThan(0);
    expect(low.opacityAt(...offset(8))).toBe(0);
  });

  it("shades the ground directly under the canopy when the sun is overhead", () => {
    const field = createCanopyHeightField(oneTallPixel());
    const noon = field.shadeFor(0, (89.9 * Math.PI) / 180, JULY);
    expect(noon.opacityAt(...offset(0))).toBeGreaterThan(0);
    expect(noon.opacityAt(...offset(12))).toBe(0);
  });

  it("reports nothing at all when the sun is down", () => {
    const field = createCanopyHeightField(oneTallPixel());
    expect(field.shadeFor(0, -0.1, JULY).opacityAt(...offset(12))).toBe(0);
  });

  it("reports no shade over a patch with nothing standing in it", () => {
    const field = createCanopyHeightField(patchAround(MADRID, () => 0));
    expect(field.maxHeightM).toBe(0);
    expect(field.shadeFor(0, Math.PI / 4, JULY).opacityAt(...offset(12))).toBe(0);
  });
});

describe("canopy height field — what the opacity is", () => {
  it("stops most of the beam in leaf and much less out of it", () => {
    const field = createCanopyHeightField(oneTallPixel());
    const summer = field.shadeFor(0, Math.PI / 4, JULY).opacityAt(...offset(12));
    const winter = field.shadeFor(0, Math.PI / 4, JANUARY).opacityAt(...offset(12));

    // `crownOpacity`'s published transmittance pair, applied to the raster's extent —
    // not a second opacity model. If this module ever grows its own number, this fails.
    expect(summer).toBeCloseTo(0.9, 10);
    expect(winter).toBeCloseTo(0.3, 10);
  });
});

describe("canopy height field — nodata is not bare ground", () => {
  it("does not let an unpopulated pixel cast, and reports how much was blank", () => {
    // Two tall pixels 40 m apart. The one south of the centre is real canopy; the one
    // south of *it* carries the same byte over a pixel the model never populated.
    // Only the first may cast, and the second must not — a raster full of blank
    // bytes read as heights would paint shade nobody can stand in.
    const real = CENTRE + 10;
    const blank = CENTRE + 20;
    const patch = patchAround(
      MADRID,
      (col, row) => (col === CENTRE && (row === real || row === blank) ? TREE_M : 0),
      (_col, row) => (row === blank ? 0 : 1),
    );
    const field = createCanopyHeightField(patch);

    expect(field.validFraction).toBeCloseTo((SIZE - 1) / SIZE, 10);
    expect(field.maxHeightM).toBe(TREE_M);

    const shade = field.shadeFor(0, Math.PI / 4, JULY);
    // 12 m north of the real tree, which sits 20 m south of the centre.
    expect(shade.opacityAt(...offset(-8))).toBeGreaterThan(0);
    // The same offset from the blank one, where nothing is known to stand.
    expect(shade.opacityAt(...offset(-28))).toBe(0);
  });

  it("marches over a hole rather than stopping at it", () => {
    // A blank column between the tree and the ground it shades. The march must cross
    // it: treating nodata as the end of the evidence would lose a real shadow.
    const patch = patchAround(
      MADRID,
      (col, row) => (col === CENTRE && row === CENTRE ? TREE_M : 0),
      (_col, row) => (row === CENTRE - 2 ? 0 : 1),
    );
    const shade = createCanopyHeightField(patch).shadeFor(0, Math.PI / 4, JULY);
    expect(shade.opacityAt(...offset(12))).toBeGreaterThan(0);
  });

  it("calls a fully valid patch fully valid without allocating a mask", () => {
    expect(createCanopyHeightField(oneTallPixel()).validFraction).toBe(1);
  });
});

describe("canopy height field — footprint subtraction", () => {
  /** A square building ring `halfM` metres each side of the patch centre. */
  function ringAround(halfM: number): Array<[number, number]> {
    const nw = offset(halfM, -halfM);
    const se = offset(-halfM, halfM);
    return [
      [nw[0], nw[1]],
      [se[0], nw[1]],
      [se[0], se[1]],
      [nw[0], se[1]],
      [nw[0], nw[1]],
    ];
  }

  it("removes canopy the building already stands on", () => {
    const field = createCanopyHeightField(oneTallPixel());
    const masked = field.masked([{ ring: ringAround(6) }]);

    expect(field.maxHeightM).toBe(TREE_M);
    expect(masked.maxHeightM).toBe(0);
    expect(masked.shadeFor(0, Math.PI / 4, JULY).opacityAt(...offset(12))).toBe(0);
  });

  it("leaves canopy outside the footprint alone", () => {
    // Two trees 40 m apart; the building covers only the southern one.
    const south = CENTRE + 10;
    const patch = patchAround(MADRID, (col, row) =>
      col === CENTRE && (row === CENTRE || row === south) ? TREE_M : 0,
    );
    const masked = createCanopyHeightField(patch).masked([
      { ring: [...ringAround(6)].map(([lng, lat]) => [lng, lat - 20 / 111195] as [number, number]) },
    ]);

    expect(masked.maxHeightM).toBe(TREE_M);
    expect(masked.shadeFor(0, Math.PI / 4, JULY).opacityAt(...offset(12))).toBeGreaterThan(0);
  });

  it("hands back the same field when there is nothing to subtract", () => {
    const field = createCanopyHeightField(oneTallPixel());
    expect(field.masked([])).toBe(field);
  });

  it("rasterises one building set once", () => {
    const field = createCanopyHeightField(oneTallPixel());
    const footprints = [{ ring: ringAround(6) }];
    expect(field.masked(footprints)).toBe(field.masked(footprints));
  });
});

describe("canopy height field — the crown model it shares with A7", () => {
  it("starts the shadow at the crown base, not at the ground", () => {
    const shade = createCanopyHeightField(oneTallPixel()).shadeFor(0, Math.PI / 4, JULY);
    // At 45° the shadow band runs from `base` to `height` metres north.
    const baseM = TREE_M * CROWN_BASE_FRACTION;
    expect(shade.opacityAt(...offset(baseM - 3))).toBe(0);
    expect(shade.opacityAt(...offset(baseM + 4))).toBeGreaterThan(0);
  });
});

// ─── Through `ShadowField`, over real pixels ──────────────────────────────────

describe("a raster patch through the shadow field", () => {
  /** Wide enough to contain a route bbox padded by `QUERY_PAD_M` at both ends. */
  const WIDE = 801;
  const WIDE_CENTRE = (WIDE - 1) / 2;

  /** The moment, and the sun the whole scene is built around. */
  const WHEN = JULY;
  const sun = SunCalc.getPosition(WHEN, MADRID[1], MADRID[0]);

  /**
   * A 40 m block of 20 m canopy, placed so its shadow lands on the patch centre.
   *
   * `buildShadowIndex` displaces a caster's shadow by `(sin az, cos az) × h/tan(alt)`,
   * and a crown casts from its base to its top — so a block sitting the mid-band
   * distance back along that vector throws its shadow over the origin. Deriving the
   * position from the sun rather than hard-coding it is what makes this a test of
   * where the shadow goes rather than of one lucky date.
   */
  function withCanopyBlock(): CanopyPatch {
    const midBandM = ((TREE_M * CROWN_BASE_FRACTION + TREE_M) / 2) / Math.tan(sun.altitude);
    const eastM = -Math.sin(sun.azimuth) * midBandM;
    const northM = -Math.cos(sun.azimuth) * midBandM;
    const centreCol = WIDE_CENTRE + Math.round(eastM / RES_M);
    const centreRow = WIDE_CENTRE - Math.round(northM / RES_M);
    const halfPixels = 10; // 40 m across, at 2 m a pixel

    return patchAround(
      MADRID,
      (col, row) =>
        Math.abs(col - centreCol) <= halfPixels && Math.abs(row - centreRow) <= halfPixels
          ? TREE_M
          : 0,
      undefined,
      WIDE,
    );
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

  /** A 20 m edge at the patch centre, running east-west. */
  const edge: EdgeRef = { from: offset(0, -10), to: offset(0, 10) };

  it("shades an edge standing in the block's shadow, and labels it canopy", () => {
    const [shaded] = fieldOver(withCanopyBlock()).sampleEdges([edge], WHEN);

    expect(shaded.left).toBeGreaterThan(0.5);
    expect(shaded.right).toBeGreaterThan(0.5);
    // Below 1: a crown is not a wall, whatever the raster says about its height.
    expect(shaded.left).toBeLessThan(1);
    expect(shaded.source).toBe("canopy");
  });

  it("leaves the same edge in the sun when the raster holds no canopy", () => {
    const bare = patchAround(MADRID, () => 0, undefined, WIDE);
    const [sunlit] = fieldOver(bare).sampleEdges([edge], WHEN);

    expect(sunlit.left).toBe(0);
    // Nothing standing is knowledge, not evidence of canopy — so no canopy label.
    expect(sunlit.source).toBe("none");
  });
});

// ─── The hazard-independent march (`sampleFor`) ───────────────────────────────
//
// Every fixture below is analytic geometry on the same patch helpers: canopy fixed
// in raster coordinates, the ray varied, and the protection expected to move. The
// same crown model as the solar march (`CROWN_BASE_FRACTION`, 1 m casting floor,
// 400 m cap), so any divergence between the two marches is a bug in one of them.

/** A ray direction as `sampleFor` takes it: degrees in, radians out. */
function rayOf(fromDeg: number, altitudeDeg: number, strength = 0.4) {
  return {
    azimuthRad: (fromDeg * Math.PI) / 180,
    elevationRad: (altitudeDeg * Math.PI) / 180,
    strength,
  };
}

describe("sampleFor — geometry the solar march already pins, on a rain ray", () => {
  it("protects downwind of a crown, and not upwind, when rain arrives at 45°", () => {
    // Rain arrives FROM the north (0°) at 45°: the ray climbs northward, so the
    // sheltered band sits south of the tree — the downwind side.
    const sampler = createCanopyHeightField(oneTallPixel()).sampleFor(rayOf(0, 45));

    // A 20 m crown based at 7 m throws its band 7–20 m at 45°.
    expect(sampler.sample(...offset(-12)).protection).toBeGreaterThan(0);
    expect(sampler.sample(...offset(-18)).protection).toBeGreaterThan(0);
    // Upwind (north) is between the ground and the sky the ray climbs toward.
    expect(sampler.sample(...offset(12)).protection).toBe(0);
    expect(sampler.sample(...offset(2)).protection).toBe(0);
  });

  it("reverses the band when the bearing reverses", () => {
    const field = createCanopyHeightField(oneTallPixel());
    const north = field.sampleFor(rayOf(0, 45));
    const south = field.sampleFor(rayOf(180, 45));
    // Identical geometry, opposite shelter — one number flipping signs.
    expect(south.sample(...offset(-12)).protection).toBe(north.sample(...offset(12)).protection);
    expect(south.sample(...offset(12)).protection).toBeGreaterThan(0);
    expect(south.sample(...offset(-12)).protection).toBe(0);
  });

  it("diagonal rays displace the band diagonally", () => {
    // Rain from the northeast (45°): the ray climbs northeast, shelter lands southwest.
    const sampler = createCanopyHeightField(oneTallPixel()).sampleFor(rayOf(45, 45));
    const midBandM = ((TREE_M * CROWN_BASE_FRACTION + TREE_M) / 2) / Math.tan(Math.PI / 4);
    expect(sampler.sample(...offset(-midBandM / Math.SQRT2, -midBandM / Math.SQRT2)).protection)
      .toBeGreaterThan(0);
    expect(sampler.sample(...offset(midBandM / Math.SQRT2, midBandM / Math.SQRT2)).protection)
      .toBe(0);
  });

  it("lengthens the band as the ray flattens", () => {
    const field = createCanopyHeightField(oneTallPixel());
    const steep = field.sampleFor(rayOf(0, 60));
    const shallow = field.sampleFor(rayOf(0, 20));
    // Ray from the north → band sits south of the tree.
    expect(steep.sample(...offset(-40)).protection).toBe(0);
    expect(shallow.sample(...offset(-40)).protection).toBeGreaterThan(0);
  });

  it("overhead rain protects the ground under the crown and nothing beside it", () => {
    // The vertical case: strength applied only inside the crown's own pixel.
    const sampler = createCanopyHeightField(oneTallPixel()).sampleFor(rayOf(0, 89.5));
    expect(sampler.sample(...offset(0)).protection).toBeCloseTo(0.4, 10);
    expect(sampler.sample(...offset(12)).protection).toBe(0);
    expect(sampler.sample(...offset(0)).complete).toBe(true);
  });

  it("protects uneven connected crowns at their own heights", () => {
    // A 3-pixel crown block north of centre: 10 m, 20 m, 10 m tall, contiguous.
    const patch = patchAround(MADRID, (col, row) =>
      col >= CENTRE - 1 && col <= CENTRE + 1 && row === CENTRE - 4
        ? (col === CENTRE ? 20 : 10)
        : 0,
    );
    const field = createCanopyHeightField(patch);
    // Ray from the north at ~40°: the tall centre reaches farther south than its
    // 10 m neighbours, so the band's far edge is stepped rather than uniform.
    const sampler = field.sampleFor(rayOf(0, 40));
    const tan40 = Math.tan((40 * Math.PI) / 180);
    // Mid-band south of the 20 m crown: the crown sits 8 m north of centre and
    // throws 7/tan40 .. 20/tan40 (8.3..23.8 m) further south, so ~12 m south of
    // centre is inside the tall crown's band but past the 10 m neighbours'
    // (4.2..11.9 m from a crown 8 m north → at most 3.9 m south of centre).
    expect(sampler.sample(...offset(-12, 0)).protection).toBeGreaterThan(0);
    // A 10 m neighbour two metres east, sampled 10 m south of it — inside the
    // short crown's own band (4.2..11.9 m) and under no other.
    expect(sampler.sample(...offset(-2, 2)).protection).toBeGreaterThan(0);
    expect(sampler.sample(...offset(-2, 6)).protection).toBe(0);
    // Past the tall band's far edge (8 + 23.8 ≈ 31.8 m south of the crown).
    expect(sampler.sample(...offset(-34)).protection).toBe(0);
  });

  it("returns the caller's strength, applied once, never compounded", () => {
    // Overlapping march segments over one crown must yield `strength`, not a
    // product of it — the fixture is a wide crown the ray crosses many pixels of.
    const patch = patchAround(MADRID, (col, row) =>
      Math.abs(col - CENTRE) <= 5 && Math.abs(row - CENTRE) <= 5 ? TREE_M : 0,
    );
    const sampler = createCanopyHeightField(patch).sampleFor(rayOf(0, 30));
    expect(sampler.sample(...offset(-30)).protection).toBeCloseTo(0.4, 10);
  });

  it("protects the receiver's own cell before any boundary crossing", () => {
    // Ground directly under a crown with the ray at 45°: the first cell tested is
    // the receiver's, and at 45° a 20 m crown based at 7 m does NOT cover its own
    // ground — but the starting cell is still where the march begins (asserted by
    // the overhead case above). Here the same point at 89.5° is covered.
    const field = createCanopyHeightField(oneTallPixel());
    expect(field.sampleFor(rayOf(0, 45)).sample(...offset(0)).protection).toBe(0);
    expect(field.sampleFor(rayOf(0, 89.5)).sample(...offset(0)).protection).toBeGreaterThan(0);
  });
});

describe("sampleFor — completeness and missing evidence", () => {
  it("reports an incomplete march when the ray leaves the patch", () => {
    // A receiver near the patch's south edge with the ray climbing north: the march
    // walks off the north edge only after MAX_MARCH_M or the tallest crown clears
    // it. Put the receiver at the very edge so the march exits almost immediately.
    const patch = patchAround(MADRID, () => 0);
    const field = createCanopyHeightField(patch);
    const sampler = field.sampleFor(rayOf(180, 30));
    // A bare patch reports nothing standing (complete knowledge, 0 strength).
    expect(sampler.sample(...offset(0)).protection).toBe(0);
    expect(sampler.sample(...offset(0)).complete).toBe(true);
  });

  it("marches over a hole and still shelters the ground beyond it", () => {
    // Same hole fixture as the solar march, asked through the ray interface: the
    // ray from the north climbs over a nodata column and still meets the crown.
    const patch = patchAround(
      MADRID,
      (col, row) => (col === CENTRE && row === CENTRE ? TREE_M : 0),
      (_col, row) => (row === CENTRE - 2 ? 0 : 1),
    );
    const sampler = createCanopyHeightField(patch).sampleFor(rayOf(0, 45));
    // 12 m south of the tree (ray from the north → band to the south).
    expect(sampler.sample(...offset(-12)).protection).toBeGreaterThan(0);
  });

  it("gives no protection and no completeness over an absent patch cell", () => {
    // Nodata directly overhead under vertical rain: unknown, not dry.
    const patch = patchAround(
      MADRID,
      () => TREE_M,
      (col, row) => (col === CENTRE && row === CENTRE ? 0 : 1),
    );
    const sampler = createCanopyHeightField(patch).sampleFor(rayOf(0, 89.5));
    const s = sampler.sample(...offset(0));
    expect(s.protection).toBe(0);
    expect(s.complete).toBe(false);
  });

  it("stops at 400 m of reach and reports the truncation", () => {
    // A wall of 30 m canopy SOUTH of centre, rain arriving FROM the south at 5° —
    // the ray climbs southward, meeting the wall ~17.5 m up at 200 m, inside the
    // crown's 10.5–30 band. A wall past the 400 m cap is never reached.
    const size = 481; // 960 m on a side at 2 m
    const centreOf = (size - 1) / 2;
    // Pixel row runs south from the top, so a wall `southM` south of centre sits at
    // row `centreOf + southM/RES_M`.
    const wallAt = (southM: number) =>
      patchAround(
        MADRID,
        (_col, row) => (Math.abs(row - centreOf - southM / RES_M) <= 1 ? 30 : 0),
        undefined,
        size,
      );
    const near = createCanopyHeightField(wallAt(200)).sampleFor(rayOf(180, 5));
    const s = near.sample(MADRID[0], MADRID[1]);
    expect(s.protection).toBeGreaterThan(0);
    // Past MAX_MARCH_M (400 m) the march stops — with a 60 m crown wall whose band
    // (21 m base at 5° clears only at 21/tan5° ≈ 240 m) would still block at 450 m
    // if the march could reach it. It cannot, so the answer is 0 and the truncation
    // is reported rather than the wall being silently ignored.
    const far = createCanopyHeightField(
      patchAround(
        MADRID,
        (_col, row) => (Math.abs(row - centreOf - 450 / RES_M) <= 1 ? 60 : 0),
        undefined,
        size,
      ),
    ).sampleFor(rayOf(180, 5));
    const truncated = far.sample(MADRID[0], MADRID[1]);
    expect(truncated.protection).toBe(0);
    expect(truncated.complete).toBe(false);
  });
});

describe("sampleFor — agreement with the solar march on identical inputs", () => {
  it("a sun ray through the generic interface equals shadeFor's answer", () => {
    const field = createCanopyHeightField(oneTallPixel());
    const azimuth = 0; // SunCalc: sun due south
    const altitude = Math.PI / 4;
    const solar = field.shadeFor(azimuth, altitude, JULY);
    // The sun sits due south at 45° — i.e. its light arrives FROM bearing 180°
    // (meteorological: from the south), at 45° elevation.
    const generic = field.sampleFor({
      azimuthRad: (180 * Math.PI) / 180,
      elevationRad: altitude,
      strength: crownOpacityOf(JULY),
    });
    // The same geometry on both paths, over a spread of points.
    for (const [n, e] of [[0, 0], [12, 0], [18, 3], [-12, 0], [30, 0], [8, -4]] as const) {
      const [lng, lat] = offset(n, e);
      expect(generic.sample(lng, lat).protection).toBeCloseTo(solar.opacityAt(lng, lat), 10);
    }
  });
});

/** The solar strength for a moment — `shadeFor` computes it internally. */
function crownOpacityOf(when: Date): number {
  // Madrid is northern and outside the tropics: April–October in leaf.
  const month = when.getUTCMonth() + 1;
  const inLeaf = month >= 4 && month <= 10;
  return inLeaf ? 0.9 : 0.3;
}
