/**
 * Building geometry for the shadow engine (Track A).
 *
 * One normalized shape — `BuildingPrism` — assembled from either of the two
 * sources the app has: MapTiler vector-tile `building` features (what the
 * renderer draws) and Overpass `building` footprints (what works off-screen).
 * Everything downstream of this module — the WebGL shadow extrusion in
 * `LocalShadowAdapter`, the camera-free probe in `offscreenShadow`, and the
 * `ShadowField` that will sit on top of both — reads prisms, not source formats.
 *
 * This module is pure: no map, no WebGL, no network. Mercator conversion and
 * buffer packing stay in the renderer, because they are rendering concerns — except
 * `shadowShiftMercator`, the JS twin of a shader formula, kept here so it is tested.
 */

import earcut from "earcut";

/**
 * A shadow caster reduced to what casting a shadow needs: one ring, a height, and
 * — since A7 — how far off the ground it starts and how much light it stops. Rings
 * hold `[lng, lat]` pairs in degrees, exactly as the source supplied them — GeoJSON
 * and Overpass both close their rings, so consumers normalize with `openRing` rather
 * than this module rewriting the coordinates.
 *
 * Inner rings (courtyards) become their own prisms. Both existing shadow
 * implementations already treat every ring as a separate solid, and the
 * shadow of a courtyard wall is not visibly wrong at building scale.
 *
 * The name still says "building" because buildings are what every caller but
 * `canopy.ts` puts in it, and renaming it would touch the renderer, the offscreen
 * probe and four test files for no behavioural gain.
 */
export interface BuildingPrism {
  ring: [number, number][];
  heightM: number;
  /**
   * Height of the prism's *underside* above ground, in metres. Absent means 0.
   *
   * A building starts at the ground, so its shadow starts at its own footprint. A
   * tree crown does not: it starts at the top of the trunk, and its shadow is the
   * footprint swept between `baseM / tan(altitude)` and `heightM / tan(altitude)` —
   * displaced away from the trunk, and further as the sun drops. Modelling a crown
   * as a ground-to-crown solid instead would report shadow across that whole
   * displacement, which is the overstating direction A7 exists to avoid.
   *
   * It is also what decides footprint exclusion: see `shadowIndex.isShadowed`. Issue #276.
   */
  baseM?: number;
  /**
   * Share of the direct beam this prism stops, 0–1. Absent means 1 — fully opaque.
   *
   * Buildings are opaque. A canopy is not: `canopy.ts` derives this from published
   * transmittance figures and the tree's own leaf tags, which is what keeps a tree
   * from being priced as a wall.
   */
  opacity?: number;
}

/**
 * Prisms plus the tallest height among the source features they came from.
 * The renderer normalizes per-vertex height against `maxHeightM`, so it has to
 * be computed over the same set the prisms were filtered from.
 */
export interface PrismSet {
  prisms: BuildingPrism[];
  maxHeightM: number;
}

/** Fallback storey height when a tile feature only tags `building:levels`. */
export const LEVEL_HEIGHT_M = 3.1;

/** Fallback height for a tile feature with no usable height tag at all. */
export const DEFAULT_BUILDING_HEIGHT_M = 3.1;

/**
 * Above this, a `hide_3d` tile feature is dropped: MapTiler flags landmarks
 * whose modelled height is unreliable, and a wrong 100 m+ prism throws a
 * shadow across several blocks.
 */
export const TALL_BUILDING_THRESHOLD_M = 100;

/** The subset of a vector-tile / GeoJSON feature this module reads. */
export interface BuildingFeatureLike {
  properties?: Record<string, unknown> | null;
  geometry: {
    type: string;
    /** Absent on a `GeometryCollection`, which this module skips. */
    coordinates?: unknown;
  };
}

/** The subset of `overpass.ts`'s `BuildingFootprint` this module reads. */
export interface BuildingFootprintLike {
  heightM: number;
  rings: [number, number][][];
}

