import "./storageMigration";
// app/lib/savedRoutes.ts
import type { RouteOption } from "./routing";
import { buildTrip } from "./trip/trip";
import type { Trip } from "./trip/types";
import { normalizeExposureSettings, type ExposureSettings, type ResolvedExposureContext } from "./exposure";

export interface SavedExposureConditions {
  objective: "sun" | "rain";
  windSource: "forecast" | "manual";
  manualWind: { directionDeg: number; speedMps: number };
  evaluatedContext?: Omit<ResolvedExposureContext, "time" | "forecastHour"> & {
    time: string;
    forecastHour: string | null;
  };
}

export interface SavedFolder {
  id: string;
  name: string;
  createdAt: number;
}

export interface SavedRoute {
  id: string;
  name: string;
  folderId: string | null; // null = uncategorised
  routeOption: RouteOption; // full serialised RouteOption (geometry included)
  waypointA: [number, number];
  waypointB: [number, number];
  waypointALabel: string | null;
  waypointBLabel: string | null;
  additionalWaypoints: [number, number][];
  timeOfDayMinutes: number; // 0–1439
  dateIso: string;          // "YYYY-MM-DD"
  createdAt: number;
  /** Absent = v1. v2 carries the journey as a `Trip`. */
  version?: 1 | 2;
  /** The journey, preferred over the legacy waypoint fields when present. */
  trip?: Trip;
  /** Conditions selected when this route was evaluated. */
  exposureSettings?: ExposureSettings;
  evaluatedConditions?: SavedExposureConditions;
  /** A pre-objective rain record; its original wind is intentionally unknown. */
  legacyRainResult?: boolean;
}

const FOLDERS_KEY = "umbra:folders";
const ROUTES_KEY  = "umbra:routes";
/** Records `getRoutes` could not read. Kept verbatim — never silently dropped. */
const QUARANTINE_KEY = "umbra:routes-quarantine";

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** The reader's own zone — the frame a browser-local wall-clock reading is
 * made in. Falls back to UTC only if the runtime withholds it. */
function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCoord(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  );
}

/** The v1 shape: everything `createRoute` wrote before the `Trip` model. */
function isV1Record(value: RecordValue): boolean {
  if (value.version !== undefined && value.version !== 1) return false;
  if (typeof value.id !== "string" || typeof value.name !== "string") return false;
  if (!record(value.routeOption) || !record(value.routeOption.geojson)) return false;
  if (!isCoord(value.waypointA) || !isCoord(value.waypointB)) return false;
  if (!Array.isArray(value.additionalWaypoints) || !value.additionalWaypoints.every(isCoord)) {
    return false;
  }
  if (typeof value.dateIso !== "string" || typeof value.timeOfDayMinutes !== "number") return false;
  return true;
}

function isV2Record(value: RecordValue): value is RecordValue & { trip: Trip } {
  if (value.version !== 2 || !isV1Record({ ...value, version: 1 })) return false;
  const trip = value.trip;
  if (!record(trip) || typeof trip.id !== "string" || typeof trip.defaultMode !== "string") {
    return false;
  }
  if (!Array.isArray(trip.stops) || !Array.isArray(trip.legs)) return false;
  if (!record(trip.departAt) || typeof trip.departAt.instant !== "string") return false;
  return trip.stops.every(
    (stop) => record(stop) && typeof stop.id === "string" && isCoord(stop.coord),
  );
}

/**
 * v1 → v2: rebuild the journey from the legacy fields.
 *
 * v1 stored wall-clock minutes with no zone, so the instant is reconstructed
 * exactly as the legacy load read it — browser-local — and the zone recorded
 * is therefore the BROWSER's, the frame that reading was actually made in.
 * Stamping the departure point's looked-up zone instead would pair an instant
 * with a zone it was not derived in: a route saved in Tokyo and reopened in
 * New York would format to a time the record cannot back. What the record
 * supports is "this wall-clock reading, in whatever zone the reader is in".
 *
 * Deterministic: ids derive from the record's own id, so re-reading the same
 * stored record yields the same `Trip.id` and `Stop.id` every time. That
 * matters because `createRoute`/`updateRoute`/`deleteRoute` all go through
 * `saveRoutes(getRoutes()…)`, which PERSISTS whatever the migration produced —
 * minted ids would be frozen into storage at whatever the first read invented.
 * #357's import path depends on this to carry identity across origins.
 */
export function migrateV1ToV2(value: RecordValue): SavedRoute {
  const recordId = value.id as string;
  const waypointA = value.waypointA as [number, number];
  const timeOfDayMinutes = value.timeOfDayMinutes as number;
  const d = new Date(`${value.dateIso}T00:00:00`);
  d.setHours(Math.floor(timeOfDayMinutes / 60), timeOfDayMinutes % 60, 0, 0);
  const trip = buildTrip({
    departAt: {
      instant: d.toISOString(),
      zone: browserZone(),
    },
    defaultMode: "walk",
    id: `${recordId}:trip`,
    stops: [
      {
        coord: waypointA,
        label: (value.waypointALabel as string | null) ?? null,
        id: `${recordId}:stop:0`,
      },
      ...(value.additionalWaypoints as [number, number][]).map((coord, i) => ({
        coord,
        id: `${recordId}:stop:${i + 1}`,
      })),
      {
        coord: value.waypointB as [number, number],
        label: (value.waypointBLabel as string | null) ?? null,
        id: `${recordId}:stop:${(value.additionalWaypoints as unknown[]).length + 1}`,
      },
    ],
  });
  const migrated: SavedRoute = { ...(value as unknown as SavedRoute), version: 2, trip };
  return migrated.routeOption?.objective === undefined &&
    (migrated.routeOption?.dryCoverage !== undefined || migrated.routeOption?.exposure?.objective === "rain")
    ? { ...migrated, legacyRainResult: true }
    : migrated;
}

