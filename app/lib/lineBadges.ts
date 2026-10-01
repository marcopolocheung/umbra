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

/**
 * The timeline slider's inertia (0.009/ms) plus 5%, the owner's tuning for the
 * coin: velocity halves about every 73 ms, so a fling stops a little sooner.
 */
export const COIN_FRICTION = 0.00945;

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

/** The coin's radius in CSS px: a 31px coin, welded into a 5px line, inside its 44px grip. */
export const COIN_RADIUS = 15.5;
/** Half the drawn transit line's width (`train-route-lines-layer`, 5px). */
export const LINE_HALF_WIDTH = 2.5;

type Pt = [number, number];

function arc(cx: number, cy: number, r: number, a0: number, a1: number, steps: number): Pt[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = a0 + (a1 - a0) * (i / steps);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt;
  });
}

function shortTurn(a0: number, a1: number): number {
  let d = a1 - a0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a0 + d;
}

/**
 * The coin welded into its line (#149, the owner's "pressure bulb"): one outline
 * that runs along the line's edges, turns into the coin through a concave fillet
 * on each side, and rounds the coin. Line-local px: x along the line, y toward
 * the pull, the coin's centre at (0, c). `rPull`/`rTrail` are the fillet radii on
 * the pull side and the side behind.
 *
 * Each fillet is the CAD arc tangent to a line and a circle: its centre sits
 * `r` off the line's edge and `R + r` from the coin's centre, and it meets the
 * coin on the line joining the two centres. The construction holds while the
 * coin still covers both edges, `c < R − w` (13px), which the 12px rubber band
 * guarantees.
 *
 * Returns the closed `fill` outline and the two long `edges` (pull side, then
 * trail side) without the end caps across the line, which is what a keyline
 * casing strokes, so the casing never ticks across the line where the weld ends.
 */
export function weldOutline(c: number, rPull: number, rTrail: number): { fill: Pt[]; edges: [Pt[], Pt[]]; reach: number } {
  const R = COIN_RADIUS;
  const w = LINE_HALF_WIDTH;
  const lift = Math.min(Math.max(0, c), R - w - 0.3);
  const C: Pt = [0, lift];
  const sP = Math.sqrt((R + rPull) ** 2 - (w + rPull - lift) ** 2);
  const sT = Math.sqrt((R + rTrail) ** 2 - (-(w + rTrail) - lift) ** 2);
  const reach = Math.max(sP, sT) + 0.5;
  const onCoin = (F: Pt, r: number): Pt => [(R * F[0]) / (R + r), lift + (R * (F[1] - lift)) / (R + r)];
  const angle = (p: Pt, c0: Pt) => Math.atan2(p[1] - c0[1], p[0] - c0[0]);
  const fillet = (F: Pt, r: number, from: Pt, to: Pt): Pt[] => {
    const a0 = angle(from, F);
    return arc(F[0], F[1], r, a0, shortTurn(a0, angle(to, F)), 8);
  };
  const FPR: Pt = [sP, w + rPull];
  const FPL: Pt = [-sP, w + rPull];
  const FTR: Pt = [sT, -(w + rTrail)];
  const FTL: Pt = [-sT, -(w + rTrail)];
  const [PR, PL, TR, TL] = [onCoin(FPR, rPull), onCoin(FPL, rPull), onCoin(FTR, rTrail), onCoin(FTL, rTrail)];
  const aTL = angle(TL, C);
  let aTR = angle(TR, C);
  if (aTR < aTL) aTR += 2 * Math.PI;
  const aPR = angle(PR, C);
  let aPL = angle(PL, C);
  if (aPL < aPR) aPL += 2 * Math.PI;
  const trail: Pt[] = [
    [-reach, -w], [-sT, -w],
    ...fillet(FTL, rTrail, [-sT, -w], TL),
    ...arc(0, lift, R, aTL, aTR, 32),
    ...fillet(FTR, rTrail, TR, [sT, -w]),
    [reach, -w],
  ];
  const pull: Pt[] = [
    [reach, w], [sP, w],
    ...fillet(FPR, rPull, [sP, w], PR),
    ...arc(0, lift, R, aPR, aPL, 32),
    ...fillet(FPL, rPull, PL, [-sP, w]),
    [-reach, w],
  ];
  return { fill: [...trail, ...pull], edges: [pull, trail], reach };
}

/**
 * The bulb's fillet radii: 4px at rest, swelling to 8px as the coin is gripped
 * (`grip` 0→1), then stretching toward the pull — up to 12px ahead, down to 3
 * behind, at the rubber band's 12px — so the joint is drawn out like goo.
 */
export function bulbFillets(c: number, grip: number): { pull: number; trail: number } {
  const base = 4 + 4 * Math.min(1, Math.max(0, grip));
  const k = Math.min(1, Math.max(0, c) / 12);
  return { pull: base + 4 * k, trail: Math.max(2, base - 5 * k) };
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
  return stops
    .map((stop) => distanceAlong(coords, stop, toleranceM))
    .filter((d): d is number => d !== null)
    .sort((x, y) => x - y);
}

/** How far along a ride a point lies, in metres; `null` when it is more than `toleranceM` off the track. */
export function distanceAlong(coords: [number, number][], point: [number, number], toleranceM = 25): number | null {
  if (coords.length === 0) return null;
  const origin = coords[0];
  const path = coords.map((c) => toLocal(origin, c));
  const p = toLocal(origin, point);
  const snap = snapToPath(path, p);
  if (!snap) return null;
  const a = path[snap.index];
  const b = path[Math.min(snap.index + 1, path.length - 1)];
  const at = [a[0] + (b[0] - a[0]) * snap.t, a[1] + (b[1] - a[1]) * snap.t];
  return Math.hypot(p[0] - at[0], p[1] - at[1]) <= toleranceM ? distanceAt(coords, snap.index, snap.t) : null;
}

/**
 * The stretch of a ride between two distances along it, as [lng, lat] points:
 * the end points interpolated, every vertex between kept. What the coin's weld
 * is masked to, so it follows the ride as drawn and stops square at its ends.
 */
export function rideWindow(coords: [number, number][], from: number, to: number): [number, number][] {
  const length = rideLength(coords);
  const [lo, hi] = [Math.max(0, Math.min(from, to)), Math.min(length, Math.max(from, to))];
  const out: [number, number][] = [pointAtDistance(coords, lo)];
  let d = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    d += metres(coords[i], coords[i + 1]);
    if (d > lo && d < hi) out.push(coords[i + 1]);
  }
  out.push(pointAtDistance(coords, hi));
  return out;
}

/**
 * Where a ride turns sharply (more than `minTurnDeg` at a vertex), as distances
 * along it. The weld is laid straight along the line, so on such a turn its arms
 * would leave the drawn line; a resting coin keeps clear of these as of stops.
 */
export function sharpTurns(coords: [number, number][], minTurnDeg = 25): number[] {
  const out: number[] = [];
  let d = 0;
  for (let i = 1; i < coords.length - 1; i++) {
    d += metres(coords[i - 1], coords[i]);
    const [a, b, c] = [toLocal(coords[i], coords[i - 1]), [0, 0], toLocal(coords[i], coords[i + 1])];
    const inA = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const outA = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let turn = Math.abs(outA - inA);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if ((turn * 180) / Math.PI > minTurnDeg) out.push(d);
  }
  return out;
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
