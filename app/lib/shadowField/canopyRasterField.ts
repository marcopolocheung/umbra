/**
 * A8d — the canopy height raster, ray-marched against the sun.
 *
 * A8a proved the Meta/WRI canopy height map is a few hundred kilobytes from a page
 * with no server; A8b built the store two consumers read it through; A8c measured
 * that it does not read buildings as canopy. None of them changed a routing answer.
 * This is the module that does: a `CanopyPatch` in, a shadow opacity at a coordinate
 * out.
 *
 * ## Why this is not `prismsFromCanopy`
 *
 * A7 turns an OSM tree into a `BuildingPrism`, because a tagged tree is a point and a
 * prism is what `shadowIndex` already eats. A route-sized patch of raster is ~800k
 * pixels. Synthesising a prism per pixel — or per connected blob — would hand
 * `buildShadowIndex` a caster set two orders of magnitude past what it was built for,
 * and would triangulate a heightfield that never needed triangulating. A heightfield
 * is marched:
 *
 *     the point is shaded if, somewhere along the ray toward the sun, canopy stands
 *     higher than the ray does
 *
 * with `rayHeight(d) = d · tan(altitude)`. That is the whole algorithm. It costs one
 * array read per step, needs no preparation, and is exact at the raster's own
 * resolution rather than at a polygon approximation of it.
 *
 * ## Obstruction here, transmissivity in `canopy.ts`
 *
 * The raster says *"vegetation this tall"*. It never says *"this stops 90% of the
 * beam"*. That second number already exists and already has an owner — `crownOpacity`
 * — and this module calls it rather than inventing a second one. See `shadeFor`,
 * where the one deliberate choice about season is documented.
 *
 * ## The crown does not start at the ground
 *
 * `CROWN_BASE_FRACTION` is A7's, shared rather than re-picked: a crown sits on a
 * trunk, so its shadow is displaced from the trunk by `baseM / tan(altitude)` and
 * slides further as the sun drops. The march applies it as an interval test — the ray
 * is blocked over a step when the heights the ray spans there overlap the heights the
 * crown spans — which is the same sweep `buildShadowIndex` builds for an elevated
 * prism, discretised. Modelling the canopy as solid from the ground would paint shadow
 * across that whole displacement, overstating it in the direction that puts someone in
 * the sun while promising shade.
 */

import type { CanopyPatch } from "../canopyRaster/canopyTileStore";
import { lonLatToMercator } from "../canopyRaster/tiles";
import { CROWN_BASE_FRACTION, crownOpacity } from "./canopy";

/**
 * How far the march will walk before giving up, in metres.
 *
 * Shadow length is `height / tan(altitude)`, which diverges as the sun touches the
 * horizon: 30 m of canopy at 1° "casts" 1.7 km. `QUERY_PAD_M` is how far outside a
 * query `ShadowField` asks a provider to hold geometry, so a march past it is reading
 * a patch that was never fetched to answer this question. The two numbers are the same
 * number on purpose; `confidenceFor` is what docks the answer near the horizon.
 */
export const MAX_MARCH_M = 400;

/**
 * Canopy shorter than this is not canopy, in metres.
 *
 * The raster is uint8 whole metres, so `1` is the smallest value that can mean
 * anything, and at head height it is grass, a hedge or a rounding of bare ground.
 * Nothing under it is allowed to cast, which keeps a field of 1 m noise from reading
 * as continuous shade at a low sun.
 */
const MIN_CANOPY_HEIGHT_M = 1;

/** Opacity of whatever stands between a point and the sky, 0–1. `ShadowIndex` satisfies it. */
export interface CanopyShade {
  opacityAt(lng: number, lat: number): number;
}

