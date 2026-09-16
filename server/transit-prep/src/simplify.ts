/**
 * Douglas-Peucker polyline simplification in metres (equirectangular
 * projection — fine for city-scale shapes) plus a point-count cap.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

function perpendicularMeters(point: LatLon, start: LatLon, end: LatLon): number {
  // Project to metres around the segment midpoint; distortion over a few km
  // is far below the simplification epsilon.
  const lat0 = ((start.lat + end.lat) / 2) * (Math.PI / 180);
  const kx = 111320 * Math.cos(lat0);
  const ky = 110540;
  const ax = (start.lon - point.lon) * kx;
  const ay = (start.lat - point.lat) * ky;
  const bx = (end.lon - point.lon) * kx;
  const by = (end.lat - point.lat) * ky;
  const cross = Math.abs(ax * by - ay * bx);
  const base = Math.hypot((end.lon - start.lon) * kx, (end.lat - start.lat) * ky);
  if (base === 0) return Math.hypot(ax, ay);
  return cross / base;
}

export function simplifyPath(points: LatLon[], epsilonM: number): LatLon[] {
  if (points.length <= 2) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    let maxDist = 0;
    let maxIndex = -1;
    for (let i = first + 1; i < last; i += 1) {
      const dist = perpendicularMeters(
        points[i] as LatLon,
        points[first] as LatLon,
        points[last] as LatLon,
      );
      if (dist > maxDist) {
        maxDist = dist;
        maxIndex = i;
      }
    }
    if (maxIndex >= 0 && maxDist > epsilonM) {
      keep[maxIndex] = true;
      stack.push([first, maxIndex], [maxIndex, last]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

/** Simplify, then stride-sample down to maxPoints (endpoints preserved). */
export function simplifyCapped(points: LatLon[], epsilonM: number, maxPoints: number): LatLon[] {
  const simple = simplifyPath(points, epsilonM);
  if (simple.length <= maxPoints) return simple;
  const stride = (simple.length - 1) / (maxPoints - 1);
  const capped: LatLon[] = [];
  for (let i = 0; i < maxPoints; i += 1) {
    capped.push(simple[Math.round(i * stride)] as LatLon);
  }
  return capped;
}
