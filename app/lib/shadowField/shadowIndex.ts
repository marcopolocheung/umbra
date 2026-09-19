/**
 * A spatial index over prism shadows (Track A, issue #122).
 *
 * `pointInPrismShadow` rebuilt every prism's shadow polygon for every query point:
 * two earcuts and ~36 coordinate tuples per prism per point, discarded immediately.
 * Five queries could afford that. Sampling a route graph — on the order of 100k
 * points against a couple of thousand buildings — could not.
 *
 * This module does the same geometry once per (prism set, sun, projection) and
 * buckets it into a uniform grid, so a query tests a handful of candidates rather
 * than the whole city. The answer is unchanged, and deliberately so: it calls the
 * same `buildShadowTriangles`, keeps footprint exclusion as a *complete* first pass,
 * and holds vertices as float64 so nothing is rounded on the way in.
 *
 * **A caster need not stand on the ground or be opaque (A7, issues #276 and #244).**
 * A `BuildingPrism` carries a base height and an opacity, both defaulting to the
 * values every building has — 0 and 1 — so a set of buildings produces the same
 * floats it always did, vertex for vertex. What the two add is a canopy: a crown
 * starts at the top of a trunk, so its shadow is the footprint swept between the
 * base shift and the top shift rather than from the footprint itself, and it does
 * *not* occlude its own footprint — the ground under a tree is the one place its
 * shadow is certain to fall. `opacityAt` is the fractional form of `isShadowed`,
 * which stays exactly `opacityAt(...) > 0`.
 *
 * This module is pure — no map, no WebGL, no network — like `geometry.ts` beneath it.
 *
 * **Casters are prepared once and reused across sun positions (A6).** A prism's ring,
 * its bounds and its footprint bucket do not depend on where the sun is; only the
 * translation that turns the footprint into a shadow does. `prepareShadowCasters`
 * does the time-independent half once, so a time sweep pays for it once rather than
 * once per hour per sun cell. `buildShadowIndex` still takes raw prisms and behaves
 * exactly as it always did — it prepares them itself.
 *
 * **One documented divergence.** A point outside the indexed area answers `false`
 * without testing anything. The per-query path could answer `true` there, but only
 * from a zero-area triangle: at a near-horizon sun the shadow's side walls collapse
 * to a single longitude, and `pointInTriangle`'s absolute `|denom| < 1e-20` guard
 * stops catching that once the latitude span reaches ~0.09°, so it reports a point
 * hundreds of metres outside the triangle's own bounds as inside it. Inside the grid
 * the two agree exactly, degenerate slivers included, because the same predicate runs
 * over the same triangles. See #163.
 */

import earcut from "earcut";
import { type BuildingPrism, pointInTriangleXY } from "./geometry";

/**
 * The area the caller promises to stay inside.
 *
 * Structurally the same shape as `ShadowField`'s `BBox`, and declared here rather
 * than imported on purpose: `ShadowField` imports this module, and the dependency
 * must not run back the other way.
 */