/**
 * The direction a ray walks *back toward the sky from* a ground point, and how much
 * of the hazard the crown it meets there stops.
 *
 * A direction and a strength, deliberately nothing else: the march is the same
 * geometry whether the sky sends sunlight or rainfall, so the hazard lives entirely
 * in `strength` — `crownOpacity` for the sun, `rainOpacityForLightOpacity` for rain —
 * and the caller supplies it rather than the field guessing which question is being
 * asked. `elevationRad` is the ray's elevation above the horizon (the sun's altitude,
 * or a raindrop's fall path run backward); `azimuthRad` points the way the *hazard
 * arrives from*, the same convention SunCalc's azimuth uses for the sun.
 */
export interface CanopyRay {
  azimuthRad: number;
  elevationRad: number;
  /** Fraction of the hazard one crown stops, 0–1. Applied once per point. */
  strength: number;
}

/** The result of one directional canopy query at one point. */
export interface CanopyRaySample {
  /** Protection the canopy in ray reach provides, 0–1. */
  protection: number;
  /**
   * Whether the march completed within evidence: `false` means it left the patch or
   * the 400 m cap before the ray climbed above every crown, so the zero/`strength`
   * it returned is an under-report rather than a full answer.
   */
  complete: boolean;
}

/**
 * Rain rays for the raster canopy: the wind's `fromDeg` is the direction rain
 * arrives from, the same angle SunCalc's azimuth uses for the sun, so it feeds the
 * march verbatim (no +180° — that rotation belongs to `buildShadowIndex`, whose
 * azimuth points the way a *shadow falls*; the march points the way a *ray climbs*).
 */
export function rainRay(
  direction: { fromDeg: number; altitudeDeg: number },
  strength: number,
): CanopyRay {
  const azimuthRad = (direction.fromDeg * Math.PI) / 180;
  const elevationRad = (direction.altitudeDeg * Math.PI) / 180;
  return { azimuthRad, elevationRad, strength };
}

/** A building footprint, as `BuildingPrism` already carries one. */
export interface RingLike {
  ring: ReadonlyArray<readonly [number, number]>;
}

export interface CanopyHeightField {
  /**
   * Share of the patch the raster actually populated, 0–1.
   *
   * `CanopyPatch.valid` is `0` where the model produced no answer, which is a
   * different thing from a `0` height. A field over a half-blank patch answers
   * honestly for the half it has and reports this so the caller can dock what the
   * answer is worth.
   */
  readonly validFraction: number;
  /** Tallest canopy standing in the patch, metres. Zero means nothing here casts. */
  readonly maxHeightM: number;
  /**
   * The same field with the ground buildings occupy subtracted (A8c).
   *
   * Memoised on the footprint array's identity, the same way `ShadowField` memoises
   * prepared casters: both live providers hand back the same array until the geometry
   * actually changes, so this rasterises each (patch, building set) pair once.
   */
  masked(footprints: ReadonlyArray<RingLike>): CanopyHeightField;
  /** Canopy opacity at one sun position and one moment. */
  shadeFor(sunAzimuth: number, sunAltitude: number, when: Date): CanopyShade;
  /**
   * Canopy protection along an arbitrary ray — the hazard-independent core `shadeFor`
   * is a solar wrapper around. Any number of rays over one field re-derive nothing:
   * the traversal is per query, the geometry (heights, mask, valid) is not.
   */
  sampleFor(ray: CanopyRay): CanopyRaySampler;
}

/** Directional canopy queries at arbitrary points, for one fixed ray. */
export interface CanopyRaySampler {
  sample(lng: number, lat: number): CanopyRaySample;
}

/** Nothing stands here, so nothing is shaded. Shared — it holds no state. */
const NO_SHADE: CanopyShade = { opacityAt: () => 0 };

/**
 * A ray-marchable canopy height field over one decoded patch.
 *
 * The patch's pixels are uniform in Web Mercator and `metresPerPixel` is ground
 * metres at its centre latitude, so one pixel of travel is one `metresPerPixel` of
 * ground and the march can walk in pixel space with no per-step projection. The
 * approximation that buys — a fixed ground scale across the patch — is worth ~0.06%
 * over 5 km at Madrid's latitude, well under the raster's own 1.8 m pixel.
 */
export function createCanopyHeightField(patch: CanopyPatch): CanopyHeightField {
  return buildField(patch.heights, patch);
}

