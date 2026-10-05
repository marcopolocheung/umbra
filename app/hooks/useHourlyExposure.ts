import { useCallback, useEffect, useMemo, useState } from "react";
import {
  bestExposureSample,
  buildHourlyExposureSeries,
  type HourlyExposureSample,
} from "../lib/bestTime";
import { haversineMeters, type RouteOption } from "../lib/routing";
import {
  bboxAroundEdges,
  QUERY_PAD_M,
  type EdgeRef,
  type ShadowField,
} from "../lib/shadowField/ShadowField";
import { toMapLocal } from "../lib/timezone";
import type { ExposureSettings, ResolvedExposureContext } from "../lib/exposure";
import { resolveExposureContext } from "../lib/exposure";
import { fetchWeatherForecast, nearestForecastWind } from "../services/weather";

export interface HourlyExposure {
  /** The whole day's schedule. Entries past `readyCount` are not sampled yet. */
  samples: HourlyExposureSample[];
  /** How many leading hours carry a real measurement. */
  readyCount: number;
  /** The most shadowed sampled hour, or null before the first one lands. */
  best: HourlyExposureSample | null;
  /** False until `request` is called for this route: nothing is sampled before then. */
  requested: boolean;
  /** Start sampling the day for the current route. */
  request: () => void;
}

type HourlyExposureState = Omit<HourlyExposure, "requested" | "request">;

const EMPTY: HourlyExposureState = { samples: [], readyCount: 0, best: null };

/** Consecutive coordinate pairs of a route line, as the field's edge type. */
function edgesFromRoute(route: RouteOption | null): EdgeRef[] {
  const coords = route?.geojson.geometry.coordinates ?? [];
  const edges: EdgeRef[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    edges.push({
      from: coords[i] as [number, number],
      to: coords[i + 1] as [number, number],
    });
  }
  return edges;
}

/**
 * What makes two route objects the same walk for this hook: the line it draws and
 * the sidewalks it credits. `useRouting` rebuilds every route object ~250 ms after
 * each timeline change (the exposure refresh), so identity changes while the walk
 * does not — keying on content keeps the day's series, and the user's request for
 * it, across those rebuilds.
 */
function routeKey(route: RouteOption | null): string {
  if (!route) return "";
  return JSON.stringify([route.geojson.geometry.coordinates, route.sides ?? null]);
}

/**
 * Shadow over a whole day for one route — the "when should I go?" series.
 *
 * Sampled from building geometry rather than the map canvas, so the camera never
 * moves and the answer does not depend on what is currently on screen. Until A6
 * makes a sweep cheaper than N separate samples, one hour is computed per frame:
 * `sweep` is synchronous, and fifteen hours of a long route in a single call is
 * long enough to drop frames on the phone this app is used from.
 *
 * Nothing is sampled until the caller asks (`request`). Each hour is a full
 * building-shadow sweep — 0.1–1.2 s on a long route, all on the main thread — and
 * starting the day the moment a route lands put that stall exactly where the user
 * grabs the map next. Until then the hook publishes the day's schedule with
 * nothing measured, and a new route goes back to waiting.
 *
 * The sweep restarts only when the route's geometry or sides change (`routeKey`),
 * not its object identity: `page.tsx` passes an element of `navRoutes`, which the
 * exposure refresh replaces after every timeline change.
 */