export interface IndexRegion {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface ShadowIndex {
  /** Exactly `pointInPrismShadow`'s answer, for the projection this index was built with. */
  isShadowed(lng: number, lat: number): boolean;
  /**
   * How much of the direct beam is stopped here, 0–1 — the largest opacity among the
   * casters shadowing this point, or 0 if none do.
   *
   * Over an all-opaque set this is `isShadowed` with 1 and 0 for its two answers, and
   * `isShadowed` is defined as `opacityAt(...) > 0` so the two can never drift. It is
   * a maximum rather than a sum because two overlapping crowns are not twice as dark:
   * the beam is either through a canopy or it is not, and compounding two 0.9s into
   * 0.99 would claim a precision the crown model does not have.
   */
  opacityAt(lng: number, lat: number): number;
  /** Prisms that survived the region filter and were triangulated. Diagnostics and tests. */
  readonly prismCount: number;
}

/** No cell finer than this, so a dense block of small buildings cannot explode `nx·ny`. */
const MIN_CELL_M = 20;

/** No cell coarser than this, or a high sun's short shadows stop bucketing usefully. */
const MAX_CELL_M = 400;

/**
 * Cells allowed per surviving prism before the grid is coarsened.
 *
 * Tying the budget to the data rather than to a constant is what keeps a
 * single-query build (the `pointInPrismShadow` wrapper, `region = null`) from
 * allocating a five-figure cell array to answer one question.
 */
const CELLS_PER_PRISM = 16;

/** Absolute ceiling on cells, whatever the prism count says. */
const MAX_CELLS = 1e6;

/** Nothing casts a shadow here, so nothing is shadowed. Shared — it holds no state. */
const EMPTY_INDEX: ShadowIndex = {
  isShadowed: () => false,
  opacityAt: () => 0,
  prismCount: 0,
};

/** One prism that cleared phases 1 and 2, with the shadow bounds that got it there. */
interface Candidate {
  caster: Caster;
  /**
   * The two shifts phase 1 already computed; phase 3 reuses them rather than redoing
   * them. `base` is where the caster's underside projects and `top` where its top
   * does — the shadow is the footprint swept between them. For anything standing on
   * the ground the base shift is exactly zero, so the sweep starts at the footprint.
   */
  dLngBase: number;
  dLatBase: number;
  dLngTop: number;
  dLatTop: number;
  west: number;
  south: number;
  east: number;
  north: number;
}

/** One prism that can cast at all, with everything about it no sun position changes. */
interface Caster {
  /**
   * The ring flattened to `x, y` pairs, exactly as delivered — closing vertex and all.
   *
   * Flat because both hot loops read it per query: `pointInPolygonFlat` walks the
   * whole thing and the shadow emission walks its open prefix. An array of tuples
   * costs a pointer chase per vertex in the middle of a route-graph sample.
   */
  flat: Float64Array;
  /** Vertices in the *open* ring — `flat`'s prefix, without a duplicated close. */
  openCount: number;
  /**
   * `earcut` over the open ring — the near cap never moves, so it is cut once.
   *
   * Cut lazily, and that is the point: preparing a city means flattening every
   * prism, but a route's region filter typically keeps a few percent of them.
   * Earcutting all of them up front would make `sampleEdges` pay for geometry it
   * is about to discard, which is a cost the per-sun path never had.
   */
  capIndices: number[] | null;
  heightM: number;
  /** Height of the underside above ground; 0 for anything standing on it. */
  baseM: number;
  /** Share of the beam this caster stops, 0–1. 1 for anything opaque. */
  opacity: number;
  /**
   * Whether a point on this caster's own footprint is *not* shadowed by it.
   *
   * True for a building, whose roof the renderer paints lit. False for anything
   * elevated — a crown, an awning, a bridge deck — where the ground beneath is
   * precisely where the shadow lands. Issue #276.
   */
  occludesOwnFootprint: boolean;
  /** Bounds of the ring itself — the shadow's bounds before the sun shifts it. */
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * A uniform grid over *footprint* bounds, so a small region need not scan every prism.
 *
 * Distinct from the shadow grid `buildShadowIndex` builds per sun: that one buckets
 * shadows and is rebuilt whenever the sun moves, this one buckets the buildings and
 * never changes. See `castersNear` for why a footprint bucket is enough to find every
 * shadow that could reach an area.
 */
interface FootprintGrid {
  west: number;
  south: number;
  cellLng: number;
  cellLat: number;
  nx: number;
  ny: number;
  cells: Array<number[] | undefined>;
}

/** Prisms with the sun-independent half of their geometry already computed. */
export interface ShadowCasters {
  /** Prisms that can cast at all: a ring of ≥3 vertices with finite bounds. */
  readonly casters: Caster[];
  /** Largest `|heightM|`, which bounds how far any of them can throw a shadow. */
  readonly maxAbsHeightM: number;
  /** `null` below `GRID_MIN_CASTERS`, where a full scan is cheaper than a lookup. */
  readonly grid: FootprintGrid | null;
}

/** Below this a full scan beats a grid lookup, so `prepareShadowCasters` builds none. */
const GRID_MIN_CASTERS = 64;

/** Casters a footprint cell should hold on average — the grid is sized from this. */
const CASTERS_PER_FOOTPRINT_CELL = 4;

/** Ceiling on the footprint grid's side, so a sparse city cannot allocate a huge array. */
const MAX_FOOTPRINT_GRID_SIDE = 256;

/**
 * Do the half of the work that no sun position changes, once (A6).
 *
 * A prism's ring, its bounds and which footprint bucket it lands in are the same at
 * every hour; only the translation from footprint to shadow moves. Preparing them
 * once is what makes `sweep` cost far less than N separate samples — the per-sun
 * pass that remains is a handful of arithmetic per prism plus the triangulation of
 * whatever survives the region filter.
 */
export function prepareShadowCasters(
  prisms: BuildingPrism[],
  opts?: { ownFootprintOccluded?: boolean }
): ShadowCasters {
  const casters: Caster[] = [];
  let maxAbsHeightM = 0;

  for (const prism of prisms) {
    const ring = prism.ring;
    if (ring.length < 3) continue;

    let rw = Number.POSITIVE_INFINITY;
    let rs = Number.POSITIVE_INFINITY;
    let re = Number.NEGATIVE_INFINITY;
    let rn = Number.NEGATIVE_INFINITY;
    for (const [lng, lat] of ring) {
      if (lng < rw) rw = lng;
      if (lng > re) re = lng;
      if (lat < rs) rs = lat;
      if (lat > rn) rn = lat;
    }

    // A non-finite ring cannot produce a usable grid extent, and the per-query path
    // it replaces read every such point as sunlit. Dropping it here rather than per
    // sun is the same test asked once — it does not involve the sun.
    if (!Number.isFinite(rw + rs + re + rn)) continue;

    const flat = new Float64Array(ring.length * 2);
    for (let i = 0; i < ring.length; i++) {
      flat[i * 2] = ring[i][0];
      flat[i * 2 + 1] = ring[i][1];
    }
    const baseM = prism.baseM ?? 0;
    casters.push({
      flat,
      openCount: openRingLength(ring),
      capIndices: null,
      heightM: prism.heightM,
      baseM,
      opacity: prism.opacity ?? 1,
      // Rain shelter asks the inverse question of a lit roof: standing *inside*
      // a caster's footprint (an arcade, an overhang) is the dry place. The
      // optional override lets the rain path flip a grounded caster's exclusion
      // without touching one byte of the sun path's default.
      occludesOwnFootprint:
        opts?.ownFootprintOccluded ?? baseM <= 0,
      west: rw, south: rs, east: re, north: rn,
    });
    const absHeight = Math.abs(prism.heightM);
    if (absHeight > maxAbsHeightM) maxAbsHeightM = absHeight;
  }

  return { casters, maxAbsHeightM, grid: buildFootprintGrid(casters) };
}

function buildFootprintGrid(casters: Caster[]): FootprintGrid | null {
  if (casters.length < GRID_MIN_CASTERS) return null;

  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const c of casters) {
    if (c.west < west) west = c.west;
    if (c.east > east) east = c.east;
    if (c.south < south) south = c.south;
    if (c.north > north) north = c.north;
  }

