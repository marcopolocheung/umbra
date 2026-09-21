import { toMapLocal } from "./timezone";
import { parseTravelMode } from "./travelMode";
import type { TravelModeId } from "./travelMode";
import type { ExposureObjective, WindSource, ManualWind } from "./exposure";

export type LngLat = [number, number];
export type MapCenterLatLng = [number, number];

export interface ParsedShareState {
  center: LngLat | null;
  zoom: number | null;
  date: Date | null;
  waypointA: LngLat | null;
  waypointB: LngLat | null;
  additionalWaypoints: LngLat[];
  /** Dwell minutes positional over [A, ...via, B]; [] when the link has none. */
  dwell: number[];
  travelMode: TravelModeId;
  objective: ExposureObjective;
  windSource: WindSource;
  manualWind: ManualWind;
}

export interface ShareStateInput {
  mapCenter: MapCenterLatLng | null;
  mapZoom: number;
  date: Date;
  utcOffsetMin: number;
  waypointA: LngLat | null;
  waypointB: LngLat | null;
  additionalWaypoints: LngLat[];
  /** Dwell minutes positional over [A, ...via, B]. All-zero/omitted stays unwritten. */
  dwellMinutes?: number[];
  travelMode: TravelModeId;
  objective?: ExposureObjective;
  windSource?: WindSource;
  manualWind?: Partial<ManualWind>;
}

const COORD_PRECISION = 5;
const ZOOM_PRECISION = 2;

function finiteNum(raw: string | null): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function validLat(lat: number): boolean {
  return lat >= -90 && lat <= 90;
}

function validLng(lng: number): boolean {
  return lng >= -180 && lng <= 180;
}

function parseCoord(raw: string | null): LngLat | null {
  if (!raw) return null;
  const [lngRaw, latRaw] = raw.split(",");
  const lng = finiteNum(lngRaw ?? null);
  const lat = finiteNum(latRaw ?? null);
  if (lng == null || lat == null || !validLng(lng) || !validLat(lat)) return null;
  return [lng, lat];
}

function normalizeDirection(value: number): number {
  return ((value % 360) + 360) % 360;
}

function formatCoord(coord: LngLat): string {
  return `${coord[0].toFixed(COORD_PRECISION)},${coord[1].toFixed(COORD_PRECISION)}`;
}

function parseLocalDate(params: URLSearchParams, utcOffsetMin: number): Date | null {
  const date = params.get("date");
  const time = params.get("time") ?? "12:00";
  const m = date?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const t = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || !t) return null;

  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const hours = Number(t[1]);
  const minutes = Number(t[2]);
  if (month < 0 || month > 11 || day < 1 || day > 31 || hours > 23 || minutes > 59) {
    return null;
  }

  return new Date(Date.UTC(year, month, day, hours, minutes) - utcOffsetMin * 60000);
}

export function parseShareState(search: string, utcOffsetMin: number): ParsedShareState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const lat = finiteNum(params.get("lat"));
  const lng = finiteNum(params.get("lng"));
  const zoom = finiteNum(params.get("z"));
  const center = lat != null && lng != null && validLat(lat) && validLng(lng) ? [lng, lat] as LngLat : null;
  const additionalWaypoints = (params.get("via") ?? "")
    .split(";")
    .map((s) => parseCoord(s))
    .filter((coord): coord is LngLat => coord != null);
  const dwell = (params.get("dwell") ?? "")
    .split(",")
    .filter((s) => s.trim() !== "")
    .map((s) => {
      const n = Number(s);
      return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    });

  return {
    center,
    zoom: zoom != null && zoom >= 0 && zoom <= 24 ? zoom : null,
    date: parseLocalDate(params, utcOffsetMin),
    waypointA: parseCoord(params.get("a")),
    waypointB: parseCoord(params.get("b")),
    additionalWaypoints,
    dwell,
    travelMode: parseTravelMode(params.get("mode")),
    objective: params.get("objective") === "rain" ? "rain" : "sun",
    windSource: params.get("wind") === "manual" ? "manual" : "forecast",
    manualWind: {
      directionDeg: normalizeDirection(Number.isFinite(Number(params.get("windDir"))) ? Number(params.get("windDir")) : 0),
      speedMps: Math.max(0, Number.isFinite(Number(params.get("windSpeed"))) ? Number(params.get("windSpeed")) : 0),
    },
  };
}

export function serializeShareState(state: ShareStateInput): string {
  const params = new URLSearchParams();
  if (state.mapCenter) {
    const [lat, lng] = state.mapCenter;
    params.set("lat", lat.toFixed(COORD_PRECISION));
    params.set("lng", lng.toFixed(COORD_PRECISION));
  }
  params.set("z", state.mapZoom.toFixed(ZOOM_PRECISION));

  const local = toMapLocal(state.date, state.utcOffsetMin);
  params.set(
    "date",
    `${local.year}-${String(local.month + 1).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`
  );
  params.set("time", `${String(local.hours).padStart(2, "0")}:${String(local.minutes).padStart(2, "0")}`);

  if (state.waypointA) params.set("a", formatCoord(state.waypointA));
  if (state.waypointB) params.set("b", formatCoord(state.waypointB));
  if (state.additionalWaypoints.length > 0) {
    params.set("via", state.additionalWaypoints.map(formatCoord).join(";"));
  }
  // Dwell stays unwritten for all-zero trips, so old links keep parsing and
  // new dwell-free links stay short. Consumers align positionally over
  // [A, ...via, B], padding short arrays with zero and trimming the excess.
  const dwell = state.dwellMinutes ?? [];
  if (dwell.some((minutes) => minutes > 0)) {
    params.set("dwell", dwell.map((minutes) => Math.max(0, Math.floor(minutes))).join(","));
  }
  // Walk is the default and stays unwritten so old links keep parsing.
  if (state.travelMode !== "walk") params.set("mode", state.travelMode);
  // Sun remains the default so pre-objective links stay byte-for-byte readable.
  if (state.objective === "rain") {
    params.set("objective", "rain");
    params.set("wind", state.windSource === "manual" ? "manual" : "forecast");
    if (state.windSource === "manual") {
      const dir = Number.isFinite(state.manualWind?.directionDeg ?? NaN)
        ? normalizeDirection(state.manualWind!.directionDeg!)
        : 0;
      const speed = Number.isFinite(state.manualWind?.speedMps ?? NaN)
        ? Math.max(0, state.manualWind!.speedMps!)
        : 0;
      params.set("windDir", dir.toFixed(1));
      params.set("windSpeed", speed.toFixed(2));
    }
  }

  return `?${params.toString()}`;
}

export function shareUrlFromState(state: ShareStateInput, href = window.location.href): string {
  const url = new URL(href);
  url.search = serializeShareState(state);
  return url.toString();
}
