import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type * as maplibregl from "maplibre-gl";
import type { AccumulationOptions } from "../components/MapView";
import {
  longitudeToUtcOffsetMin,
  toMapLocal,
  fromMapLocal,
  fromMapLocalInZone,
  fromZonedParts,
  utcOffsetMinAt,
} from "../lib/timezone";
import { ensureZoneLookup, zoneAt } from "../lib/tzLookup";

function todayAt(hours: number): Date {
  const d = new Date();
  d.setHours(hours, 0, 0, 0);
  return d;
}

export function formatTime12h(d: Date, utcOffsetMin: number): string {
  const { hours: h24, minutes: m } = toMapLocal(d, utcOffsetMin);
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h = h24 % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

/**
 * Parse a user-typed time string. Accepts:
 *   "6:30 AM" | "6:30AM" | "6:30 PM" | "14:30" | "6:30" | "6 AM" | "14" | "6"
 * Returns total minutes from midnight, or null if unparseable.
 */
export function parseTime(s: string): number | null {
  s = s.trim();
  const pm = /pm$/i.test(s);
  const am = /am$/i.test(s);
  const hasMeridiem = am || pm;
  const core = s.replace(/\s*[ap]m\s*$/i, "").trim();
  const parts = core.split(":").map((p) => parseInt(p.trim(), 10));
  if (parts.some(isNaN)) return null;
  let h = parts[0];
  const m = parts.length > 1 ? parts[1] : 0;
  if (m < 0 || m > 59) return null;
  if (hasMeridiem) {
    if (h < 1 || h > 12) return null;
    if (am && h === 12) h = 0;
    if (pm && h !== 12) h += 12;
  } else {
    if (h < 0 || h > 23) return null;
  }
  return h * 60 + m;
}

export function dateToDayOfYear(d: Date, utcOffsetMin: number): number {
  const { year, month, day } = toMapLocal(d, utcOffsetMin);
  return Math.floor(
    (Date.UTC(year, month, day) - Date.UTC(year, 0, 1)) / 86400000
  );
}

export interface ShadowTimeState {
  date: Date;
  setDate: React.Dispatch<React.SetStateAction<Date>>;
  showSunLines: boolean;
  setShowSunLines: React.Dispatch<React.SetStateAction<boolean>>;
  accumulation: AccumulationOptions;
  setAccumulation: React.Dispatch<React.SetStateAction<AccumulationOptions>>;
  isPlaying: boolean;
  setIsPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  sliderMode: "time" | "day";
  setSliderMode: React.Dispatch<React.SetStateAction<"time" | "day">>;
  mapCenter: [number, number] | null;
  mapZoom: number;
  /** Camera pitch in degrees. 0 is top-down; > 0 means the 3D view is active. */
  mapPitch: number;
  mapUtcOffsetMin: number;
  /** IANA zone of the map centre; null until the boundary dataset resolves. */
  mapZone: string | null;
  dateRef: React.MutableRefObject<Date>;
  mapUtcOffsetMinRef: React.MutableRefObject<number>;
  sliderModeRef: React.MutableRefObject<"time" | "day">;
  handleMapReady: (map: maplibregl.Map) => void;
  handleSliderChange: (m: number) => void;
  handleDayOfYearChange: (day: number) => void;
  adjustYear: (delta: number) => void;
  jumpTo: (center: [number, number], zoom: number) => void;
  getCanvas: () => HTMLCanvasElement | undefined;
  getBounds: () => maplibregl.LngLatBounds | undefined;
  mapRef: React.MutableRefObject<maplibregl.Map | null>;
}

export function useShadowTime(): ShadowTimeState {
  const [date, setDate] = useState<Date>(() => todayAt(12));
  const [showSunLines, setShowSunLines] = useState(false);
  const [accumulation, setAccumulation] = useState<AccumulationOptions>({
    enabled: false,
    startDate: todayAt(6),
    endDate: todayAt(20),
    iterations: 32,
  });
  const [isPlaying, setIsPlaying] = useState(false);
  const [sliderMode, setSliderMode] = useState<"time" | "day">("time");
  const [mapCenter, setMapCenter] = useState<[number, number] | null>(null);
  const [mapZoom, setMapZoom] = useState(2);
  const [mapPitch, setMapPitch] = useState(0);
  const [mapZone, setMapZone] = useState<string | null>(null);

  const mapRef = useRef<maplibregl.Map | null>(null);
  const dateRef = useRef(date);
  const mapUtcOffsetMinRef = useRef(0);
  const mapZoneRef = useRef(mapZone);
  const sliderModeRef = useRef<"time" | "day">("time");
  const animTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * Derived, never stored. The offset depends on the *date* as well as the place
   * — that is what DST means — so holding it in state guarantees it eventually
   * disagrees with the date beside it. Falls back to a longitude estimate while
   * the zone dataset loads, and to the device's own zone before the map is ready.
   */
  const mapUtcOffsetMin = useMemo(
    () =>
      mapZone
        ? utcOffsetMinAt(mapZone, date)
        : mapCenter
          ? longitudeToUtcOffsetMin(mapCenter[1])
          : -new Date().getTimezoneOffset(),
    [mapZone, date, mapCenter]
  );

  dateRef.current = date;
  mapUtcOffsetMinRef.current = mapUtcOffsetMin;
  mapZoneRef.current = mapZone;
  sliderModeRef.current = sliderMode;

  // Advance 2 minutes per tick at 50ms → ~24s per full day
  useEffect(() => {
    if (isPlaying) {
      animTimerRef.current = setInterval(() => {
        setDate((prev) => {
          const offsetMin = mapUtcOffsetMinRef.current;
          const zone = mapZoneRef.current;
          if (sliderModeRef.current === "day") {
            const { year: yr, hours, minutes } = toMapLocal(prev, offsetMin);
            const doy = dateToDayOfYear(prev, offsetMin);
            const isLeap = (yr % 4 === 0 && yr % 100 !== 0) || yr % 400 === 0;
            const nextDoy = (doy + 1) % (isLeap ? 366 : 365);
            if (zone) return fromZonedParts(zone, yr, 0, 1 + nextDoy, hours, minutes);
            return new Date(
              Date.UTC(yr, 0, 1) + nextDoy * 86400000 - offsetMin * 60000 + (hours * 60 + minutes) * 60000
            );
          } else {
            const { hours, minutes } = toMapLocal(prev, offsetMin);
            const totalMins = (hours * 60 + minutes + 2) % 1440;
            const h = Math.floor(totalMins / 60);
            const m = totalMins % 60;
            return zone
              ? fromMapLocalInZone(prev, zone, h, m)
              : fromMapLocal(prev, offsetMin, h, m);
          }
        });
      }, 50);
    } else {
      if (animTimerRef.current) {
        clearInterval(animTimerRef.current);
        animTimerRef.current = null;
      }
    }
    return () => {
      if (animTimerRef.current) clearInterval(animTimerRef.current);
    };
  }, [isPlaying]);

  /**
   * Point the clock at the zone under `lat`/`lng`.
   *
   * The boundary dataset is fetched on demand, so the first call resolves a tick
   * later and the app shows a longitude estimate until then. No debounce or
   * cancellation: after the first load `zoneAt` is synchronous, and every caller
   * passes the current centre, so a late resolution cannot install a stale zone.
   */
  const resolveZone = useCallback((lat: number, lng: number) => {
    const known = zoneAt(lat, lng);
    if (known) {
      setMapZone(known);
      return;
    }
    ensureZoneLookup().then(() => setMapZone(zoneAt(lat, lng)));
  }, []);

  const handleMapReady = useCallback((map: maplibregl.Map) => {
    mapRef.current = map;
    const { lat, lng } = map.getCenter();
    setMapCenter([lat, lng]);
    setDate(new Date());
    resolveZone(lat, lng);
    map.on("moveend", () => {
      const c = map.getCenter();
      setMapCenter([c.lat, c.lng]);
      resolveZone(c.lat, c.lng);
    });
    map.on("zoom", () => setMapZoom(map.getZoom()));
    setMapZoom(map.getZoom());
    // Pitch lives here rather than in FloatingMapControls because the map arrives via a
    // ref: a component subscribing on mount would find `mapRef.current` still null and
    // never re-render to retry.
    map.on("pitchend", () => setMapPitch(map.getPitch()));
    setMapPitch(map.getPitch());
  }, [resolveZone]);

  const handleSliderChange = useCallback((m: number) => {
    setDate((prev) => {
      const offsetMin = mapUtcOffsetMinRef.current;
      const { hours, minutes } = toMapLocal(prev, offsetMin);
      if (hours * 60 + minutes === m) return prev;
      const zone = mapZoneRef.current;
      return zone
        ? fromMapLocalInZone(prev, zone, Math.floor(m / 60), m % 60)
        : fromMapLocal(prev, offsetMin, Math.floor(m / 60), m % 60);
    });
  }, []);

  const handleDayOfYearChange = useCallback((day: number) => {
    setDate((prev) => {
      const offsetMin = mapUtcOffsetMinRef.current;
      const { year, hours, minutes } = toMapLocal(prev, offsetMin);
      const zone = mapZoneRef.current;
      if (zone) return fromZonedParts(zone, year, 0, 1 + day, hours, minutes);
      return new Date(
        Date.UTC(year, 0, 1) + day * 86400000 - offsetMin * 60000 + (hours * 60 + minutes) * 60000
      );
    });
  }, []);

  const adjustYear = useCallback((delta: number) => {
    setDate((prev) => {
      const offsetMin = mapUtcOffsetMinRef.current;
      const { year, month, day, hours, minutes } = toMapLocal(prev, offsetMin);
      const zone = mapZoneRef.current;
      if (zone) return fromZonedParts(zone, year + delta, month, day, hours, minutes);
      return new Date(
        Date.UTC(year + delta, month, day) - offsetMin * 60000 + (hours * 60 + minutes) * 60000
      );
    });
  }, []);

  const jumpTo = useCallback((center: [number, number], zoom: number) => {
    mapRef.current?.jumpTo({ center, zoom });
    // `center` is maplibre's [lng, lat], the reverse of `mapCenter`'s [lat, lng].
    resolveZone(center[1], center[0]);
    setDate(new Date());
  }, [resolveZone]);

  const getCanvas = useCallback(
    () => mapRef.current?.getCanvas(),
    []
  );

  const getBounds = useCallback(
    () => mapRef.current?.getBounds(),
    []
  );

  return {
    date, setDate,
    showSunLines, setShowSunLines,
    accumulation, setAccumulation,
    isPlaying, setIsPlaying,
    sliderMode, setSliderMode,
    mapCenter, mapZoom, mapPitch,
    mapUtcOffsetMin,
    mapZone,
    dateRef, mapUtcOffsetMinRef, sliderModeRef,
    handleMapReady, handleSliderChange, handleDayOfYearChange,
    adjustYear, jumpTo, getCanvas, getBounds,
    mapRef,
  };
}