export function useHourlyExposure(
  route: RouteOption | null,
  field: ShadowField | null,
  date: Date,
  utcOffsetMin: number,
  objective: "sun" | "rain" = "sun",
  exposureSettings?: ExposureSettings,
  anchorContext?: ResolvedExposureContext | null,
): HourlyExposure {
  const key = routeKey(route);
  // The route as of its current key: a rebuilt object with the same walk keeps
  // the first one, so nothing downstream sees a change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on content on purpose — `route` changes identity on every exposure refresh
  const stableRoute = useMemo(() => route, [key]);
  const edges = useMemo(() => edgesFromRoute(stableRoute), [stableRoute]);
  const sides = stableRoute?.sides;

  // The series covers a calendar day, so dragging the timeline within one day must
  // not restart the sweep — only the day is an input. `fromMapLocal` reads nothing
  // from its anchor but the map-local calendar date, so map-local midnight stands in
  // for whatever time `date` currently holds, and changes only when the day does.
  const { year, month, day } = toMapLocal(date, utcOffsetMin);
  const dayAnchor = useMemo(
    () => new Date(Date.UTC(year, month, day) - utcOffsetMin * 60000),
    [year, month, day, utcOffsetMin],
  );

  // Only the trip's reference point is read from the context, and the exposure
  // refresh hands over a new context object on every timeline change — keying on
  // the point keeps a time change from resampling the whole day.
  const anchorLat = anchorContext?.referenceLocation.lat;
  const anchorLng = anchorContext?.referenceLocation.lng;
  const anchor = useMemo(
    () => (anchorLat != null && anchorLng != null ? { lat: anchorLat, lng: anchorLng } : null),
    [anchorLat, anchorLng],
  );

  const [state, setState] = useState<HourlyExposureState>(EMPTY);
  // The walk the user asked about; a different walk is not requested.
  const [requestedKey, setRequestedKey] = useState<string | null>(null);
  const requested = key !== "" && requestedKey === key;
  const request = useCallback(() => setRequestedKey(key), [key]);
  const resolvedSettings = useMemo<ExposureSettings>(() => exposureSettings ?? {
    objective: objective === "rain" ? "rain" : "sun",
    windSource: "manual",
    manualWind: { directionDeg: 0, speedMps: 0 },
  }, [exposureSettings, objective]);

  useEffect(() => {
    if (edges.length === 0 || !field) {
      setState(EMPTY);
      return;
    }

    let cancelled = false;
    let frame = 0;

    // `buildHourlyExposureSeries` owns the schedule — which hours, their labels,
    // and the timezone arithmetic. Run it once against a zero sampler to learn
    // the dates, then fill those same dates in one at a time.
    const schedule = buildHourlyExposureSeries(dayAnchor, utcOffsetMin, () => 0);
    if (!requested) {
      // The strip still knows its hours; it just has no readings until asked.
      if (objective === "rain") for (const sample of schedule) sample.objective = "rain";
      setState({ samples: schedule, readyCount: 0, best: null });
      return;
    }
    const coverage = new Map<number, number | null>();
    const available = new Map<number, boolean>();
    const unavailable = new Set<number>();

    const totalM = edges.reduce((sum, e) => sum + haversineMeters(e.from, e.to), 0);

    const sampleSunHour = (when: Date): number => {
      if (totalM <= 0) return 0;
      const shadows = field.sweep(edges, [when])[0];
      let shadowedM = 0;
      for (let i = 0; i < edges.length; i++) {
        const edge = shadows[i];
        // Credit the sidewalk the route actually uses; average only when the
        // search never chose a side (sketch and transit legs).
        const side = sides?.[i];
        const shadow =
          side === "left" ? edge.left : side === "right" ? edge.right : (edge.left + edge.right) / 2;
        shadowedM += haversineMeters(edges[i].from, edges[i].to) * shadow;
      }
      return shadowedM / totalM;
    };

    const sampleRainHour = (when: Date, context: ResolvedExposureContext): number | null => {
      if (totalM <= 0 || !field.sampleRainEdges) return null;
      const shelter = field.sampleRainEdges(edges, context.direction, when);
      let measured = 0;
      let protectedM = 0;
      for (let i = 0; i < edges.length; i++) {
        if (shelter[i].confidence < 0.5) continue;
        const side = sides?.[i];
        const value = side === "left"
          ? shelter[i].left
          : side === "right"
            ? shelter[i].right
            : (shelter[i].left + shelter[i].right) / 2;
        const distance = haversineMeters(edges[i].from, edges[i].to);
        measured += distance;
        protectedM += distance * value;
      }
      return measured > 0 ? protectedM / measured : null;
    };

    const publish = (readyCount: number) => {
      const samples = buildHourlyExposureSeries(
        dayAnchor,
        utcOffsetMin,
        (when) => coverage.get(when.getTime()) ?? 0,
      );
      for (const sample of samples) {
        if (objective === "rain") {
          sample.objective = "rain";
          sample.available = available.get(sample.date.getTime()) ?? false;
        }
      }
      setState({
        samples,
        readyCount,
        best: bestExposureSample(samples.slice(0, readyCount), objective),
      });
    };

    const step = (index: number, contextByHour?: Map<number, ResolvedExposureContext>) => {
      if (cancelled || index >= schedule.length) return;
      const when = schedule[index].date;
      const value = objective === "rain"
        ? unavailable.has(when.getTime())
          ? null
          : contextByHour?.get(when.getTime())
          ? sampleRainHour(when, contextByHour.get(when.getTime())!)
          : null
        : sampleSunHour(when);
      coverage.set(when.getTime(), value);
      available.set(when.getTime(), value != null);
      publish(index + 1);
      frame = requestAnimationFrame(() => step(index + 1, contextByHour));
    };

    const bbox = bboxAroundEdges(edges, QUERY_PAD_M);
    const start = async () => {
      if (cancelled) return;
      const contexts = new Map<number, ResolvedExposureContext>();
      if (objective === "rain") {
        const settings = resolvedSettings;
        let forecast = null;
        if (settings.windSource === "forecast") {
          if (anchor) {
            try {
              forecast = await fetchWeatherForecast(anchor.lat, anchor.lng);
            } catch {
              forecast = null;
            }
          }
        }
        for (const item of schedule) {
          const context = resolveExposureContext(settings, {
            time: item.date,
            mapCenter: anchor
              ? [anchor.lng, anchor.lat]
              : [edges[0].from[0], edges[0].from[1]],
            forecast,
            revision: `hour:${item.date.getTime()}`,
          });
          // A forecast row without a usable wind remains unavailable; the context
          // itself records the vertical fallback for the current renderer.
          if (settings.windSource === "forecast" && !nearestForecastWind(forecast ?? [], item.date)) {
            contexts.set(item.date.getTime(), context);
            available.set(item.date.getTime(), false);
            unavailable.add(item.date.getTime());
          } else {
            contexts.set(item.date.getTime(), context);
          }
        }
      }
      if (!cancelled) frame = requestAnimationFrame(() => step(0, contexts));
    };
    // Geometry may still need fetching; a failed preload is not fatal, the field
    // reports its own low confidence when it cannot answer.
    if (bbox) field.ready(bbox).then(start, start);
    else void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [
    edges,
    field,
    dayAnchor,
    utcOffsetMin,
    sides,
    objective,
    resolvedSettings,
    requested,
    anchor,
  ]);

  return useMemo(() => ({ ...state, requested, request }), [state, requested, request]);
}
