import type { WeatherHour } from "../lib/heat/types";

/** The Open-Meteo hourly variables this app asks for, in one request. */
const HOURLY_VARIABLES = [
  "cloud_cover",
  "uv_index",
  "temperature_2m",
  "relative_humidity_2m",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "apparent_temperature",
  "shortwave_radiation",
] as const;

interface OpenMeteoResponse {
  hourly?: {
    time?: string[];
    cloud_cover?: number[];
    uv_index?: number[];
    temperature_2m?: number[];
    relative_humidity_2m?: number[];
    wind_speed_10m?: number[];
    wind_direction_10m?: number[];
    wind_gusts_10m?: number[];
    apparent_temperature?: number[];
    shortwave_radiation?: number[];
  };
}

export interface CloudCoverForecast {
  cloudCoverPct: number;
  forecastTime: Date;
}

/** Forecast freshness accepted by every weather consumer, including rain. */
export const MAX_WEATHER_HOUR_DELTA_MS = 90 * 60 * 1000;

/** How long one location's forecast is reused before it is fetched again. */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** ~1.1 km cells. Finer than this refetches for a pan nobody would call a move. */
const CACHE_PRECISION = 2;

function parseUtcHour(raw: string): Date | null {
  const d = new Date(raw.endsWith("Z") ? raw : `${raw}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A finite number, or null — the distinction the whole contract rests on. */
function value(series: number[] | undefined, i: number): number | null {
  const n = series?.[i];
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Open-Meteo's column-per-variable response, transposed into one row per hour.
 *
 * A variable the response does not carry becomes `null` on every hour rather than
 * dropping the hour: the cloud badge should still work in a response that predates
 * UV being requested, and a consumer that needs UV can tell that it is missing.
 */
export function parseWeatherHours(response: OpenMeteoResponse): WeatherHour[] {
  const times = response.hourly?.time ?? [];
  const hours: WeatherHour[] = [];

  for (let i = 0; i < times.length; i++) {
    const time = parseUtcHour(times[i]);
    if (!time) continue;
    hours.push({
      time,
      cloudPct: value(response.hourly?.cloud_cover, i),
      uvIndex: value(response.hourly?.uv_index, i),
      tempC: value(response.hourly?.temperature_2m, i),
      humidityPct: value(response.hourly?.relative_humidity_2m, i),
      windMs: value(response.hourly?.wind_speed_10m, i),
      // Direction needs no unit conversion; gust arrives under the same
      // `wind_speed_unit=ms` request parameter as the sustained speed.
      windDirDeg: value(response.hourly?.wind_direction_10m, i),
      windGustMs: value(response.hourly?.wind_gusts_10m, i),
      apparentTempC: value(response.hourly?.apparent_temperature, i),
      shortwaveWm2: value(response.hourly?.shortwave_radiation, i),
    });
  }

  return hours;
}

/**
 * The hour nearest `target`, within ±90 minutes.
 *
 * `require` names a field the caller cannot proceed without, so an hour carrying a
 * timestamp but not that measurement is skipped rather than returned empty. Without
 * it the cloud badge would match an hour whose `cloudPct` is null and render nothing.
 */
export function nearestWeatherHour(
  hours: WeatherHour[],
  target: Date,
  require?: keyof WeatherHour
): WeatherHour | null {
  let best: WeatherHour | null = null;
  let bestDelta = Infinity;

  for (const hour of hours) {
    if (require && hour[require] === null) continue;
    const delta = Math.abs(hour.time.getTime() - target.getTime());
    if (delta < bestDelta) {
      bestDelta = delta;
      best = hour;
    }
  }

  return best && bestDelta <= MAX_WEATHER_HOUR_DELTA_MS ? best : null;
}

/** A wind row with explicit provenance; speed 0 is a real calm forecast. */
export interface ForecastWind {
  hour: WeatherHour;
  directionDeg: number;
  speedMps: number;
}

export function nearestForecastWind(hours: WeatherHour[], target: Date): ForecastWind | null {
  // First select the nearest forecast row, using the same freshness window as
  // every other weather consumer. If that row cannot establish an incident ray,
  // keep the context explicitly vertical rather than silently borrowing wind
  // from a more distant hour.
  const hour = nearestWeatherHour(hours, target);
  if (!hour || hour.windDirDeg == null || !Number.isFinite(hour.windDirDeg)) return null;
  const speed = hour.windMs ?? hour.windGustMs;
  if (speed == null || !Number.isFinite(speed) || speed < 0) return null;
  return { hour, directionDeg: ((hour.windDirDeg % 360) + 360) % 360, speedMps: speed };
}

interface CacheEntry {
  fetchedAtMs: number;
  hours: Promise<WeatherHour[]>;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(CACHE_PRECISION)},${lng.toFixed(CACHE_PRECISION)}`;
}

/** Drops every cached forecast. Exists for tests; nothing in the app calls it. */
export function clearWeatherCache(): void {
  cache.clear();
}

/**
 * Every hour Open-Meteo will give us for this location — one request, reused.
 *
 * The response already spans a week, so the timeline slider moving across hours or
 * days is served from the same payload; only a real move or an hour of staleness
 * costs another call. That is the whole point of D2: the cloud badge, a UV dose and
 * a heat score must not be three separate fetches of the same forecast.
 *
 * A rejected fetch is evicted rather than memoized, so one failed request does not
 * leave a location permanently weatherless.
 */
export function fetchWeatherForecast(
  lat: number,
  lng: number,
  opts: { signal?: AbortSignal; now?: number } = {}
): Promise<WeatherHour[]> {
  const now = opts.now ?? Date.now();
  const key = cacheKey(lat, lng);
  const cached = cache.get(key);
  if (cached && now - cached.fetchedAtMs < CACHE_TTL_MS) return cached.hours;

  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lng.toFixed(4),
    hourly: HOURLY_VARIABLES.join(","),
    forecast_days: "7",
    past_days: "1",
    timezone: "UTC",
    // Open-Meteo defaults wind to km/h. `WeatherHour.windMs` says m/s, and the heat
    // model divides by it inside Steadman's apparent-temperature term — a unit the
    // field name asserts has to actually be the unit the response carries.
    wind_speed_unit: "ms",
  });

  const hours = fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
    signal: opts.signal,
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
      return parseWeatherHours((await res.json()) as OpenMeteoResponse);
    })
    .catch((err) => {
      // Only evict this attempt — a later one may have already replaced it.
      if (cache.get(key)?.hours === hours) cache.delete(key);
      throw err;
    });

  cache.set(key, { fetchedAtMs: now, hours });
  return hours;
}

/** The nearest hour's cloud cover, clamped to a displayable percent. */
function cloudForecastAt(hours: WeatherHour[], target: Date): CloudCoverForecast | null {
  const hour = nearestWeatherHour(hours, target, "cloudPct");
  if (hour?.cloudPct == null) return null;
  return {
    forecastTime: hour.time,
    cloudCoverPct: Math.max(0, Math.min(100, Math.round(hour.cloudPct))),
  };
}

export function nearestCloudCover(
  response: OpenMeteoResponse,
  target: Date
): CloudCoverForecast | null {
  return cloudForecastAt(parseWeatherHours(response), target);
}

export async function fetchCloudCoverForecast(
  lat: number,
  lng: number,
  target: Date,
  signal?: AbortSignal
): Promise<CloudCoverForecast | null> {
  return cloudForecastAt(await fetchWeatherForecast(lat, lng, { signal }), target);
}