/**
 * Height for a MapTiler `building` feature, in metres.
 *
 * Note: `overpass.ts` derives height from raw OSM tags with slightly different
 * fallbacks (3 m storeys, 10 m default) because it sees untouched OSM data,
 * where MapTiler has already computed `render_height`. Reconciling the two is
 * an A2 decision, not a refactor — see the tracked issue.
 */
export function buildingHeightM(props: Record<string, unknown> | null | undefined): number {
  if (!props) return DEFAULT_BUILDING_HEIGHT_M;
  const renderHeight = Number(props.render_height);
  if (Number.isFinite(renderHeight) && renderHeight > 0) return renderHeight;
  const height = Number(props.height);
  if (Number.isFinite(height) && height > 0) return height;
  const levels = Number(props["building:levels"]);
  if (Number.isFinite(levels) && levels > 0) return levels * LEVEL_HEIGHT_M;
  return DEFAULT_BUILDING_HEIGHT_M;
}

/** Strips a ring's duplicated closing vertex, if it has one. */
export function openRing(ring: [number, number][]): [number, number][] {
  if (
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
  ) {
    return ring.slice(0, -1);
  }
  return ring;
}

/** Metres per degree of latitude / longitude at a given latitude. */
export function metersPerDegree(lat: number): { mPerLat: number; mPerLng: number } {
  return {
    mPerLat: 111320,
    mPerLng: Math.max(1e-6, 111320 * Math.cos((lat * Math.PI) / 180)),
  };
}

/**
 * Vector-tile `building` features → prisms.
 *
 * Underground features are dropped, unreliable tall features are dropped, and
 * the result is ordered shortest-first so the renderer's later prisms (taller,
 * darker) composite over the earlier ones.
 */