  const side = Math.min(
    MAX_FOOTPRINT_GRID_SIDE,
    Math.max(1, Math.ceil(Math.sqrt(casters.length / CASTERS_PER_FOOTPRINT_CELL)))
  );
  // A zero span (every footprint on one line) would divide by zero; one cell covers it.
  const cellLng = (east - west) / side || 1;
  const cellLat = (north - south) / side || 1;

  const cells: Array<number[] | undefined> = new Array(side * side);
  for (let i = 0; i < casters.length; i++) {
    const c = casters[i];
    const x0 = cellIndex(c.west - west, cellLng, side);
    const x1 = cellIndex(c.east - west, cellLng, side);
    const y0 = cellIndex(c.south - south, cellLat, side);
    const y1 = cellIndex(c.north - south, cellLat, side);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = y * side + x;
        const bucket = cells[k];
        if (bucket === undefined) cells[k] = [i];
        else bucket.push(i);
      }
    }
  }

  return { west, south, cellLng, cellLat, nx: side, ny: side, cells };
}

/**
 * Indices of every caster whose shadow could possibly reach `region`, in prism order.
 *
 * A shadow is its footprint translated by at most `maxAbsHeightM / tan(altitude)`
 * metres, so a footprint further than that from `region` cannot reach it whatever
 * the azimuth. Expanding the region by that one radius and reading the footprint
 * grid is therefore a **conservative superset** of what the exact per-prism test
 * accepts — the caller still runs that test, so the surviving candidate list is
 * identical to a full scan's, right down to its order.
 *
 * Returns `null` for "scan everything", which is the honest answer whenever the
 * radius is not a usable finite number: a sun on the horizon, or below it.
 */
