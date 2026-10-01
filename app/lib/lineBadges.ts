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
export const COIN_FRICTION = 0.009;

/**
 * One frame of a coast along a ride: exponential velocity decay (the time
 * slider's `FRICTION`), stopping dead at either end of the track.
 */
export function coast(s: number, v: number, dtMs: number, length: number): { s: number; v: number; atEnd: boolean } {
  // Exact over the frame, not Euler: the distance of v·e^(−kt) over dt, so a
  // coast covers v0/k in total however the frames happen to fall.
  const decay = Math.exp(-COIN_FRICTION * dtMs);
  const nextV = v * decay;
  const next = s + (v * (1 - decay)) / COIN_FRICTION;
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

/** [lng, lat] → local metres east/north of an origin; flat is exact enough across a ride. */
function toLocal(origin: [number, number], p: [number, number]): [number, number] {
  const toRad = Math.PI / 180;
  return [
    (p[0] - origin[0]) * toRad * Math.cos(origin[1] * toRad) * 6_371_000,
    (p[1] - origin[1]) * toRad * 6_371_000,
  ];
}

/**
 * How far along a ride each stop on it lies, in metres, ascending. Stops more
 * than `toleranceM` from the track belong to another ride and are left out.
 */
export function stopDistances(coords: [number, number][], stops: [number, number][], toleranceM = 25): number[] {
  if (coords.length === 0) return [];
  const origin = coords[0];
  const path = coords.map((c) => toLocal(origin, c));
  const out: number[] = [];
  for (const stop of stops) {
    const p = toLocal(origin, stop);
    const snap = snapToPath(path, p);
    if (!snap) continue;
    const a = path[snap.index];
    const b = path[Math.min(snap.index + 1, path.length - 1)];
    const at = [a[0] + (b[0] - a[0]) * snap.t, a[1] + (b[1] - a[1]) * snap.t];
    if (Math.hypot(p[0] - at[0], p[1] - at[1]) <= toleranceM) out.push(distanceAt(coords, snap.index, snap.t));
  }
  return out.sort((x, y) => x - y);
}

/**
 * Where a coin resting at `s` should settle so it hides no stop: `null` when no
 * stop lies within `clearance` metres, else the nearest point on the ride at
 * least `clearance` from every stop — the smallest nudge that uncovers it. `null`
 * too when no such point exists (a ride too short or dense to hold the coin
 * clear): the coin then stays where it was left.
 */
export function restingGap(s: number, stops: number[], length: number, clearance: number): number | null {
  const clear = (x: number) => stops.every((d) => Math.abs(d - x) >= clearance - 1e-6);
  if (clear(s)) return null;
  const candidates = stops
    .flatMap((d) => [d - clearance, d + clearance])
    .filter((x) => x >= 0 && x <= length && clear(x));
  if (candidates.length === 0) return null;
  return candidates.reduce((best, x) => (Math.abs(x - s) < Math.abs(best - s) ? x : best));
}

/**
 * How far off the line a pulled coin shows: it follows the pointer near the
 * line and stiffens towards `max`, never reaching it — a rubber band.
 */
export function rubberBand(distance: number, max: number): number {
  return max * Math.tanh(distance / max);
}

/** The pull-off spring: ~3 Hz, lightly damped, so a released coin wobbles twice and settles. */
const SPRING_OMEGA = 19; // rad/s
const SPRING_ZETA = 0.3;

/**
 * One frame of the spring that pulls a coin's off-line offset back to zero, per
 * axis, in px and px/ms. Integrated in ≤4 ms substeps so a slow frame cannot
 * blow it up.
 */
export function springStep(x: number, v: number, dtMs: number): { x: number; v: number } {
  let [pos, vel] = [x, v * 1000]; // px, px/s
  let remaining = Math.max(0, dtMs) / 1000;
  while (remaining > 0) {
    const h = Math.min(remaining, 0.004);
    vel += (-SPRING_OMEGA * SPRING_OMEGA * pos - 2 * SPRING_ZETA * SPRING_OMEGA * vel) * h;
    pos += vel * h;
    remaining -= h;
  }
  return { x: pos, v: vel / 1000 };
}
