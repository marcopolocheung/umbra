/**
 * Shared conditions for every exposure consumer.
 *
 * The renderer, route search, refresh jobs and exports must all describe the
 * same instant and the same wind.  Keeping the resolved value in one immutable
 * object prevents a map pan, a second weather request, or a stale route job from
 * silently changing the question a result answers.
 */

import { directionForWindReport, verticalRainDirection, type RainDirection } from "./rain/direction";
import { nearestForecastWind } from "../services/weather";
import type { WeatherHour } from "./heat/types";

export type ExposureObjective = "sun" | "rain";
export type WindSource = "forecast" | "manual";
export type WindProvenance = WindSource | "vertical-fallback" | "not-applicable";

export interface ManualWind {
  /** Meteorological wind-from bearing, degrees clockwise from north. */
  directionDeg: number;
  /** Non-negative wind speed in metres per second. */
  speedMps: number;
}

export interface ExposureSettings {
  objective: ExposureObjective;
  windSource: WindSource;
  manualWind: ManualWind;
}

export interface ExposureLocation {
  lat: number;
  lng: number;
}

export interface ResolvedExposureContext {
  readonly objective: ExposureObjective;
  readonly time: Date;
  readonly referenceLocation: Readonly<ExposureLocation>;
  readonly direction: RainDirection;
  /** Wind-from bearing used by rain, kept explicit for persistence and UI. */
  readonly windDirectionDeg: number | null;
  /** Wind speed used by rain, in m/s. Zero is a valid measured value. */
  readonly windSpeedMps: number | null;
  readonly windProvenance: WindProvenance;
  /** Forecast hour used for the resolution, when one was available. */
  readonly forecastHour: Date | null;
  /** Monotonic caller revision, or a deterministic fingerprint when omitted. */
  readonly revision: string;
}

export interface ExposureAnchorInput {
  mapCenter?: [number, number] | null;
  /** First and last trip stops. Intermediate stops do not move the weather pin. */
  tripStops?: ReadonlyArray<[number, number]>;
  /** Endpoints of a freehand sketch. */
  sketchEndpoints?: readonly [[number, number], [number, number]] | null;
}

export interface ResolveExposureInput extends ExposureAnchorInput {
  time: Date;
  /** Forecast rows may be supplied by the shared weather cache. */
  forecast?: readonly WeatherHour[] | null;
  /** Optional revision supplied by a route/calculation coordinator. */
  revision?: string | number;
}

export function defaultExposureSettings(): ExposureSettings {
  return {
    objective: "sun",
    windSource: "forecast",
    manualWind: { directionDeg: 0, speedMps: 0 },
  };
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function normalizeWindDirection(degrees: number): number {
  return ((finiteOr(degrees, 0) % 360) + 360) % 360;
}

export function normalizeManualWind(wind: Partial<ManualWind> | null | undefined): ManualWind {
  return {
    directionDeg: normalizeWindDirection(finiteOr(wind?.directionDeg, 0)),
    speedMps: Math.max(0, finiteOr(wind?.speedMps, 0)),
  };
}

export function normalizeExposureSettings(
  settings: Partial<ExposureSettings> | null | undefined,
): ExposureSettings {
  return {
    objective: settings?.objective === "rain" ? "rain" : "sun",
    windSource: settings?.windSource === "manual" ? "manual" : "forecast",
    manualWind: normalizeManualWind(settings?.manualWind),
  };
}

/** Midpoint used for weather, deliberately independent of the map viewport. */
export function exposureReferenceLocation(input: ExposureAnchorInput): ExposureLocation | null {
  const stops = input.tripStops;
  if (stops && stops.length >= 2) {
    const first = stops[0];
    const last = stops[stops.length - 1];
    return { lng: (first[0] + last[0]) / 2, lat: (first[1] + last[1]) / 2 };
  }
  const sketch = input.sketchEndpoints;
  if (sketch) {
    return { lng: (sketch[0][0] + sketch[1][0]) / 2, lat: (sketch[0][1] + sketch[1][1]) / 2 };
  }
  const center = input.mapCenter;
  return center ? { lng: center[0], lat: center[1] } : null;
}

function fingerprint(
  settings: ExposureSettings,
  time: Date,
  location: ExposureLocation | null,
  provenance: WindProvenance,
  directionDeg: number | null,
  speedMps: number | null,
  revision: string | number | undefined,
): string {
  return [
    revision ?? "auto",
    settings.objective,
    settings.windSource,
    time.getTime(),
    location ? `${location.lng.toFixed(6)},${location.lat.toFixed(6)}` : "none",
    provenance,
    directionDeg ?? "none",
    speedMps ?? "none",
  ].join("|");
}

/** Resolve a complete context synchronously from an already fetched forecast. */
export function resolveExposureContext(
  rawSettings: Partial<ExposureSettings> | null | undefined,
  input: ResolveExposureInput,
): ResolvedExposureContext {
  const settings = normalizeExposureSettings(rawSettings);
  const time = new Date(input.time.getTime());
  const location = exposureReferenceLocation(input);

  let directionDeg: number | null = null;
  let speedMps: number | null = null;
  let windProvenance: WindProvenance = settings.objective === "sun" ? "not-applicable" : "vertical-fallback";
  let forecastHour: Date | null = null;

  if (settings.objective === "rain") {
    if (settings.windSource === "manual") {
      directionDeg = settings.manualWind.directionDeg;
      speedMps = settings.manualWind.speedMps;
      windProvenance = "manual";
    } else {
      const wind = nearestForecastWind([...(input.forecast ?? [])], time);
      if (wind) {
        directionDeg = wind.directionDeg;
        speedMps = wind.speedMps;
        windProvenance = "forecast";
        forecastHour = new Date(wind.hour.time.getTime());
      }
    }
  }

  const direction = settings.objective === "rain"
    ? directionForWindReport(directionDeg, speedMps)
    : verticalRainDirection();
  const revision = fingerprint(settings, time, location, windProvenance, directionDeg, speedMps, input.revision);
  return Object.freeze({
    objective: settings.objective,
    time,
    referenceLocation: Object.freeze(location ?? { lat: 0, lng: 0 }),
    direction,
    windDirectionDeg: directionDeg,
    windSpeedMps: speedMps,
    windProvenance,
    forecastHour,
    revision,
  });
}

export function contextConditionsLabel(context: ResolvedExposureContext): string {
  if (context.objective !== "rain") return "sun conditions";
  if (context.windProvenance === "manual") {
    return `manual wind ${Math.round(context.windDirectionDeg ?? 0)}° at ${(context.windSpeedMps ?? 0).toFixed(1)} m/s`;
  }
  if (context.windProvenance === "forecast") {
    return `forecast wind ${Math.round(context.windDirectionDeg ?? 0)}° at ${(context.windSpeedMps ?? 0).toFixed(1)} m/s`;
  }
  return "vertical rain (wind unavailable)";
}
