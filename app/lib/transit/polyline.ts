/**
 * Google encoded polyline decoder, precision 5 — the inverse of the wire
 * format `server/transit-prep` ships per transit edge (`geom`).
 *
 * There is no polyline codec anywhere else in the repo and no dependency that
 * provides one (`simplifyPolyline` in `routing.ts` is Ramer–Douglas–Peucker on
 * already-decoded coordinates — unrelated).
 *
 * Returns `null` on malformed input rather than throwing, unlike the
 * producer's `decodePolyline`, which must throw because `verify` depends on
 * it. A string that passes the contract regex can still be truncated, and
 * "cannot decode" collapses into the same absent-geometry state the contract
 * already defines — so the call site reads `geometry ?? chord` with no
 * try/catch and nothing silently swallowed.
 */

/** Precision-5 factor: 1.1 cm, far finer than a stop's ~8 m off-centreline. */
const FACTOR = 1e5;

/** One decoded point, as `[lng, lat]` — the order the map draws in. */
export type DecodedCoord = [number, number];

/**
 * Decodes a precision-5 encoded polyline to `[lng, lat]` pairs.
 *
 * `null` for anything that is not a well-formed encoding: the empty string, a
 * truncated tail, an out-of-charset character, or a runaway delta. Coordinates
 * are rounded to 5 dp so a decoded literal compares equal to what was encoded.
 */
export function decodePolyline(encoded: string): DecodedCoord[] | null {
  if (encoded === "") return null;
  const coords: DecodedCoord[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  const nextDelta = (): number | null => {
    let result = 0;
    let shift = 0;
    let chunk: number;
    do {
      if (index >= encoded.length) return null;
      const code = encoded.codePointAt(index);
      if (code === undefined) return null;
      chunk = code - 63;
      index += 1;
      if (chunk < 0 || chunk > 0x3f) return null;
      result |= (chunk & 0x1f) << shift;
      shift += 5;
      if (shift > 30) return null;
    } while (chunk >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < encoded.length) {
    const dLat = nextDelta();
    if (dLat === null) return null;
    const dLon = nextDelta();
    if (dLon === null) return null;
    lat += dLat;
    lon += dLon;
    const pointLat = lat / FACTOR;
    const pointLon = lon / FACTOR;
    if (!Number.isFinite(pointLat) || !Number.isFinite(pointLon)) return null;
    coords.push([pointLon, pointLat]);
  }

  return coords.length > 0 ? coords : null;
}