function castersNear(
  prepared: ShadowCasters,
  region: IndexRegion,
  tanAltitude: number,
  mPerLat: number,
  mPerLng: number
): number[] | null {
  const grid = prepared.grid;
  if (!grid) return null;

  const reachM = Math.abs(prepared.maxAbsHeightM / tanAltitude);
  if (!Number.isFinite(reachM)) return null;

  const padLng = reachM / mPerLng;
  const padLat = reachM / mPerLat;
  if (!Number.isFinite(padLng + padLat)) return null;

  const x0 = cellIndex(region.west - padLng - grid.west, grid.cellLng, grid.nx);
  const x1 = cellIndex(region.east + padLng - grid.west, grid.cellLng, grid.nx);
  const y0 = cellIndex(region.south - padLat - grid.south, grid.cellLat, grid.ny);
  const y1 = cellIndex(region.north + padLat - grid.south, grid.cellLat, grid.ny);

  const hits: number[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const bucket = grid.cells[y * grid.nx + x];
      // Appended one at a time rather than spread: `push(...bucket)` passes the whole
      // bucket as call arguments, and a degenerate footprint distribution — every
      // prism in one cell, which the zero-span fallback above makes reachable — would
      // throw `RangeError` on a large enough set.
      if (bucket !== undefined) for (const index of bucket) hits.push(index);
    }
  }

  // Prism order, deduplicated: a footprint spanning several cells appears once per
  // cell. Restoring the original order keeps every downstream number — the grid
  // sizing, the bucket contents — bit-identical to what a full scan produces.
  hits.sort((a, b) => a - b);
  let write = 0;
  for (let i = 0; i < hits.length; i++) {
    if (i === 0 || hits[i] !== hits[i - 1]) hits[write++] = hits[i];
  }
  hits.length = write;
  return hits;
}

/**
 * Build the shadow geometry once, then answer point queries against it.
 *
 * `mPerLat` / `mPerLng` are **passed in, not derived**: one index means one
 * projection frame, and handing over the pair the caller already computed is what
 * makes the answer identical to the per-query path it replaces.
 *
 * **Precondition — every point you will ask about must lie inside `region`.**
 * Prisms whose shadow cannot reach `region` are dropped before they are ever
 * triangulated, which is what contains the low-sun blow-up (a 20 m building at 0.5°
 * altitude "casts" 2.3 km). Query outside the region you declared and a dropped
 * prism reads as open sun. Pass `null` to keep every prism.
 */
export function buildShadowIndex(
  prisms: BuildingPrism[],
  sunAzimuth: number,
  sunAltitude: number,
  mPerLat: number,
  mPerLng: number,
  region?: IndexRegion | null
): ShadowIndex {
  return buildShadowIndexFor(
    prepareShadowCasters(prisms), sunAzimuth, sunAltitude, mPerLat, mPerLng, region
  );
}

