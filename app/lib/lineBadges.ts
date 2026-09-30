import type { TrainDrawData } from "./trainGraph";

export interface LineBadgePlacement {
  line: string;
  color: string;
  /** The ride's whole drawn track, which its swelling sits and slides on. */
  coords: [number, number][];
}

/** Metres between two [lng, lat] points; equirectangular is exact enough across a ride. */
function metres(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180;
  const x = (b[0] - a[0]) * toRad * Math.cos(((a[1] + b[1]) / 2) * toRad);
  const y = (b[1] - a[1]) * toRad;
  return Math.hypot(x, y) * 6_371_000;
}

/**
 * The rides a map marks with their line's identifier: one per ride, not per
 * hop. `polylines` arrive one per station-to-station hop, so consecutive hops
 * on the same line are one ride; a change of line starts the next.
 */
export function lineBadgePlacements(polylines: TrainDrawData["polylines"]): LineBadgePlacement[] {
  const rides: { line: string; color: string; coords: [number, number][] }[] = [];
  for (const pl of polylines) {
    if (pl.coords.length === 0) continue;
    const last = rides[rides.length - 1];
    if (last && last.line === pl.line) last.coords.push(...pl.coords);
    else rides.push({ line: pl.line, color: pl.color, coords: [...pl.coords] });
  }
  return rides;
}

/**
 * Where on a screen-space path the point nearest `p` lies: the hop it falls on
 * and how far along that hop (0–1). `null` for an empty path. Screen space,
 * because the swelling is dragged in pixels and must follow the line as drawn,
 * pitch and all.
 */
export function snapToPath(path: [number, number][], p: [number, number]): { index: number; t: number } | null {
  if (path.length === 0) return null;
  let best = { index: 0, t: 0, d2: Number.POSITIVE_INFINITY };
  for (let i = 0; i < path.length - 1; i++) {
    const [a, b] = [path[i], path[i + 1]];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    const d2 = (p[0] - (a[0] + dx * t)) ** 2 + (p[1] - (a[1] + dy * t)) ** 2;
    if (d2 < best.d2) best = { index: i, t, d2 };
  }
  return { index: best.index, t: best.t };
}

/** Folds a direction into (−90°, 90°], so a shape laid along a line never reads upside down. */
export function foldAngle(deg: number): number {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  if (a > 90) return a - 180;
  if (a <= -90) return a + 180;
  return a;
}

/** Metres along a ride's track to vertex `index` plus `t` of the next hop. */
export function distanceAt(coords: [number, number][], index: number, t: number): number {
  let d = 0;
  for (let i = 0; i < index && i < coords.length - 1; i++) d += metres(coords[i], coords[i + 1]);
  if (index < coords.length - 1) d += metres(coords[index], coords[index + 1]) * t;
  return d;
}

export function rideLength(coords: [number, number][]): number {
  return distanceAt(coords, coords.length - 1, 0);
}

/** The [lng, lat] `s` metres along the track, clamped to its ends. */
export function pointAtDistance(coords: [number, number][], s: number): [number, number] {
  if (coords.length === 0) return [0, 0];
  let remaining = Math.max(0, s);
  for (let i = 0; i < coords.length - 1; i++) {
    const len = metres(coords[i], coords[i + 1]);
    if (remaining <= len && len > 0) {
      const t = remaining / len;
      const [a, b] = [coords[i], coords[i + 1]];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    remaining -= len;
  }
  return coords[coords.length - 1];
}

/** The timeline slider's inertia: velocity halves about every 77 ms. */
export const BLOB_FRICTION = 0.009;

/**
 * One frame of a coast along a ride: exponential velocity decay (the time
 * slider's `FRICTION`), stopping dead at either end of the track.
 */
export function coast(s: number, v: number, dtMs: number, length: number): { s: number; v: number; atEnd: boolean } {
  // Exact over the frame, not Euler: the distance of v·e^(−kt) over dt, so a
  // coast covers v0/k in total however the frames happen to fall.
  const decay = Math.exp(-BLOB_FRICTION * dtMs);
  const nextV = v * decay;
  const next = s + (v * (1 - decay)) / BLOB_FRICTION;
  if (next <= 0) return { s: 0, v: 0, atEnd: true };
  if (next >= length) return { s: length, v: 0, atEnd: true };
  return { s: next, v: nextV, atEnd: false };
}

/** Deterministic 0–1 stream from a string, so a line keeps one shape. */
function seeded(key: string): () => number {
  let h = 2166136261;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

/** Half the drawn transit line's width (`train-route-lines-layer`, 5px). */
export const LINE_HALF_WIDTH = 2.5;
/** The swelling's half-length; its necks thin to the line's own width by here. */
export const BLOB_HALF_LENGTH = 36;

/**
 * The outline of a line's swelling, as an SVG path laid along +x through the
 * origin: each side is the line's half-width plus an irregular rounded bulge,
 * so the ends taper to exactly the drawn line and the shape reads as the line
 * itself thickening. Seeded by the line's identifier: irregular, but the same
 * irregular shape for the same line every time.
 */
export function blobOutline(key: string): string {
  const rand = seeded(key);
  const side = () => ({
    amp: 9 + rand() * 3,
    centre: (rand() - 0.5) * 6,
    sigma: 12 + rand() * 3,
    k: 0.35 + rand() * 0.25,
    phase: rand() * Math.PI * 2,
  });
  const [top, bottom] = [side(), side()];
  // A cubed exponent flattens the top and shortens the shoulders: a rounded
  // swelling rather than a Gaussian's pointed spindle.
  const height = (x: number, p: ReturnType<typeof side>) =>
    LINE_HALF_WIDTH +
    p.amp * Math.exp(-(Math.abs((x - p.centre) / p.sigma) ** 3)) * (1 + 0.08 * Math.sin(p.k * x + p.phase));
  const xs: number[] = [];
  for (let x = -BLOB_HALF_LENGTH; x <= BLOB_HALF_LENGTH; x += 2) xs.push(x);
  const upper = xs.map((x) => `${x},${(-height(x, top)).toFixed(1)}`);
  const lower = [...xs].reverse().map((x) => `${x},${height(x, bottom).toFixed(1)}`);
  return `M${upper.join("L")}L${lower.join("L")}Z`;
}
