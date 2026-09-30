import maplibregl from "maplibre-gl";
import {
  BLOB_FRICTION,
  coast,
  distanceAt,
  foldAngle,
  type LineBadgePlacement,
  pointAtDistance,
  rideLength,
  snapToPath,
} from "../lib/lineBadges";
import { lineBlobElement, orientLineBlob } from "./mapPins";

/** Released faster than this (px/ms, the time slider's floor), the swelling coasts. */
const MIN_FLING_PX_MS = 0.08;
/** A coast ends below this speed (px/ms), as the time slider's does. */
const REST_PX_MS = 0.04;
/** A release this long after the last move is a stop, not a fling (the slider's cutoff). */
const STALE_MS = 80;

/** Metres per screen pixel at a latitude and zoom (512px maplibre tiles). */
function metresPerPixel(map: maplibregl.Map, lat: number): number {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export interface LineBlobOptions {
  /** Where along the ride (0–1) it last rested, so a recalculation keeps it put. */
  fraction?: number;
  /** Called with the resting fraction whenever it stops. */
  onRest: (fraction: number) => void;
}

/**
 * A transit line's swelling on its drawn ride (#149): placed by distance along
 * the ride, dragged only along it (every drag frame snaps to the nearest point
 * of the track), and flung with the time slider's inertia when let go. On a
 * ride it has not been seen on before it glides from the middle to a random
 * resting place, so it shows it can move; reduced motion leaves it mid-ride.
 */
export function attachLineBlob(
  map: maplibregl.Map,
  placement: LineBadgePlacement,
  { fraction, onRest }: LineBlobOptions,
): { remove: () => void } {
  const { coords } = placement;
  const length = rideLength(coords);
  const element = lineBlobElement(placement.line, placement.color);
  let s = (fraction ?? 0.5) * length;
  let frame: number | null = null;

  const marker = new maplibregl.Marker({ element, anchor: "center", draggable: true })
    .setLngLat(pointAtDistance(coords, s))
    .addTo(map);
  // Only the grip catches the pointer; maplibre sets the host to `auto` after each drag.
  const release = () => { element.style.pointerEvents = "none"; };
  release();

  const orient = () => {
    const step = Math.min(10, length / 2);
    const a = map.project(pointAtDistance(coords, s - step));
    const b = map.project(pointAtDistance(coords, s + step));
    orientLineBlob(element, foldAngle((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI));
  };
  const place = () => {
    marker.setLngLat(pointAtDistance(coords, s));
    orient();
  };
  const stop = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  const glide = (v0: number) => {
    stop();
    let v = v0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = coast(s, v, now - last, length);
      last = now;
      s = next.s;
      v = next.v;
      place();
      const mpp = metresPerPixel(map, marker.getLngLat().lat);
      if (next.atEnd || Math.abs(v) / mpp < REST_PX_MS) {
        frame = null;
        onRest(length > 0 ? s / length : 0.5);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  };

  // Velocity along the ride in m/ms, smoothed as the slider smooths it.
  let velocity = 0;
  let lastMove = 0;
  marker.on("dragstart", () => {
    stop();
    velocity = 0;
    lastMove = performance.now();
  });
  marker.on("drag", () => {
    const path = coords.map((c) => {
      const p = map.project(c);
      return [p.x, p.y] as [number, number];
    });
    const here = map.project(marker.getLngLat());
    const snap = snapToPath(path, [here.x, here.y]);
    if (!snap) return;
    const next = distanceAt(coords, snap.index, snap.t);
    const now = performance.now();
    const dt = now - lastMove;
    if (dt > 0 && dt < 150) velocity = velocity * 0.3 + ((next - s) / dt) * 0.7;
    lastMove = now;
    s = next;
    place();
  });
  marker.on("dragend", () => {
    release();
    const mpp = metresPerPixel(map, marker.getLngLat().lat);
    if (performance.now() - lastMove < STALE_MS && Math.abs(velocity) / mpp > MIN_FLING_PX_MS) glide(velocity);
    else onRest(length > 0 ? s / length : 0.5);
  });

  map.on("move", orient);
  orient();

  let intro: number | undefined;
  if (fraction === undefined && length > 0 && !prefersReducedMotion()) {
    // Somewhere in the middle half, but visibly away from the start point.
    const offset = (0.12 + Math.random() * 0.13) * (Math.random() < 0.5 ? -1 : 1);
    // A coast covers v0 / friction in all, so aim the launch at the resting point.
    intro = window.setTimeout(() => glide(offset * length * BLOB_FRICTION), 350);
  }

  return {
    remove: () => {
      window.clearTimeout(intro);
      stop();
      map.off("move", orient);
      marker.remove();
    },
  };
}