export function prismsFromTileFeatures(features: BuildingFeatureLike[]): PrismSet {
  const usable = features.filter((f) => {
    if (!f.properties) return false;
    if (f.properties.underground === "true") return false;
    if (buildingHeightM(f.properties) > TALL_BUILDING_THRESHOLD_M && f.properties.hide_3d) {
      return false;
    }
    return true;
  });

  usable.sort((a, b) => buildingHeightM(a.properties) - buildingHeightM(b.properties));

  let maxHeightM = 0;
  for (const f of usable) {
    const h = buildingHeightM(f.properties);
    if (h > maxHeightM) maxHeightM = h;
  }
  if (maxHeightM === 0) maxHeightM = 1;

  const prisms: BuildingPrism[] = [];
  for (const f of usable) {
    if (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon") continue;
    const heightM = buildingHeightM(f.properties);
    const rawRings =
      f.geometry.type === "Polygon"
        ? (f.geometry.coordinates as [number, number][][])
        : (f.geometry.coordinates as [number, number][][][]).flat(1);

    for (const ring of rawRings) {
      prisms.push({ ring, heightM });
    }
  }

  return { prisms, maxHeightM };
}

/** Overpass building footprints → prisms. Heights are already resolved upstream. */
export function prismsFromFootprints(footprints: BuildingFootprintLike[]): PrismSet {
  const prisms: BuildingPrism[] = [];
  let maxHeightM = 0;

  for (const footprint of footprints) {
    if (footprint.heightM > maxHeightM) maxHeightM = footprint.heightM;
    for (const ring of footprint.rings) {
      prisms.push({ ring, heightM: footprint.heightM });
    }
  }

  return { prisms, maxHeightM: maxHeightM === 0 ? 1 : maxHeightM };
}

/**
 * The ground shadow one prism casts, as triangles.
 *
 * Each ring edge is extruded into a quad between its original position and its
 * sun-shifted counterpart, then both the original and the shifted footprint are
 * earcut to cap the ends. Unlike a convex hull this preserves concave shapes,
 * which is what an L-shaped block's shadow actually looks like.
 *
 * Returns `[lng, lat]` points where every three form one triangle.
 *
 * `ceilingOut`, when supplied, receives one weight per emitted vertex: 1 where
 * the vertex sits under the caster's roofline and 0 at the shadow's tip. The
 * shift is a constant translation, so the ceiling height of the shadow — the
 * highest point a caster still shadows, `heightM - distance * tan(altitude)` — is
 * affine along the sweep, and interpolating these weights across a swept quad
 * reproduces it. That is what lets a wall fragment at height z ask whether it is
 * shadowed: it is, iff the interpolated ceiling exceeds z.
 *
 * **The weights are exact only once composed by taking the per-pixel maximum**,
 * which is how the renderer rasterizes them. Per triangle they are not: over the far cap the
 * true ceiling is nonzero almost everywhere, and these weights write 0 there. That
 * is a floor rather than an error, because the swept quad of whichever edge is
 * nearest against the sun always covers the same point and carries the real value,
 * and the maximum keeps it. Reuse this without maximum composition and the far
 * cap will punch holes in the field.
 */
export function buildShadowTriangles(
  ring: [number, number][],
  heightM: number,
  azimuth: number, // radians, SunCalc convention (clockwise from south)
  altitude: number, // radians above the horizon
  mPerLat: number,
  mPerLng: number,
  ceilingOut?: number[]
): [number, number][] {
  const shadowLengthM = heightM / Math.tan(altitude);
  // SunCalc's azimuth points *to* the sun; a shadow falls away from it, so the
  // footprint translation runs in the opposite direction.
  const dLat = (Math.cos(azimuth) * shadowLengthM) / mPerLat;
  const dLng = (Math.sin(azimuth) * shadowLengthM) / mPerLng;

  const pts = openRing(ring);
  if (pts.length < 3) return [];

  const shifted = pts.map(([lng, lat]) => [lng + dLng, lat + dLat] as [number, number]);
  const out: [number, number][] = [];

  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    out.push(pts[i], pts[j], shifted[i]);
    out.push(pts[j], shifted[j], shifted[i]);
    ceilingOut?.push(1, 1, 0, 1, 0, 0);
  }

  const nearCap = triangulateRing(pts);
  const farCap = triangulateRing(shifted);
  out.push(...nearCap);
  out.push(...farCap);
  for (let i = 0; i < nearCap.length; i++) ceilingOut?.push(1);
  for (let i = 0; i < farCap.length; i++) ceilingOut?.push(0);
  return out;
}

/** Earcut triangulation of an open ring, as flat triangle points. */
export function triangulateRing(ring: [number, number][]): [number, number][] {
  if (ring.length < 3) return [];

  const flat: number[] = [];
  for (const [lng, lat] of ring) flat.push(lng, lat);
  const indices = earcut(flat, [], 2);

  const out: [number, number][] = [];
  for (let i = 0; i < indices.length; i += 3) {
    out.push(ring[indices[i]], ring[indices[i + 1]], ring[indices[i + 2]]);
  }
  return out;
}

/** Is the point inside the triangle `a`, `b`, `c`, given as coordinate pairs? */
export function pointInTriangle(
  lng: number,
  lat: number,
  a: [number, number],
  b: [number, number],
  c: [number, number]
): boolean {
  return pointInTriangleXY(lng, lat, a[0], a[1], b[0], b[1], c[0], c[1]);
}

/**
 * Is the point inside the triangle `a`, `b`, `c`?
 *
 * Loose scalars rather than coordinate tuples because `shadowIndex` keeps its
 * triangles in a flat `Float64Array` and tests them in a hot loop — a build of a few
 * thousand prisms would otherwise materialize a tuple per vertex to throw it away.
 * The tuple form above delegates here, so the two cannot drift apart.
 */