/** `buildShadowIndex` over casters prepared once and reused across sun positions. */
export function buildShadowIndexFor(
  prepared: ShadowCasters,
  sunAzimuth: number,
  sunAltitude: number,
  mPerLat: number,
  mPerLng: number,
  region?: IndexRegion | null
): ShadowIndex {
  // ─── Phase 1: shadow bounds, no triangulation ───────────────────────────────
  // The shadow is a constant translation of the footprint, so its bounds are the
  // ring's bounds unioned with the ring's bounds shifted — computable without
  // earcutting anything. The shift is spelled exactly as `buildShadowTriangles`
  // spells it, so the bounds are the true extent of the vertices it will emit.
  // The three trig calls are hoisted out of the loop and nothing else about the
  // expression moves, so every shift is the same float it was when they were not.
  const tanAltitude = Math.tan(sunAltitude);
  const cosAzimuth = Math.cos(sunAzimuth);
  const sinAzimuth = Math.sin(sunAzimuth);

  const all = prepared.casters;
  const scan = region ? castersNear(prepared, region, tanAltitude, mPerLat, mPerLng) : null;
  const scanLength = scan ? scan.length : all.length;

  const candidates: Candidate[] = [];
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

  for (let s = 0; s < scanLength; s++) {
    const caster = all[scan ? scan[s] : s];
    const rw = caster.west;
    const rs = caster.south;
    const re = caster.east;
    const rn = caster.north;

    const topLengthM = caster.heightM / tanAltitude;
    const dLatTop = (cosAzimuth * topLengthM) / mPerLat;
    const dLngTop = (sinAzimuth * topLengthM) / mPerLng;

    // A caster standing on the ground casts from its own footprint at every sun angle,
    // so its base shift is a literal 0 rather than `0 / tanAltitude` — which is NaN for
    // a sun exactly on the horizon and would poison the finiteness test below. Spelled
    // this way, every building's bounds are the floats they were before elevated
    // casters existed, and only a crown pays for the extra arithmetic.
    const baseLengthM = caster.baseM === 0 ? 0 : caster.baseM / tanAltitude;
    const dLatBase = baseLengthM === 0 ? 0 : (cosAzimuth * baseLengthM) / mPerLat;
    const dLngBase = baseLengthM === 0 ? 0 : (sinAzimuth * baseLengthM) / mPerLng;

    // A sun on the horizon makes the shift infinite, and an infinite coordinate does
    // the same to the bounds. Either would leave the grid with a non-finite extent,
    // which the coarsening loop below can never satisfy — it would spin forever.
    // Skipping matches what the per-query path already did: every comparison against
    // a non-finite vertex is false, so the point read as sunlit. (A NaN coordinate
    // needs no guard: it loses every `<` and `>` in the ring sweep that produced
    // these bounds, so they stay finite and the prism keeps the same harmless
    // triangles it always had.)
    if (!Number.isFinite(dLatTop + dLngTop + dLatBase + dLngBase)) continue;

    // The shadow is the footprint swept from the base shift to the top shift, so its
    // bounds are the union of the two shifted rings' bounds.
    const cw = Math.min(rw + dLngBase, rw + dLngTop);
    const ce = Math.max(re + dLngBase, re + dLngTop);
    const cs = Math.min(rs + dLatBase, rs + dLatTop);
    const cn = Math.max(rn + dLatBase, rn + dLatTop);

    // ─── Phase 2: region filter ───────────────────────────────────────────────
    if (region && (cw > region.east || ce < region.west || cs > region.north || cn < region.south)) {
      continue;
    }

    candidates.push({
      caster, dLngBase, dLatBase, dLngTop, dLatTop,
      west: cw, south: cs, east: ce, north: cn,
    });
    if (cw < west) west = cw;
    if (ce > east) east = ce;
    if (cs < south) south = cs;
    if (cn > north) north = cn;
  }

  if (candidates.length === 0) return EMPTY_INDEX;

  // ─── Phase 3: triangulate the survivors, and only them ──────────────────────
  const triangles = candidates.map((c) =>
    shadowTrianglesFlat(c.caster, c.dLngBase, c.dLatBase, c.dLngTop, c.dLatTop)
  );

  // ─── The grid ───────────────────────────────────────────────────────────────
  // Sized off the objects rather than a constant: shadows grow at low sun, and a
  // fixed metre size degrades exactly where routing needs the index most.
  let spanSum = 0;
  for (const c of candidates) spanSum += Math.max(c.east - c.west, c.north - c.south);
  const meanSpanDeg = spanSum / candidates.length;

  let cellDeg = Math.min(MAX_CELL_M / mPerLat, Math.max(MIN_CELL_M / mPerLat, meanSpanDeg));
  const budget = Math.min(MAX_CELLS, Math.max(64, candidates.length * CELLS_PER_PRISM));

  let nx = 1;
  let ny = 1;
  for (;;) {
    nx = Math.max(1, Math.ceil((east - west) / cellDeg));
    ny = Math.max(1, Math.ceil((north - south) / cellDeg));
    if (nx * ny <= budget) break;
    cellDeg *= 2;
  }

  // Prism indices, not triangle indices: ~9 entries per prism (≈18k at 2,000
  // buildings) instead of ~9 per triangle (≈650k). Testing a candidate's ~36
  // triangles is free next to the earcut this eliminates.
  const cells: Array<number[] | undefined> = new Array(nx * ny);
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const x0 = cellIndex(c.west - west, cellDeg, nx);
    const x1 = cellIndex(c.east - west, cellDeg, nx);
    const y0 = cellIndex(c.south - south, cellDeg, ny);
    const y1 = cellIndex(c.north - south, cellDeg, ny);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = y * nx + x;
        const bucket = cells[k];
        if (bucket === undefined) cells[k] = [i];
        else bucket.push(i);
      }
    }
  }

  function opacityAt(lng: number, lat: number): number {
    if (lng < west || lng > east || lat < south || lat > north) return 0;

    const bucket =
      cells[cellIndex(lat - south, cellDeg, ny) * nx + cellIndex(lng - west, cellDeg, nx)];
    if (bucket === undefined) return 0;

    // Two complete passes, never interleaved. A roof is painted lit even when it
    // stands inside a taller neighbour's shadow, so every footprint in the
    // candidate set must be ruled out before any triangle is tested — interleaving
    // silently changes the answer wherever those two overlap.
    //
    // Only casters standing on the ground rule their footprint out. An elevated one
    // shadows the ground beneath it — that is where its shadow *is* — and running the
    // old unconditional pass made a tree shadow everything except the spot under it
    // (issue #276). A set of buildings takes the same branch on every caster, so its
    // answer is untouched.
    //
    // No bounds short-circuit in front of the ray cast, tempting as it looks. It
    // would be exact for a finite ring, and it is not exact for a ring carrying a
    // NaN vertex: NaN loses every comparison in the bounds sweep, so the bounds
    // exclude it while `pointInPolygonFlat` still flips parity on its edges. The
    // per-query path this index replaces cast the ray unconditionally, and matching
    // it is worth more than the ~2% the short-circuit measured.
    for (const i of bucket) {
      const caster = candidates[i].caster;
      if (caster.occludesOwnFootprint && pointInPolygonFlat(lng, lat, caster.flat)) return 0;
    }

    // The largest opacity wins, and an opaque hit ends the search — which is every
    // hit over a set of buildings, so that path still stops at the first triangle it
    // lands in, testing the same triangles in the same order it always did.
    let max = 0;
    for (const i of bucket) {
      const opacity = candidates[i].caster.opacity;
      if (opacity <= max) continue;
      if (pointInTrianglesFlat(lng, lat, triangles[i])) {
        max = opacity;
        if (max >= 1) return 1;
      }
    }
    return max;
  }

  return {
    prismCount: candidates.length,
    opacityAt,
    isShadowed(lng: number, lat: number): boolean {
      return opacityAt(lng, lat) > 0;
    },
  };
}

