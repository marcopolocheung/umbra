import type { TrainDrawData } from "./trainGraph";

export interface LineBadgePlacement {
  line: string;
  color: string;
  /** [lng, lat] halfway along the ride, measured along the drawn track. */
  at: [number, number];
}

/** Metres between two [lng, lat] points; equirectangular is exact enough across a ride. */
function metres(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180;
  const x = (b[0] - a[0]) * toRad * Math.cos(((a[1] + b[1]) / 2) * toRad);
  const y = (b[1] - a[1]) * toRad;
  return Math.hypot(x, y) * 6_371_000;
}

function midpoint(coords: [number, number][]): [number, number] {
  const lengths = coords.slice(1).map((c, i) => metres(coords[i], c));
  let remaining = lengths.reduce((sum, l) => sum + l, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] && lengths[i] > 0) {
      const t = remaining / lengths[i];
      const [a, b] = [coords[i], coords[i + 1]];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    remaining -= lengths[i];
  }
  return coords[0];
}

/**
 * Where the map pins a line's bullet: one per ride, not per hop. `polylines`
 * arrive one per station-to-station hop, so consecutive hops on the same line
 * are one ride; a change of line starts the next. Each badge sits halfway
 * along its ride's drawn track, so it lands on the line, never off it.
 */
export function lineBadgePlacements(polylines: TrainDrawData["polylines"]): LineBadgePlacement[] {
  const rides: { line: string; color: string; coords: [number, number][] }[] = [];
  for (const pl of polylines) {
    if (pl.coords.length === 0) continue;
    const last = rides[rides.length - 1];
    if (last && last.line === pl.line) last.coords.push(...pl.coords);
    else rides.push({ line: pl.line, color: pl.color, coords: [...pl.coords] });
  }
  return rides.map((ride) => ({ line: ride.line, color: ride.color, at: midpoint(ride.coords) }));
}
