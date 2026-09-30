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

/** The coin's radius in CSS px, rim included: a 31px coin inside its 44px grip. */
export const COIN_RADIUS = 14;

/**
 * The outline of a line's coin as an SVG path around the origin: a circle whose
 * radius wanders by a few percent, like a rim inked by hand. Seeded by the line's
 * identifier, so each line keeps the same edge every time.
 */
export function coinOutline(key: string, radius = COIN_RADIUS): string {
  const rand = seeded(key);
  const waves = [3, 5, 7].map((k) => ({ k, amp: 0.012 + rand() * 0.02, phase: rand() * Math.PI * 2 }));
  const points: string[] = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const r = radius * (1 + waves.reduce((sum, w) => sum + w.amp * Math.sin(w.k * a + w.phase), 0));
    points.push(`${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${points.join("L")}Z`;
}
