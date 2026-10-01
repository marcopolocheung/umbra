import maplibregl from "maplibre-gl";
import {
  COIN_FRICTION,
  COIN_RADIUS,
  coast,
  distanceAt,
  type LineBadgePlacement,
  pointAtDistance,
  restingGap,
  rideLength,
  rubberBand,
  snapToPath,
  springStep,
  stopDistances,
} from "../lib/lineBadges";
import { lineCoinElement } from "./mapPins";

/** Released faster than this (px/ms, the time slider's floor), the coin coasts. */
const MIN_FLING_PX_MS = 0.08;
/** A coast ends below this speed (px/ms), as the time slider's does. */
const REST_PX_MS = 0.04;
/** A release this long after the last move is a stop, not a fling (the slider's cutoff). */
const STALE_MS = 80;
/** How far a pull can stretch the coin off its line, in px; the rubber band never reaches it. */
const MAX_PULL_PX = 12;
/** A resting coin keeps this far (px) from a stop's centre, so the stop's dot stays in sight. */
const STOP_CLEARANCE_PX = COIN_RADIUS + 10;

/** Metres per screen pixel at a latitude and zoom (512px maplibre tiles). */
function metresPerPixel(map: maplibregl.Map, lat: number): number {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export interface LineCoinOptions {
  /** Every stop drawn for the trip; the ones on this ride are the ones the coin keeps clear of. */
  stops: [number, number][];
  /** Where along the ride (0–1) it last rested, so a recalculation keeps it put. */
  fraction?: number;
  /** Called with the resting fraction whenever it stops. */
  onRest: (fraction: number) => void;
}

/**
 * A transit line's coin on its drawn ride (#149). It is placed by distance along
 * the ride and dragged along it: every drag frame snaps to the nearest point of
 * the track, while the pointer's pull off the line stretches the coin a little
 * that way on a rubber band (`MAX_PULL_PX`). Let go, it coasts along the ride
 * with the time slider's inertia while a spring wobbles it back onto the line,
 * and if it comes to rest over a stop it slides just clear, so no stop is ever
 * hidden. A ride seen for the first time glides its coin from mid-ride to a
 * random resting place; reduced motion drops the glide, coast and wobble.
 */
export function attachLineCoin(
  map: maplibregl.Map,
  placement: LineBadgePlacement,
  { stops, fraction, onRest }: LineCoinOptions,
): { remove: () => void } {
  const { coords } = placement;
  const length = rideLength(coords);
  const stopsAlong = stopDistances(coords, stops);
  const still = prefersReducedMotion();
  const element = lineCoinElement(placement.line, placement.color);
  let s = (fraction ?? 0.5) * length;
  // Along-ride velocity (m/ms); off-line offset (px) and its velocity (px/ms).
  let v = 0;
  let off = { x: 0, y: 0 };
  let offV = { x: 0, y: 0 };
  let frame: number | null = null;
  let intro: number | undefined;
  // Where a slide off a stop is headed; reached exactly, not crept up on.
  let settleTo: number | null = null;

  const marker = new maplibregl.Marker({ element, anchor: "center", draggable: true })
    .setLngLat(pointAtDistance(coords, s))
    .addTo(map);

  const place = () => {
    marker.setLngLat(pointAtDistance(coords, s));
    marker.setOffset([off.x, off.y]);
  };
  const stop = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  const mpp = () => metresPerPixel(map, marker.getLngLat().lat);
  const rest = () => onRest(length > 0 ? s / length : 0.5);

  /** Runs the coast and the spring together until both are still, then clears any covered stop. */
  const animate = () => {
    stop();
    if (still) {
      off = { x: 0, y: 0 };
      const clear = restingGap(s, stopsAlong, length, STOP_CLEARANCE_PX * mpp());
      if (clear !== null) s = clear;
      place();
      rest();
      return;
    }
    let last = performance.now();
    const tick = (now: number) => {
      // A rAF timestamp can precede the performance.now() taken when it was requested.
      const dt = Math.max(0, now - last);
      last = now;
      const along = coast(s, v, dt, length);
      s = along.s;
      v = along.v;
      const sx = springStep(off.x, offV.x, dt);
      const sy = springStep(off.y, offV.y, dt);
      off = { x: sx.x, y: sy.x };
      offV = { x: sx.v, y: sy.v };
      place();
      const coasting = !along.atEnd && Math.abs(v) / mpp() >= REST_PX_MS;
      const wobbling = Math.hypot(off.x, off.y) > 0.3 || Math.hypot(offV.x, offV.y) > 0.01;
      if (coasting || wobbling) {
        frame = requestAnimationFrame(tick);
        return;
      }
      off = { x: 0, y: 0 };
      offV = { x: 0, y: 0 };
      v = 0;
      if (settleTo !== null) {
        s = settleTo;
        settleTo = null;
      }
      place();
      const clear = restingGap(s, stopsAlong, length, STOP_CLEARANCE_PX * mpp());
      if (clear !== null) {
        // A coast covers v0 / friction in all, so aim a short slide at the clear point.
        settleTo = clear;
        v = (clear - s) * COIN_FRICTION;
        frame = requestAnimationFrame(tick);
        return;
      }
      frame = null;
      rest();
    };
    frame = requestAnimationFrame(tick);
  };

  // Along-ride velocity while dragging, smoothed as the time slider smooths its own.
  let lastMove = 0;
  // maplibre measures a grab from the marker's spot on the line, not from where a
  // wobbling coin is drawn; carrying the offset at the grab keeps it under the finger.
  let grabOff = { x: 0, y: 0 };
  marker.on("dragstart", () => {
    // A grab ends any coast or wobble, and the first-render glide if it has not begun.
    window.clearTimeout(intro);
    stop();
    v = 0;
    settleTo = null;
    offV = { x: 0, y: 0 };
    grabOff = { ...off };
    lastMove = performance.now();
  });
  marker.on("drag", () => {
    const path = coords.map((c) => {
      const p = map.project(c);
      return [p.x, p.y] as [number, number];
    });
    // maplibre has just moved the marker to follow the pointer; read where that is.
    const raw = map.project(marker.getLngLat());
    const here = { x: raw.x + grabOff.x, y: raw.y + grabOff.y };
    const snap = snapToPath(path, [here.x, here.y]);
    if (!snap) return;
    const next = distanceAt(coords, snap.index, snap.t);
    const now = performance.now();
    const dt = now - lastMove;
    if (dt > 0 && dt < 150) v = v * 0.3 + ((next - s) / dt) * 0.7;
    lastMove = now;
    s = next;
    // The pull off the line, stretched on the rubber band.
    const onLine = map.project(pointAtDistance(coords, s));
    const [dx, dy] = [here.x - onLine.x, here.y - onLine.y];
    const pull = Math.hypot(dx, dy);
    const shown = pull > 0 ? rubberBand(pull, MAX_PULL_PX) / pull : 0;
    off = { x: dx * shown, y: dy * shown };
    place();
  });
  marker.on("dragend", () => {
    const flung = performance.now() - lastMove < STALE_MS && Math.abs(v) / mpp() > MIN_FLING_PX_MS;
    if (!flung) v = 0;
    animate();
  });

  if (fraction === undefined && length > 0 && !still) {
    // Somewhere in the middle half, but visibly away from the start point.
    const target = (0.12 + Math.random() * 0.13) * (Math.random() < 0.5 ? -1 : 1);
    intro = window.setTimeout(() => {
      v = target * length * COIN_FRICTION;
      animate();
    }, 350);
  } else if (fraction === undefined) {
    // Reduced motion: no glide, but the coin still must not sit on a stop.
    animate();
  }

  return {
    remove: () => {
      window.clearTimeout(intro);
      stop();
      marker.remove();
    },
  };
}
