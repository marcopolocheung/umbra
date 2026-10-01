import maplibregl from "maplibre-gl";
import {
  bulbFillets,
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
  weldOutline,
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
/** The weld swells over this long when the coin is gripped, and settles over the next. */
const GRIP_IN_MS = 120;
const GRIP_OUT_MS = 150;

/** Metres per screen pixel at a latitude and zoom (512px maplibre tiles). */
function metresPerPixel(map: maplibregl.Map, lat: number): number {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

type Pt = [number, number];
const pathOf = (pts: Pt[]) => `M${pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join("L")}`;

export interface LineCoinStop {
  at: [number, number];
  /** The stop's drawn radius on the map, ring included, in px. */
  radius: number;
}

export interface LineCoinOptions {
  /** Every stop drawn for the trip; the weld is cut away around them, and a resting coin keeps clear. */
  stops: LineCoinStop[];
  /** Where along the ride (0–1) it last rested, so a recalculation keeps it put. */
  fraction?: number;
  /** Called with the resting fraction whenever it stops. */
  onRest: (fraction: number) => void;
}

/**
 * A transit line's coin welded into its drawn ride (#149). It is placed by
 * distance along the ride and dragged along it: every drag frame snaps to the
 * nearest point of the track, while the pointer's pull off the line stretches
 * the coin that way on a rubber band (`MAX_PULL_PX`). The weld is redrawn every
 * frame in the line's on-screen direction — swelling when the coin is gripped,
 * drawn out toward the pull (`bulbFillets`) — cut away around stops and at the
 * ride's ends, since the map's own stops and line lie beneath any DOM overlay.
 *
 * Let go, it coasts along the ride with the time slider's inertia (plus 5%)
 * while a spring brings it back onto the line, and if it comes to rest over a
 * stop it slides just clear. A ride seen for the first time glides its coin from
 * mid-ride to a random resting place; reduced motion drops the glide, coast,
 * wobble and swelling.
 */
export function attachLineCoin(
  map: maplibregl.Map,
  placement: LineBadgePlacement,
  { stops, fraction, onRest }: LineCoinOptions,
): { remove: () => void } {
  const { coords } = placement;
  const length = rideLength(coords);
  const stopsAlong = stopDistances(coords, stops.map((st) => st.at));
  const still = prefersReducedMotion();
  const parts = lineCoinElement(placement.line, placement.color);
  const [clip, mask] = [parts.defs.children[0], parts.defs.children[1]] as [SVGClipPathElement, SVGMaskElement];
  let s = (fraction ?? 0.5) * length;
  // Along-ride velocity (m/ms); off-line offset (px) and its velocity (px/ms); grip 0–1.
  let v = 0;
  let off = { x: 0, y: 0 };
  let offV = { x: 0, y: 0 };
  let grip = 0;
  let frame: number | null = null;
  let intro: number | undefined;
  // Where a slide off a stop is headed; reached exactly, not crept up on.
  let settleTo: number | null = null;

  // Subpixel positioning: a whole-pixel marker would open a seam where the weld meets the line.
  const marker = new maplibregl.Marker({ element: parts.host, anchor: "center", draggable: true, subpixelPositioning: true })
    .setLngLat(pointAtDistance(coords, s))
    .addTo(map);
  const mpp = () => metresPerPixel(map, marker.getLngLat().lat);
  // The coin's centre relative to the line, along the line's normal on the pulled side.
  let coinAt = { x: 0, y: 0 };

  /** Lays the weld along the line as drawn on screen right now. */
  const render = () => {
    const here = pointAtDistance(coords, s);
    marker.setLngLat(here);
    const F = map.project(here);
    const step = Math.min(8 * mpp(), length / 2);
    const a = map.project(pointAtDistance(coords, s - step));
    const b = map.project(pointAtDistance(coords, s + step));
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const t: Pt = [(b.x - a.x) / len, (b.y - a.y) / len];
    let n: Pt = [-t[1], t[0]];
    if (off.x * n[0] + off.y * n[1] < 0) n = [-n[0], -n[1]];
    const c = Math.max(0, off.x * n[0] + off.y * n[1]);
    const toScreen = ([x, y]: Pt): Pt => [x * t[0] + y * n[0], x * t[1] + y * n[1]];
    const { pull, trail } = bulbFillets(c, still ? 0 : grip);
    const weld = weldOutline(c, pull, trail);
    parts.fill.setAttribute("d", `${pathOf(weld.fill.map(toScreen))}Z`);
    parts.casing.setAttribute("d", weld.edges.map((edge) => pathOf(edge.map(toScreen))).join(""));
    coinAt = { x: n[0] * c, y: n[1] * c };
    parts.disc.setAttribute("cx", coinAt.x.toFixed(2));
    parts.disc.setAttribute("cy", coinAt.y.toFixed(2));
    parts.grip.style.transform = `translate(${coinAt.x.toFixed(2)}px, ${coinAt.y.toFixed(2)}px)`;

    // Clip to the ride's extent, so the weld never pokes past its start or end;
    // the coin's own circle is kept whole.
    const toStart = s / mpp();
    const toEnd = (length - s) / mpp();
    const box = [[-toStart, -80], [toEnd, -80], [toEnd, 80], [-toStart, 80]].map((p) => toScreen(p as Pt));
    clip.innerHTML =
      `<polygon points="${box.map((p) => p.map((v2) => v2.toFixed(2)).join(",")).join(" ")}"/>` +
      `<circle cx="${coinAt.x.toFixed(2)}" cy="${coinAt.y.toFixed(2)}" r="${COIN_RADIUS + 2}"/>`;
    // Cut the weld away around nearby stops: the map's stop and line lie beneath
    // any DOM overlay, so the stop must show through rather than be painted over.
    const holes = stops
      .map((st) => ({ p: map.project(st.at), r: st.radius + 1 }))
      .filter(({ p }) => Math.hypot(p.x - F.x, p.y - F.y) < 80 + COIN_RADIUS)
      .map(({ p, r }) => `<circle cx="${(p.x - F.x).toFixed(2)}" cy="${(p.y - F.y).toFixed(2)}" r="${r}" fill="black"/>`)
      .join("");
    mask.innerHTML = `<rect x="-200" y="-200" width="400" height="400" fill="white"/>${holes}`;
  };

  const stop = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  const rest = () => onRest(length > 0 ? s / length : 0.5);

  /** Runs the coast, the spring and the grip's release together, then clears any covered stop. */
  const animate = () => {
    stop();
    if (still) {
      off = { x: 0, y: 0 };
      const clear = restingGap(s, stopsAlong, length, STOP_CLEARANCE_PX * mpp());
      if (clear !== null) s = clear;
      render();
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
      grip = Math.max(0, grip - dt / GRIP_OUT_MS);
      render();
      const coasting = !along.atEnd && Math.abs(v) / mpp() >= REST_PX_MS;
      const moving = Math.hypot(off.x, off.y) > 0.3 || Math.hypot(offV.x, offV.y) > 0.01 || grip > 0;
      if (coasting || moving) {
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
      render();
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
  let gripFrom = 0;
  // maplibre measures a grab from the marker's spot on the line, not from where a
  // pulled coin is drawn; carrying the coin's offset at the grab keeps it under the finger.
  let grabOff = { x: 0, y: 0 };
  marker.on("dragstart", () => {
    // A grab ends any coast or wobble, and the first-render glide if it has not begun.
    window.clearTimeout(intro);
    stop();
    v = 0;
    settleTo = null;
    offV = { x: 0, y: 0 };
    grabOff = { ...coinAt };
    gripFrom = performance.now() - grip * GRIP_IN_MS;
    lastMove = performance.now();
  });
  marker.on("drag", () => {
    const path = coords.map((c) => {
      const p = map.project(c);
      return [p.x, p.y] as Pt;
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
    grip = Math.min(1, (now - gripFrom) / GRIP_IN_MS);
    // The pull off the line, stretched on the rubber band.
    const onLine = map.project(pointAtDistance(coords, s));
    const [dx, dy] = [here.x - onLine.x, here.y - onLine.y];
    const pull = Math.hypot(dx, dy);
    const shown = pull > 0 ? rubberBand(pull, MAX_PULL_PX) / pull : 0;
    off = { x: dx * shown, y: dy * shown };
    render();
  });
  marker.on("dragend", () => {
    const flung = performance.now() - lastMove < STALE_MS && Math.abs(v) / mpp() > MIN_FLING_PX_MS;
    if (!flung) v = 0;
    animate();
  });

  // The weld follows the line's on-screen direction, which a rotate, tilt or zoom changes.
  map.on("move", render);
  render();

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
      map.off("move", render);
      marker.remove();
    },
  };
}