function buildField(heights: Uint8Array, patch: CanopyPatch): CanopyHeightField {
  const { valid, width, height, bbox, metresPerPixel } = patch;

  // The patch's grid comes off one square mercator frame, so `resX` and `resY` are
  // the same number — which is what lets the march step a unit vector through pixel
  // space rather than reprojecting each step.
  const [minX, minY] = lonLatToMercator(bbox[0], bbox[1]);
  const [maxX, maxY] = lonLatToMercator(bbox[2], bbox[3]);
  const resX = (maxX - minX) / width;
  const resY = (maxY - minY) / height;
  const centreLat = (bbox[1] + bbox[3]) / 2;

  let maxHeightM = 0;
  let validPixels = 0;
  for (let i = 0; i < heights.length; i++) {
    if (valid && valid[i] === 0) continue;
    validPixels += 1;
    if (heights[i] > maxHeightM) maxHeightM = heights[i];
  }
  const validFraction = heights.length === 0 ? 0 : validPixels / heights.length;

  const maskCache = new WeakMap<ReadonlyArray<RingLike>, CanopyHeightField>();

  const stepsCap = Math.max(1, Math.ceil(MAX_MARCH_M / metresPerPixel));

  /** Off the patch entirely — the march has left what was fetched and must stop. */
  const OFF_PATCH = -1;
  /**
   * Inside the patch, on a pixel the raster never populated.
   *
   * Nodata is not "no canopy". The march steps over it rather than reading a blank
   * byte as bare ground, and `validFraction` is what tells the caller how much of the
   * answer was built over holes.
   */
  const NODATA = -2;

  function heightAt(px: number, py: number): number {
    const x = Math.floor(px);
    const y = Math.floor(py);
    if (x < 0 || x >= width || y < 0 || y >= height) return OFF_PATCH;
    const i = y * width + x;
    if (valid && valid[i] === 0) return NODATA;
    return heights[i];
  }

  /**
   * The hazard-independent march, shared by `shadeFor` (sun) and `sampleFor` (any ray).
   *
   * `dirX`/`dirY` are the ray's unit direction in pixel space (x east, y south) —
   * toward whatever the sky is sending — and `tanElevation` its climb per metre of
   * ground. The exact vertical case (`tan → ∞`, or a climb that tops the patch's
   * tallest crown within the receiver's own pixel) is decided by the receiver's own
   * cell alone. Every other case walks cell boundaries with Amanatides–Woo stepping:
   * the ray crosses pixel columns and rows one at a time, and each cell's
   * entry/exit distances bound the heights the ray spans over it — which is what the
   * crown-interval test (`rayLow ≤ crown top` and `rayHigh ≥ crown base`) needs to
   * stay exact at the raster's own resolution. The receiver's starting cell is
   * tested first, before any boundary crossing.
   */
  function samplerFor(
    dirX: number,
    dirY: number,
    tanElevation: number,
    strength: number,
  ): CanopyRaySampler & { opacitySampler: CanopyShade } {
    const blocked = (canopyM: number, rayLow: number, rayHigh: number): boolean =>
      canopyM >= MIN_CANOPY_HEIGHT_M &&
      rayLow <= canopyM &&
      rayHigh >= canopyM * CROWN_BASE_FRACTION;

    // Vertical: one pixel of ground travel lifts the ray past everything standing,
    // so only the receiver's own cell can obstruct. Nodata or an off-patch receiver
    // is missing evidence, reported as such rather than as dry ground.
    if (!Number.isFinite(tanElevation) || tanElevation * metresPerPixel > maxHeightM) {
      const sample = (lng: number, lat: number): CanopyRaySample => {
        const [mx, my] = lonLatToMercator(lng, lat);
        const canopyM = heightAt((mx - minX) / resX, (maxY - my) / resY);
        if (canopyM === OFF_PATCH || canopyM === NODATA) {
          return { protection: 0, complete: false };
        }
        return { protection: blocked(canopyM, 0, Number.POSITIVE_INFINITY) ? strength : 0, complete: true };
      };
      return { sample, opacitySampler: { opacityAt: (lng, lat) => sample(lng, lat).protection } };
    }

    const sample = (lng: number, lat: number): CanopyRaySample => {
      const [mx, my] = lonLatToMercator(lng, lat);
      let px = (mx - minX) / resX;
      let py = (maxY - my) / resY;

      // Amanatides–Woo: ground metres to the next column / row boundary, and the
      // per-pixel cost of crossing each axis. Infinity on an axis the ray never crosses.
      const dPerX = dirX !== 0 ? metresPerPixel / Math.abs(dirX) : Number.POSITIVE_INFINITY;
      const dPerY = dirY !== 0 ? metresPerPixel / Math.abs(dirY) : Number.POSITIVE_INFINITY;
      let nextX = dirX > 0
        ? (Math.floor(px) + 1 - px) * dPerX
        : dirX < 0
          ? (px - Math.floor(px)) * dPerX
          : Number.POSITIVE_INFINITY;
      let nextY = dirY > 0
        ? (Math.floor(py) + 1 - py) * dPerY
        : dirY < 0
          ? (py - Math.floor(py)) * dPerY
          : Number.POSITIVE_INFINITY;
      // Ground metres at which the ray entered the cell it is now crossing.
      let dEntry = 0;
      // Whether the march stepped over a pixel the raster never populated.
      let crossedNodata = false;

      for (;;) {
        const canopyM = heightAt(px, py);
        // Off the patch is the end of the evidence, not the end of the canopy.
        // Reporting sun is the under-reporting end of that, and the provider's
        // padding is what keeps it rare.
        if (canopyM === OFF_PATCH) return { protection: 0, complete: false };

        const dExit = Math.min(nextX, nextY);
        const rayLow = dEntry * tanElevation;
        // Past the tallest crown the ray can only climb further: nothing ahead blocks.
        if (rayLow > maxHeightM) return { protection: 0, complete: !crossedNodata };
        const rayHigh = dExit * tanElevation;

        if (canopyM === NODATA) {
          // Stepped over, not read as bare ground — and remembered, so an
          // ultimately unobstructed march reports itself as built over a hole.
          crossedNodata = true;
        } else if (blocked(canopyM, rayLow, rayHigh)) {
          return { protection: strength, complete: true };
        }

        if (dExit > MAX_MARCH_M) return { protection: 0, complete: false };
        if (nextX <= nextY) {
          px += Math.sign(dirX);
          nextX += dPerX;
        } else {
          py += Math.sign(dirY);
          nextY += dPerY;
        }
        dEntry = dExit;
      }
    };
    return { sample, opacitySampler: { opacityAt: (lng, lat) => sample(lng, lat).protection } };
  }

  const field: CanopyHeightField = {
    validFraction,
    maxHeightM,

    masked(footprints) {
      const hit = maskCache.get(footprints);
      if (hit) return hit;
      const built =
        footprints.length === 0
          ? field
          : buildField(subtractFootprints(heights, patch, minX, maxY, resX, resY, footprints), patch);
      maskCache.set(footprints, built);
      return built;
    },

    shadeFor(sunAzimuth, sunAltitude, when) {
      if (maxHeightM < MIN_CANOPY_HEIGHT_M || sunAltitude <= 0) return NO_SHADE;

      /**
       * The one deliberate choice about season this checkpoint makes (#281).
       *
       * `crownOpacity` is asked about the **query** date, with no tags — exactly the
       * call A7 makes for an untagged tree, which the census says is 99.9% of them.
       * The raster's crown *extent*, though, is an observation from whatever date the
       * imagery was flown, and Madrid's is 2020-02: leaf-off, in a city of planes, so
       * its extent under-counts what a July query is asking about.
       *
       * A8d does not correct for that, and the direction matters. An under-counted
       * extent under-reports canopy shade, which is the safe direction and the one
       * this repo picks whenever a choice has one — overstating shade is what routes
       * someone into the sun on a promise. Correcting extent against the acquisition
       * date is fusion work and belongs to A8e; `acqDate.ts` already holds the dates
       * for the three corpus tiles, and #281 is where that lands.
       */
      const opacity = crownOpacity({}, when, centreLat);

      // Toward the sun: the shadow of a caster is displaced by (sin azimuth,
      // cos azimuth) — see `buildShadowIndex` — so the ray back to the sun runs the
      // other way. Pixel x runs east and pixel y runs south.
      return samplerFor(
        -Math.sin(sunAzimuth),
        Math.cos(sunAzimuth),
        Math.tan(sunAltitude),
        opacity,
      ).opacitySampler;
    },

    sampleFor(ray) {
      if (maxHeightM < MIN_CANOPY_HEIGHT_M || ray.elevationRad <= 0) {
        // Nothing standing is complete knowledge, not missing evidence.
        return { sample: () => ({ protection: 0, complete: true }) };
      }
      // A rain ray arrives from the wind bearing, so it climbs back along it — the
      // same toward-the-source idea as the sun's ray, but a different angle
      // convention: meteorological bearings run 0°=north, clockwise, whereas
      // SunCalc's azimuth runs 0°=south, westward. Toward a bearing θ is
      // (sin θ east, −cos θ north); toward a SunCalc azimuth a is
      // (−sin a east, +cos a south). The two agree at θ = a + 180°, which is the
      // same rotation `sampleRainEdges` applies to `buildShadowIndex`'s
      // shadow-falls azimuth.
      return samplerFor(
        Math.sin(ray.azimuthRad),
        -Math.cos(ray.azimuthRad),
        Math.tan(ray.elevationRad),
        ray.strength,
      );
    },
  };

  return field;
}