/**
 * `buildShadowTriangles`, emitted straight into flat `x, y` pairs.
 *
 * Same triangles, same order, same floats — pinned by a test against
 * `buildShadowTriangles` itself, because the renderer still uses that one and the
 * two must not drift. What this avoids is the *shape*: the tuple form allocates an
 * open ring, a shifted ring and ~36 two-element arrays per prism, all discarded
 * immediately, and a sweep pays that for every prism at every hour. Here the only
 * allocations are the shifted ring and the output.
 *
 * **The sweep runs between two shifts, not from the footprint (A7, issue #276).**
 * `buildShadowTriangles` sweeps a ground-standing prism from its footprint to the
 * projection of its top. A caster with an elevated underside — a tree crown above its
 * trunk — sweeps from the projection of that underside instead, which is what puts a
 * crown's shadow beside the trunk rather than around it. A ground-standing caster
 * passes `dLngBase`/`dLatBase` of 0, so its near ring *is* its footprint and every
 * emitted float is the one it always was; that is the case the parity test pins.
 *
 * The near cap is cut once in `prepareShadowCasters` and reused for those casters:
 * the footprint does not move when the sun does. An elevated caster's near ring does
 * move, so it is cut per sun, over the same flat coordinates `triangulateRing` would
 * have built. The far cap is cut per sun either way.
 *
 * Exported only so that test can exist. `shadowIndex.test.ts`'s frozen reference
 * compares the two *through* `isShadowed`, which cannot see a difference that changes
 * the triangles without changing the region they cover — and a translated ring is
 * exactly that kind of difference. Nothing in `app/` calls this.
 */