export function pointInTriangleXY(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number
): boolean {
  const v0x = cx - ax;
  const v0y = cy - ay;
  const v1x = bx - ax;
  const v1y = by - ay;
  const v2x = px - ax;
  const v2y = py - ay;

  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;
  const denom = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(denom) < 1e-20) return false;

  const invDenom = 1 / denom;
  const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
  const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
  return u >= 0 && v >= 0 && u + v <= 1;
}

/** Ray-cast point-in-polygon over an `[lng, lat]` ring (closed or open). */
export function pointInPolygon(lng: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-20) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Flat vertex arrays for a sun-independent ground-shadow mesh, filled by
 * `appendShadowMesh`. The renderer's vertex shader places each vertex for the
 * current sun, so the mesh is built and uploaded once per building cache.
 */
export interface ShadowMesh {
  /** Projected x/y per vertex, before any sun shift. */
  base: number[];
  /** Metres of height to shift by per vertex: 0 at the footprint, the prism's height at the tip. */
  shiftM: number[];
  /** Normalized shadow ceiling per vertex — `buildShadowTriangles`' `ceilingOut` weights times `normalizedH`. */
  ceil: number[];
}

/**
 * Append one ground-standing prism's shadow to a sun-independent mesh.
 *
 * The triangles are `buildShadowTriangles`' in the same order: a quad per ring
 * edge, then the near cap, then the far cap. What differs is that no vertex has
 * been moved. A footprint corner carries `shiftM` 0 and a tip corner the prism's
 * height, and `shadowShiftMercator` (or its GLSL twin) moves it by that many metres
 * of height for whatever sun is current.
 *
 * The far cap reuses the near cap's triangles. `buildShadowTriangles` earcuts the
 * translated ring afresh, and floating point can make that cut different — but a
 * translated polygon covers the same region however it is cut, and the renderer
 * composes both passes by per-pixel maximum, so the pixels cannot tell.
 *
 * `ring` and `capTris` are in the caller's planar frame, as for `appendPrismMesh`;
 * the renderer passes the roof triangles it already cached rather than earcutting
 * again. Only ground-standing prisms are supported: a raised `baseM` would move the
 * near cap too, and the renderer has none.
 */
export function appendShadowMesh(
  ring: [number, number][],
  heightM: number,
  normalizedH: number,
  capTris: ArrayLike<number>,
  out: ShadowMesh
): void {
  const pts = openRing(ring);
  if (pts.length < 3) return;

  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const [ix, iy] = pts[i];
    const [jx, jy] = pts[j];
    // (i, j, i') and (j, j', i'), the order buildShadowTriangles emits.
    out.base.push(ix, iy, jx, jy, ix, iy, jx, jy, jx, jy, ix, iy);
    out.shiftM.push(0, 0, heightM, 0, heightM, heightM);
    out.ceil.push(normalizedH, normalizedH, 0, normalizedH, 0, 0);
  }

  const capVerts = Math.floor(capTris.length / 2);
  for (let cap = 0; cap < 2; cap++) {
    const shift = cap === 0 ? 0 : heightM;
    const weight = cap === 0 ? normalizedH : 0;
    for (let v = 0; v < capVerts; v++) {
      out.base.push(capTris[v * 2], capTris[v * 2 + 1]);
      out.shiftM.push(shift);
      out.ceil.push(weight);
    }
  }
}

/**
 * Per-metre sun shift in degrees, `[dLng, dLat]`: multiply by a prism's height to get
 * the offset `buildShadowTriangles` applies to its tip. `mPerLat`/`mPerLng` are the
 * renderer's, taken at the view centre, which is what keeps the two paths identical.
 */
export function shadowShiftDegPerMetre(
  azimuth: number,
  altitude: number,
  mPerLat: number,
  mPerLng: number
): [number, number] {
  const perMetre = 1 / Math.tan(altitude);
  return [(Math.sin(azimuth) * perMetre) / mPerLng, (Math.cos(azimuth) * perMetre) / mPerLat];
}