/**
 * Canopy heights with every pixel inside a building footprint zeroed.
 *
 * A8c settled that footprints are subtracted and measured the price: at most 17.4% of
 * apparent canopy in Madrid, 0.0–4.5% elsewhere
 * (`docs/notes/canopy-urban-confusion-2026-09-10.md`). It is principled rather than a
 * hack — canopy over a building is not shading walkable ground, because the building
 * already occupies it — and it also stops any canopy the model *did* read off a
 * structure from casting a tree-shaped shadow across the street.
 *
 * The exact footprint, with no dilation. A8c measured +1 m and +2 m dilations too and
 * they cost little more, but they also delete real crowns at every building edge, and
 * nothing measured says the extra reach buys anything.
 *
 * Even-odd scanline fill at pixel centres. Rings arrive in lon/lat and are projected
 * once per vertex, not once per scanline.
 */
function subtractFootprints(
  heights: Uint8Array,
  patch: CanopyPatch,
  minX: number,
  maxY: number,
  resX: number,
  resY: number,
  footprints: ReadonlyArray<RingLike>,
): Uint8Array {
  const { width, height } = patch;
  const out = heights.slice();
  const xs: number[] = [];

  for (const { ring } of footprints) {
    if (ring.length < 3) continue;

    // Project once; every scanline below reads these.
    const px: number[] = [];
    const py: number[] = [];
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const [lng, lat] of ring) {
      const [mx, my] = lonLatToMercator(lng, lat);
      const x = (mx - minX) / resX;
      const y = (maxY - my) / resY;
      px.push(x);
      py.push(y);
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }

    const firstRow = Math.max(0, Math.floor(top));
    const lastRow = Math.min(height - 1, Math.ceil(bottom));

    for (let row = firstRow; row <= lastRow; row++) {
      const scanY = row + 0.5;
      xs.length = 0;
      for (let i = 0, j = px.length - 1; i < px.length; j = i++) {
        const yi = py[i];
        const yj = py[j];
        if (yi > scanY === yj > scanY) continue;
        xs.push(px[i] + ((scanY - yi) / (yj - yi)) * (px[j] - px[i]));
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);

      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil(xs[k] - 0.5));
        const to = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));
        out.fill(0, row * width + from, row * width + to + 1);
      }
    }
  }

  return out;
}