/**
 * Validate one stored record and migrate it to v2. Returns null for anything
 * unreadable — including unknown future versions, which must quarantine
 * rather than be guessed at. Pure: quarantine persistence lives in
 * `getRoutes`, so this stays usable from the #357 import path on any origin.
 */
export function normalizeSavedRoute(raw: unknown): SavedRoute | null {
  if (!record(raw)) return null;
  if (raw.version !== undefined && raw.version !== 1 && raw.version !== 2) return null;
  if (raw.version === 2) {
    if (!isV2Record(raw)) return null;
    const saved = raw as unknown as SavedRoute;
    // Older v2 records sometimes stored conditions only in the evaluated
    // snapshot. Normalize both sources at the storage boundary so a malformed
    // or partial manual-wind object cannot throw while a saved-route list is
    // being opened.
    if (saved.exposureSettings || saved.evaluatedConditions) {
      saved.exposureSettings = normalizeExposureSettings(
        saved.exposureSettings ?? saved.evaluatedConditions,
      );
    }
    // JSON storage turns context dates into strings. Restore them before a
    // consumer passes the route to the renderer or a refresh job. Older v2
    // records may have kept the same context in `evaluatedConditions` rather
    // than on the route option, so accept both locations.
    const context = saved.routeOption?.evaluatedContext ?? saved.evaluatedConditions?.evaluatedContext;
    if (context) {
      const rawTime = (context as unknown as { time?: unknown }).time;
      const parsedTime = rawTime instanceof Date
        ? new Date(rawTime.getTime())
        : typeof rawTime === "string"
          ? new Date(rawTime)
          : null;
      const forecastRaw = (context as unknown as { forecastHour?: unknown }).forecastHour;
      const parsedForecast = forecastRaw instanceof Date
        ? new Date(forecastRaw.getTime())
        : typeof forecastRaw === "string"
          ? new Date(forecastRaw)
          : null;
      if (parsedTime && !Number.isNaN(parsedTime.getTime())) {
        saved.routeOption = {
          ...saved.routeOption,
          ...(saved.routeOption.objective == null && saved.evaluatedConditions?.objective
            ? { objective: saved.evaluatedConditions.objective }
            : {}),
          evaluatedContext: {
            ...(context as unknown as ResolvedExposureContext),
            time: parsedTime,
            forecastHour: parsedForecast && !Number.isNaN(parsedForecast.getTime()) ? parsedForecast : null,
          },
        };
      }
    }
    if (
      saved.routeOption?.objective === undefined &&
      (saved.routeOption?.dryCoverage !== undefined || saved.routeOption?.exposure?.objective === "rain")
    ) {
      return { ...saved, legacyRainResult: true };
    }
    return saved;
  }
  return isV1Record(raw) ? migrateV1ToV2(raw) : null;
}

function quarantineRoutes(bad: unknown[]): void {
  if (bad.length === 0) return;
  let existing: unknown[];
  try {
    const raw = localStorage.getItem(QUARANTINE_KEY);
    existing = raw ? (JSON.parse(raw) as unknown[]) : [];
    if (!Array.isArray(existing)) existing = [];
  } catch {
    existing = [];
  }
  const seen = new Set(existing.map((item) => JSON.stringify(item)));
  let added = false;
  for (const item of bad) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      existing.push(item);
      added = true;
    }
  }
  // Side effect, but idempotent and converging: once quarantined, later reads
  // write nothing. (Reads already write in `migrateBrowserStorage`'s precedent.)
  if (added) {
    try {
      localStorage.setItem(QUARANTINE_KEY, JSON.stringify(existing));
    } catch { /* Storage denial must not break listing routes. */ }
  }
}

export function getFolders(): SavedFolder[] {
  return readJSON<SavedFolder[]>(FOLDERS_KEY, []);
}

export function saveFolders(folders: SavedFolder[]): void {
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
}

export function getRoutes(): SavedRoute[] {
  const raw = readJSON<unknown>(ROUTES_KEY, []);
  if (!Array.isArray(raw)) return [];
  const routes: SavedRoute[] = [];
  const bad: unknown[] = [];
  for (const item of raw) {
    const normalized = normalizeSavedRoute(item);
    if (normalized) routes.push(normalized);
    else bad.push(item);
  }
  quarantineRoutes(bad);
  return routes;
}

export function saveRoutes(routes: SavedRoute[]): void {
  localStorage.setItem(ROUTES_KEY, JSON.stringify(routes));
}

export function createFolder(name: string): SavedFolder {
  const folder: SavedFolder = { id: crypto.randomUUID(), name, createdAt: Date.now() };
  saveFolders([...getFolders(), folder]);
  return folder;
}

export function deleteFolder(id: string): void {
  saveFolders(getFolders().filter(f => f.id !== id));
  // orphan routes (set folderId null)
  saveRoutes(getRoutes().map(r => r.folderId === id ? { ...r, folderId: null } : r));
}

export function createRoute(route: Omit<SavedRoute, "id" | "createdAt">): SavedRoute {
  const saved: SavedRoute = { ...route, id: crypto.randomUUID(), createdAt: Date.now() };
  saveRoutes([...getRoutes(), saved]);
  return saved;
}

export function updateRoute(id: string, patch: Partial<SavedRoute>): void {
  saveRoutes(getRoutes().map(r => r.id === id ? { ...r, ...patch } : r));
}

export function deleteRoute(id: string): void {
  saveRoutes(getRoutes().filter(r => r.id !== id));
}
