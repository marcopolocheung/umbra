/**
 * Sidewalk-shed prisms from DOB permit points (issue #85).
 *
 * A permit is a point, and the point is not on the sidewalk: DOB geocodes it onto the
 * street centerline (measured median ~1 m from it, ~10 m from the nearest building).
 * What the point *does* carry is which side of the street it leans to — its offset
 * sign agreed with the shed's true side 92% of the time in Midtown. So each permit is
 * snapped to the nearest routing edge, its side read from that sign, and a slab placed
 * over the sidewalk line `ShadowField` samples on that side.
 *
 * The rectangles therefore sit in the model's sidewalk frame — the ±4 m lines of
 * `sidewalkOffsets` — not where the shed physically stands (real sidewalks sit 9–15 m
 * out). Placed truly, routing would never see them. A map layer drawing these shows
 * exactly that frame.
 *
 * The slab is a thin sheet just off the ground, not a roof at its real height. A real
 * shed's 2.5 m roof stays over its pavement because the building wall stands behind it;
 * this frame has no wall, so a roof at 2.5 m throws its shadow off the sample line —
 * measured on live Midtown permits it shaded the pavement under it 31% of a Sep 28
 * day and 8% of a Dec 21 one. A sheet whose shadow is its own outline shaded it
 * 99–100% in every season, touching the far sidewalk 2–3% of the time. It sits a few
 * centimetres up rather than on the ground because a grounded caster leaves its own
 * footprint lit (`shadowIndex.isShadowed`), which is exactly the pavement it covers.
 *
 * Pure: no map, no network.
 */

import { type EdgeRef, sidewalkOffsets } from "./ShadowField";
import { type BuildingPrism, type PrismSet, metersPerDegree } from "./geometry";

/** How far a permit may sit from an edge and still be snapped to it. */
const MAX_SNAP_M = 15;

/** A permit closer to the centerline than this has no readable side, and is dropped. */
const MIN_SIDE_OFFSET_M = 0.25;

/** Shed length along the street. DOB publishes none; this is a guess at a frontage. */
const SHED_LENGTH_M = 15;

/** Across-street span of the slab, from the centerline — brackets the 4 m sample line. */
const SHED_INNER_M = 2;
const SHED_OUTER_M = 6;

/** Underside and top of the sheet — off the ground, and thin enough to cast in place. */
const SHED_BASE_M = 0.05;
const SHED_HEIGHT_M = 0.1;

/** Grid cell for the edge index — edges are bucketed so a permit scans only its block. */
const GRID_M = 50;

export interface ShedPoint {
  lng: number;
  lat: number;
}

export interface ShedPlacement {
  set: PrismSet;
  placed: number;
  dropped: number;
}

export function shedPrismsFromPermits(permits: ShedPoint[], edges: EdgeRef[]): ShedPlacement {
  const prisms: BuildingPrism[] = [];
  if (permits.length === 0 || edges.length === 0) {
    return { set: { prisms, maxHeightM: 0 }, placed: 0, dropped: permits.length };
  }

  const refLat = (edges[0].from[1] + edges[0].to[1]) / 2;
  const { mPerLat, mPerLng } = metersPerDegree(refLat);
  const cellLng = GRID_M / mPerLng;
  const cellLat = GRID_M / mPerLat;
  const padLng = MAX_SNAP_M / mPerLng;
  const padLat = MAX_SNAP_M / mPerLat;

  const grid = new Map<string, number[]>();
  for (let e = 0; e < edges.length; e++) {
    const { from, to } = edges[e];
    const x0 = Math.floor((Math.min(from[0], to[0]) - padLng) / cellLng);
    const x1 = Math.floor((Math.max(from[0], to[0]) + padLng) / cellLng);
    const y0 = Math.floor((Math.min(from[1], to[1]) - padLat) / cellLat);
    const y1 = Math.floor((Math.max(from[1], to[1]) + padLat) / cellLat);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x},${y}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(e);
        else grid.set(key, [e]);
      }
    }
  }

  let dropped = 0;
  for (const permit of permits) {
    const key = `${Math.floor(permit.lng / cellLng)},${Math.floor(permit.lat / cellLat)}`;
    const candidates = grid.get(key);

    // Nearest segment, in a local metre frame centred on the permit.
    let best: { edge: EdgeRef; dist: number; px: number; py: number; ux: number; uy: number } | null =
      null;
    for (const e of candidates ?? []) {
      const edge = edges[e];
      const ax = (edge.from[0] - permit.lng) * mPerLng;
      const ay = (edge.from[1] - permit.lat) * mPerLat;
      const bx = (edge.to[0] - permit.lng) * mPerLng;
      const by = (edge.to[1] - permit.lat) * mPerLat;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-6) continue;
      const ux = (bx - ax) / len;
      const uy = (by - ay) / len;
      const t = Math.max(0, Math.min(len, -ax * ux - ay * uy));
      const px = ax + t * ux;
      const py = ay + t * uy;
      const dist = Math.hypot(px, py);
      if (dist <= MAX_SNAP_M && (!best || dist < best.dist)) best = { edge, dist, px, py, ux, uy };
    }
    if (!best) {
      dropped++;
      continue;
    }
    const { edge, px, py, ux, uy } = best;

    // Side from the offset's sign against the field's own "left", so a left-leaning
    // permit covers exactly the line `sampleEdges` walks as `left`.
    const left = sidewalkOffsets(edge).left;
    const lx = left[0] * mPerLng;
    const ly = left[1] * mPerLat;
    const leftLen = Math.hypot(lx, ly);
    const nx = lx / leftLen;
    const ny = ly / leftLen;
    const signed = -px * nx - py * ny;
    if (Math.abs(signed) < MIN_SIDE_OFFSET_M) {
      dropped++;
      continue;
    }
    const side = Math.sign(signed);

    const half = SHED_LENGTH_M / 2;
    const corner = (along: number, across: number): [number, number] => [
      permit.lng + (px + along * ux + side * across * nx) / mPerLng,
      permit.lat + (py + along * uy + side * across * ny) / mPerLat,
    ];
    const first = corner(-half, SHED_INNER_M);
    prisms.push({
      ring: [
        first,
        corner(half, SHED_INNER_M),
        corner(half, SHED_OUTER_M),
        corner(-half, SHED_OUTER_M),
        first,
      ],
      heightM: SHED_HEIGHT_M,
      baseM: SHED_BASE_M,
      opacity: 1,
    });
  }

  return {
    set: { prisms, maxHeightM: prisms.length > 0 ? SHED_HEIGHT_M : 0 },
    placed: prisms.length,
    dropped,
  };
}
