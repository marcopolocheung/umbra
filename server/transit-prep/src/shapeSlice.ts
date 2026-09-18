/**
 * Cuts the piece of a GTFS shape that runs between two consecutive stops, and
 * encodes it for the wire.
 *
 * Why per-edge and not per-route: one polyline per `route:direction` cannot
 * describe a branched route (#385, and 54 of 56 subway pairs failed it). Between
 * two *adjacent* stops every pattern runs the same track — measured over 250
 * multi-shape edges per feed, the sliced length was identical across every shape
 * serving an edge, median spread 0.0 m in all seven feeds, worst 0.3 m. That is
 * what makes an edge slice well defined where a route's was not. See
 * `docs/notes/transit-edge-geometry.md`.
 *
 * `shape_dist_traveled` is absent from all seven NYC feeds, so GTFS's cheap path
 * — slice by published distance — is unavailable and each stop is projected onto
 * the shape instead. That costs nothing here: the snap is 0.0 m at the median on
 * subway, ~8 m on bus, where the stop sits at the kerb and the shape is the
 * street centreline.
 */

import { type LatLon, projectOnSegment } from "./util";

export interface ShapeSlice {
  /**
   * The shape points strictly between the two stops. Empty when both stops land
   * on the same segment, which is a real answer: there is nothing between them
   * the straight chord gets wrong.
   */
  interior: LatLon[];
  /** Distance along the shape from one stop's foot to the other's. */
  alongTrackM: number;
  /** The larger of the two stop-to-shape snap distances. */
  snapM: number;
}

interface Snap {
  /** Index of the segment's first point, so `interior` can start after it. */
  index: number;
  distM: number;
  /** Distance from the start of the shape to the foot of the perpendicular. */
  alongM: number;
}

/**
 * Nearest point on the shape to `p`, by linear scan.
 *
 * Ties go to the lowest index (the comparison is strict), so a shape that
 * touches the same place twice resolves to its first pass — which is what makes
 * the monotonicity gate below meaningful rather than arbitrary.
 */
function snapToShape(shape: LatLon[], cum: number[], p: LatLon): Snap {
  let best: Snap = { index: 0, distM: Number.POSITIVE_INFINITY, alongM: 0 };
  for (let i = 1; i < shape.length; i += 1) {
    const a = shape[i - 1] as LatLon;
    const b = shape[i] as LatLon;
    const { t, distM } = projectOnSegment(p, a, b);
    if (distM < best.distM) {
      const start = cum[i - 1] as number;
      best = { index: i - 1, distM, alongM: start + t * ((cum[i] as number) - start) };
    }
  }
  return best;
}

/**
 * The shape between `fromStop` and `toStop`, or `null` when the shape doubles
 * back and "between the stops" is not a well-defined sub-path.
 *
 * `null` is a stated fallback, not a fix: 32 of 24,354 NYC edges (0.13%) loop
 * past the same point, and the caller keeps the straight chord for those. The
 * same precedent as `changeSec` (#384) and `structure` (#411) — absence is not
 * a licence to guess.
 */
export function sliceEdge(
  shape: LatLon[],
  cum: number[],
  fromStop: LatLon,
  toStop: LatLon,
): ShapeSlice | null {
  if (shape.length < 2) return null;
  const a = snapToShape(shape, cum, fromStop);
  const b = snapToShape(shape, cum, toStop);
  if (b.index < a.index || b.alongM <= a.alongM) return null;
  return {
    interior: shape.slice(a.index + 1, b.index + 1),
    alongTrackM: b.alongM - a.alongM,
    snapM: Math.max(a.distM, b.distM),
  };
}

const PRECISION = 5;
const FACTOR = 10 ** PRECISION;

/**
 * Google encoded polyline, precision 5.
 *
 * Chosen on size, not taste: as JSON coordinate arrays at 5 dp the seven shards'
 * geometry adds 6.58 MB (+71%) to a first load that is already the open question
 * in item D; encoded it adds 1.14 MB (+12.4%). The 1.1 cm the quantisation costs
 * is far finer than the ~8 m a bus stop already sits off its own centreline.
 */
export function encodePolyline(points: LatLon[]): string {
  const out: string[] = [];
  let prevLat = 0;
  let prevLon = 0;
  for (const point of points) {
    const lat = Math.round(point.lat * FACTOR);
    const lon = Math.round(point.lon * FACTOR);
    for (const delta of [lat - prevLat, lon - prevLon]) {
      let value = delta < 0 ? ~(delta << 1) : delta << 1;
      while (value >= 0x20) {
        out.push(String.fromCharCode((0x20 | (value & 0x1f)) + 63));
        value >>>= 5;
      }
      out.push(String.fromCharCode(value + 63));
    }
    prevLat = lat;
    prevLon = lon;
  }
  return out.join("");
}

/**
 * Inverse of `encodePolyline`. Throws on a truncated or out-of-range string
 * rather than returning a short line: `verify` uses this to re-derive what was
 * published, so a decode that quietly gives up would verify nothing.
 */
export function decodePolyline(encoded: string): LatLon[] {
  const points: LatLon[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const nextDelta = (): number => {
    let result = 0;
    let shift = 0;
    let chunk: number;
    do {
      if (index >= encoded.length) throw new Error("truncated polyline");
      chunk = (encoded.codePointAt(index) as number) - 63;
      index += 1;
      if (chunk < 0 || chunk > 0x3f) throw new Error("invalid polyline character");
      result |= (chunk & 0x1f) << shift;
      shift += 5;
      if (shift > 30) throw new Error("polyline delta out of range");
    } while (chunk >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += nextDelta();
    lon += nextDelta();
    points.push({ lat: lat / FACTOR, lon: lon / FACTOR });
  }
  return points;
}
