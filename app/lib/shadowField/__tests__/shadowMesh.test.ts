/**
 * The renderer's GPU shadow mesh against `buildShadowTriangles`.
 *
 * `appendShadowMesh` builds a sun-independent mesh once; the renderer's vertex shader
 * moves each vertex with `shadowShiftMercator`'s formula. These tests run that same
 * formula in JS and compare the placed mesh with what the CPU path emits, in the
 * Mercator frame the renderer draws in — so a mistake in the mesh layout, the ceiling
 * weights or the shift formula fails here rather than as a shadow in the wrong place.
 */

import { describe, expect, it } from "vitest";
import {
  type ShadowMesh,
  appendShadowMesh,
  buildShadowTriangles,
  metersPerDegree,
  openRing,
  shadowShiftDegPerMetre,
  shadowShiftMercator,
  triangulateRing,
} from "../geometry";

const LAT = 40.754;
const LNG = -73.984;
const { mPerLat, mPerLng } = metersPerDegree(LAT);

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function toMercator(lng: number, lat: number): [number, number] {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  return [(lng + 180) / 360, 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)];
}

const SUNS = [
  { azimuth: 0, altitude: Math.PI / 4 },
  { azimuth: 1.1, altitude: 0.35 },
  { azimuth: -2.4, altitude: 0.9 },
  { azimuth: 2.9, altitude: 0.12 },
  { azimuth: -0.7, altitude: (3 * Math.PI) / 180 },
];