export function shadowTrianglesFlat(
  caster: Caster,
  dLngBase: number,
  dLatBase: number,
  dLngTop: number,
  dLatTop: number
): Float64Array {
  const n = caster.openCount;
  if (n < 3) return EMPTY_TRIANGLES;

  const ring = caster.flat;
  const grounded = dLngBase === 0 && dLatBase === 0;

  let near: Float64Array;
  let nearCap: number[];
  if (grounded) {
    near = ring;
    caster.capIndices ??= earcut(ring.subarray(0, n * 2), [], 2);
    nearCap = caster.capIndices;
  } else {
    near = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      near[i * 2] = ring[i * 2] + dLngBase;
      near[i * 2 + 1] = ring[i * 2 + 1] + dLatBase;
    }
    nearCap = earcut(near, [], 2);
  }

  const far = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    far[i * 2] = ring[i * 2] + dLngTop;
    far[i * 2 + 1] = ring[i * 2 + 1] + dLatTop;
  }
  const farCap = earcut(far, [], 2);

  const out = new Float64Array((6 * n + nearCap.length + farCap.length) * 2);
  let w = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ix = near[i * 2];
    const iy = near[i * 2 + 1];
    const jx = near[j * 2];
    const jy = near[j * 2 + 1];
    const six = far[i * 2];
    const siy = far[i * 2 + 1];
    const sjx = far[j * 2];
    const sjy = far[j * 2 + 1];
    // pts[i], pts[j], shifted[i] — then pts[j], shifted[j], shifted[i].
    out[w] = ix; out[w + 1] = iy;
    out[w + 2] = jx; out[w + 3] = jy;
    out[w + 4] = six; out[w + 5] = siy;
    out[w + 6] = jx; out[w + 7] = jy;
    out[w + 8] = sjx; out[w + 9] = sjy;
    out[w + 10] = six; out[w + 11] = siy;
    w += 12;
  }
  for (const index of nearCap) {
    out[w++] = near[index * 2];
    out[w++] = near[index * 2 + 1];
  }
  for (const index of farCap) {
    out[w++] = far[index * 2];
    out[w++] = far[index * 2 + 1];
  }
  return out;
}

/** A ring too short to have an interior casts nothing. Shared — it is never written. */
const EMPTY_TRIANGLES = new Float64Array(0);

/** `openRing(ring).length`, without slicing a copy to count it. */
function openRingLength(ring: [number, number][]): number {
  const last = ring.length - 1;
  const closed =
    ring.length > 1 && ring[0][0] === ring[last][0] && ring[0][1] === ring[last][1];
  return closed ? last : ring.length;
}

/** `pointInPolygon` over the flat form, arithmetic for arithmetic. */
function pointInPolygonFlat(lng: number, lat: number, ring: Float64Array): boolean {
  const n = ring.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const yi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const yj = ring[j * 2 + 1];
    const intersects =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-20) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** `pointInTriangles` over the flat form. */
function pointInTrianglesFlat(lng: number, lat: number, tris: Float64Array): boolean {
  for (let i = 0; i + 5 < tris.length; i += 6) {
    if (
      pointInTriangleXY(lng, lat, tris[i], tris[i + 1], tris[i + 2], tris[i + 3], tris[i + 4], tris[i + 5])
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Grid index for an offset from the grid's origin.
 *
 * Clamped rather than reasoned about: the grid spans the union of exactly these
 * boxes, so only floating-point `ceil` can put an index out of range. A NaN offset
 * falls through as NaN and lands on an empty bucket, which is the sunlit answer the
 * per-query path also gave.
 */
function cellIndex(offsetDeg: number, cellDeg: number, n: number): number {
  return Math.min(n - 1, Math.max(0, Math.floor(offsetDeg / cellDeg)));
}

/**
 * Is this point in the ground shadow of any prism?
 *
 * A point standing on a building's own footprint is reported as *not* shadowed:
 * the renderer paints roofs lit, and a sidewalk sample that lands on a footprint
 * is a geometry-precision artefact rather than real shadow. A prism whose `baseM`
 * lifts it off the ground is exempt — under a tree crown is where its shadow is.
 *
 * One query, one index — the same O(prisms) triangulation the per-query form always
 * did, so nothing here got slower. It lives on for the callers that genuinely ask
 * once; anything asking twice should build the index itself and keep it.
 */
export function pointInPrismShadow(
  prisms: BuildingPrism[],
  lng: number,
  lat: number,
  sunAzimuth: number,
  sunAltitude: number,
  mPerLat: number,
  mPerLng: number
): boolean {
  return buildShadowIndex(prisms, sunAzimuth, sunAltitude, mPerLat, mPerLng, null).isShadowed(lng, lat);
}