/**
 * A degree shift expressed in Web Mercator at one vertex — the JS twin of the
 * renderer's `shadowPos` GLSL, so tests can pin the formula the shader runs.
 *
 * Longitude is linear in Mercator x. Latitude is not, so the y step uses the
 * secant at the shift's midpoint latitude; over a 2.9 km shadow at a 3° sun that
 * lands within 0.06 mm of projecting the shifted corner exactly. `mercY` is the
 * vertex's absolute Mercator y (0 at the north edge of the world).
 */
export function shadowShiftMercator(mercY: number, dLngDeg: number, dLatDeg: number): [number, number] {
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * mercY)));
  const dLatRad = (dLatDeg * Math.PI) / 180;
  const latMid = lat + dLatRad / 2;
  return [dLngDeg / 360, -dLatRad / (2 * Math.PI * Math.cos(latMid))];
}

/** Flat vertex arrays for the extruded-building pass, filled by `appendPrismMesh`. */
export interface PrismMesh {
  /** Projected x/y per vertex. */
  pos: number[];
  /** Height above ground in metres per vertex. */
  heightM: number[];
  /** Outward unit normal per vertex; roofs point up. */
  normal: number[];
}

/**
 * Append one prism's walls and roof to a mesh, as triangles.
 *
 * Coordinates are whatever planar frame the caller projected into — the renderer
 * uses Mercator offset to its cache centre — and heights stay in metres so the
 * shader can scale them by the live latitude.
 *
 * Every triangle is emitted with positive signed area when seen from outside, so
 * one cull mode covers walls and roofs alike. That matters twice over: a slab seen
 * edge-on otherwise z-fights its own opposite wall, and since one of the two faces
 * the sun and the other does not, the fight shows as a grey/blue hatch.
 *
 * `roofTris` is the footprint already triangulated and projected into the same
 * frame, as flat x,y pairs — the renderer has it cached for the roof-exclusion
 * pass and passes it straight through rather than earcutting twice.
 */
export function appendPrismMesh(
  ring: [number, number][],
  heightM: number,
  roofTris: ArrayLike<number>,
  out: PrismMesh
): void {
  // Roof cap: the same triangles, lifted to the roofline and facing up.
  for (let i = 0; i + 5 < roofTris.length; i += 6) {
    const [x0, y0, x1, y1, x2, y2] = [
      roofTris[i], roofTris[i + 1], roofTris[i + 2],
      roofTris[i + 3], roofTris[i + 4], roofTris[i + 5],
    ];
    const area2 = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area2 >= 0) {
      out.pos.push(x0, y0, x1, y1, x2, y2);
    } else {
      out.pos.push(x0, y0, x2, y2, x1, y1);
    }
    out.heightM.push(heightM, heightM, heightM);
    out.normal.push(0, 0, 1, 0, 0, 1, 0, 0, 1);
  }

  const pts = openRing(ring);
  if (pts.length < 3) return;

  // Which side of an edge faces out depends on the ring's winding, and tile rings
  // come both ways round — an inner courtyard ring is wound the other way on
  // purpose. The shoelace sign settles it per ring.
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area2 += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  const winding = area2 > 0 ? 1 : -1;

  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    // Walk the edge in the direction that puts the outside on the same side for
    // every ring, so the emitted triangles wind consistently too.
    const [ax, ay] = winding > 0 ? pts[i] : pts[j];
    const [bx, by] = winding > 0 ? pts[j] : pts[i];
    const nLen = Math.hypot(by - ay, bx - ax) || 1;
    const nx = (by - ay) / nLen;
    const ny = -(bx - ax) / nLen;
    out.pos.push(ax, ay, bx, by, bx, by, ax, ay, bx, by, ax, ay);
    out.heightM.push(0, 0, heightM, 0, heightM, heightM);
    for (let k = 0; k < 6; k++) out.normal.push(nx, ny, 0);
  }
}