/** A concave star ring around a point, metres-sized, open or closed. */
function starRing(rand: () => number, closed: boolean, offsetM = 0): [number, number][] {
  const points = 5 + Math.floor(rand() * 5);
  const ring: [number, number][] = [];
  for (let v = 0; v < points; v++) {
    const angle = (v / points) * 2 * Math.PI;
    const radius = (v % 2 === 0 ? 28 : 11) * (0.7 + rand() * 0.6);
    ring.push([
      LNG + (Math.cos(angle) * radius + offsetM) / mPerLng,
      LAT + (Math.sin(angle) * radius + offsetM * 0.6) / mPerLat,
    ]);
  }
  if (closed) ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

/** The mesh for one ring, built the way the renderer builds it: Mercator, centre-relative. */
function meshFor(ring: [number, number][], heightM: number, normalizedH: number, center: [number, number]) {
  const [cx, cy] = center;
  const ringMerc = ring.map(([lng, lat]) => {
    const [x, y] = toMercator(lng, lat);
    return [x - cx, y - cy] as [number, number];
  });
  const cap: number[] = [];
  for (const [lng, lat] of triangulateRing(openRing(ring))) {
    const [x, y] = toMercator(lng, lat);
    cap.push(x - cx, y - cy);
  }
  const mesh: ShadowMesh = { base: [], shiftM: [], ceil: [] };
  appendShadowMesh(ringMerc, heightM, normalizedH, cap, mesh);
  return mesh;
}

/** Place every vertex for one sun, as the vertex shader does. */
function place(mesh: ShadowMesh, center: [number, number], sun: { azimuth: number; altitude: number }) {
  const [perLng, perLat] = shadowShiftDegPerMetre(sun.azimuth, sun.altitude, mPerLat, mPerLng);
  const out: [number, number][] = [];
  for (let v = 0; v < mesh.shiftM.length; v++) {
    const bx = mesh.base[v * 2];
    const by = mesh.base[v * 2 + 1];
    const h = mesh.shiftM[v];
    const [sx, sy] = shadowShiftMercator(by + center[1], perLng * h, perLat * h);
    out.push([bx + sx, by + sy]);
  }
  return out;
}

function triArea(a: [number, number], b: [number, number], c: [number, number]): number {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
}

/** Metres per Mercator unit at the test latitude, to state tolerances in metres. */
const M_PER_MERC = 2 * Math.PI * 6371008.8 * Math.cos((LAT * Math.PI) / 180);

describe("shadowShiftMercator", () => {
  it("matches projecting the degree-shifted point, to well under a millimetre", () => {
    let worstM = 0;
    for (const heightM of [30, 150, 400]) {
      for (const sun of SUNS) {
        for (const dLatOrigin of [-0.02, 0, 0.02]) {
          const lat = LAT + dLatOrigin;
          const [perLng, perLat] = shadowShiftDegPerMetre(sun.azimuth, sun.altitude, mPerLat, mPerLng);
          const dLng = perLng * heightM;
          const dLat = perLat * heightM;
          if (Math.hypot(dLng * mPerLng, dLat * mPerLat) > 3000) continue;
          const [bx, by] = toMercator(LNG, lat);
          const [ex, ey] = toMercator(LNG + dLng, lat + dLat);
          const [sx, sy] = shadowShiftMercator(by, dLng, dLat);
          worstM = Math.max(worstM, Math.hypot(bx + sx - ex, by + sy - ey) * M_PER_MERC);
        }
      }
    }
    expect(worstM).toBeLessThan(0.001);
  });
});

describe("appendShadowMesh", () => {
  it("places every vertex where buildShadowTriangles puts it, with the same ceilings", () => {
    const rand = rng(31337);
    const center = toMercator(LNG, LAT);
    let compared = 0;

    for (let b = 0; b < 60; b++) {
      const ring = starRing(rand, b % 2 === 0, (rand() - 0.5) * 1500);
      const heightM = 10 + rand() * 300;
      const normalizedH = heightM / 320;
      const mesh = meshFor(ring, heightM, normalizedH, center);
      const sideVerts = openRing(ring).length * 6;

      for (const sun of SUNS) {
        const ceilings: number[] = [];
        const expected = buildShadowTriangles(ring, heightM, sun.azimuth, sun.altitude, mPerLat, mPerLng, ceilings);
        const placed = place(mesh, center, sun);

        // Same vertex count: walls, near cap and a far cap of equal size.
        expect(placed.length).toBe(expected.length);

        // Walls and near cap: vertex for vertex. The far cap is checked by area below.
        const farStart = expected.length - (expected.length - sideVerts) / 2;
        for (let v = 0; v < farStart; v++) {
          const [ex, ey] = toMercator(expected[v][0], expected[v][1]);
          const errM = Math.hypot(placed[v][0] + center[0] - ex, placed[v][1] + center[1] - ey) * M_PER_MERC;
          expect(errM).toBeLessThan(0.001);
          expect(mesh.ceil[v]).toBe(normalizedH * ceilings[v]);
          compared++;
        }
        for (let v = farStart; v < expected.length; v++) {
          expect(mesh.ceil[v]).toBe(0);
          expect(ceilings[v]).toBe(0);
        }

        // Far cap: earcut may cut the translated ring differently, so compare the
        // region it covers. Triangles of one earcut never overlap, so area is additive.
        let areaPlaced = 0;
        let areaExpected = 0;
        for (let v = farStart; v < expected.length; v += 3) {
          areaPlaced += triArea(placed[v], placed[v + 1], placed[v + 2]);
          const e = [expected[v], expected[v + 1], expected[v + 2]].map(([lng, lat]) => toMercator(lng, lat));
          areaExpected += triArea(e[0] as [number, number], e[1] as [number, number], e[2] as [number, number]);
        }
        expect(Math.abs(areaPlaced - areaExpected) / areaExpected).toBeLessThan(1e-4);
      }
    }

    // Guard against a vacuous pass.
    expect(compared).toBeGreaterThan(10000);
  });

  it("adds nothing for a degenerate ring", () => {
    const mesh: ShadowMesh = { base: [], shiftM: [], ceil: [] };
    appendShadowMesh([[0, 0], [1, 1]], 20, 1, [], mesh);
    expect(mesh.base).toHaveLength(0);
  });
});
