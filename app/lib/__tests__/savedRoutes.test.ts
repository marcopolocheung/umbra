import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRoute,
  getRoutes,
  normalizeSavedRoute,
} from "../savedRoutes";
import { V1_SAVED_ROUTE } from "./savedRoutesV1.fixture";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    clear: () => data.clear(),
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

describe("normalizeSavedRoute", () => {
  it("migrates a real v1 record to a v2 trip", () => {
    // From disk, through JSON — the migration reads stored bytes, not objects.
    const raw = JSON.parse(JSON.stringify(V1_SAVED_ROUTE)) as unknown;
    const migrated = normalizeSavedRoute(raw);
    expect(migrated?.version).toBe(2);
    expect(migrated?.id).toBe("v1-record-1");
    // Journey rebuilt from the legacy fields, in order.
    expect(migrated?.trip?.stops.map((s) => [s.coord, s.label])).toEqual([
      [[-3.7, 40.41], "Café"],
      [[-3.69, 40.415], null],
      [[-3.68, 40.42], "Park"],
    ]);
    expect(migrated?.trip?.legs).toEqual([
      { from: 0, to: 1, mode: "walk" },
      { from: 1, to: 2, mode: "walk" },
    ]);
    expect(migrated?.trip?.defaultMode).toBe("walk");
    expect(new Set(migrated?.trip?.stops.map((s) => s.id)).size).toBe(3);
    // The anchor reuses the legacy load's wall-clock reading (09:30 local),
    // stamped with a zone string.
    const instant = new Date(migrated?.trip?.departAt.instant ?? "");
    expect(instant.getHours()).toBe(9);
    expect(instant.getMinutes()).toBe(30);
    // The anchor's zone must be the frame the instant was reconstructed in.
    // v1 stored wall-clock minutes with no zone, so that frame is the reader's
    // own — stamping the departure point's zone would pair the instant with a
    // zone it was not derived in, and formatting the pair would print a time
    // the record cannot back (save in Tokyo, reopen in New York).
    const zone = migrated?.trip?.departAt.zone;
    expect(zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const shown = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: zone,
    }).format(instant);
    expect(shown).toBe("09:30");
    // The legacy fields and the route survive untouched.
    expect(migrated?.waypointA).toEqual([-3.7, 40.41]);
    expect(migrated?.routeOption).toEqual(V1_SAVED_ROUTE.routeOption);
  });

  it("re-migrates the same v1 record to the same ids", () => {
    // `getRoutes()` re-migrates on every read, and `createRoute`/`updateRoute`/
    // `deleteRoute` all persist what it returns via `saveRoutes(getRoutes()…)`.
    // Minted ids would therefore freeze whatever the first read invented —
    // and identity is exactly what C11 asserts survives a revision.
    const once = normalizeSavedRoute(JSON.parse(JSON.stringify(V1_SAVED_ROUTE)) as unknown);
    const twice = normalizeSavedRoute(JSON.parse(JSON.stringify(V1_SAVED_ROUTE)) as unknown);
    expect(once?.trip?.id).toBe(twice?.trip?.id);
    expect(once?.trip?.stops.map((s) => s.id)).toEqual(twice?.trip?.stops.map((s) => s.id));
    // And they are still distinct from each other within the trip.
    expect(new Set(once?.trip?.stops.map((s) => s.id)).size).toBe(3);
  });

  it("passes a v2 record through untouched", () => {
    const v1 = JSON.parse(JSON.stringify(V1_SAVED_ROUTE)) as unknown;
    const v2 = normalizeSavedRoute(v1);
    const again = normalizeSavedRoute(JSON.parse(JSON.stringify(v2)) as unknown);
    expect(again).toEqual(v2);
  });

  it("refuses garbage and unknown future versions without guessing", () => {
    expect(normalizeSavedRoute(null)).toBeNull();
    expect(normalizeSavedRoute([])).toBeNull();
    expect(normalizeSavedRoute({ version: 3, trip: { stops: [] } })).toBeNull();
    expect(normalizeSavedRoute({ ...V1_SAVED_ROUTE, waypointA: "Madrid" })).toBeNull();
    expect(normalizeSavedRoute({ ...V1_SAVED_ROUTE, version: 2 })).toBeNull();
  });
});

describe("getRoutes", () => {
  it("migrates v1 records and quarantines the unreadable instead of dropping them", () => {
    const garbage = { id: "bad", waypointA: "nowhere" };
    localStorage.setItem(
      "umbra:routes",
      JSON.stringify([V1_SAVED_ROUTE, garbage]),
    );
    const routes = getRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0].version).toBe(2);
    expect(routes[0].trip?.stops).toHaveLength(3);
    // The bad record is preserved verbatim, not dropped and not listed.
    const quarantine = JSON.parse(localStorage.getItem("umbra:routes-quarantine") ?? "[]");
    expect(quarantine).toEqual([garbage]);
    // A second read adds nothing twice.
    getRoutes();
    expect(JSON.parse(localStorage.getItem("umbra:routes-quarantine") ?? "[]")).toEqual([garbage]);
  });
});

describe("createRoute", () => {
  it("writes v2 records carrying the trip", () => {
    const v1 = normalizeSavedRoute(JSON.parse(JSON.stringify(V1_SAVED_ROUTE)) as unknown);
    const saved = createRoute({
      name: "Evening loop",
      folderId: null,
      routeOption: V1_SAVED_ROUTE.routeOption as never,
      waypointA: [-3.7, 40.41],
      waypointB: [-3.68, 40.42],
      waypointALabel: "Café",
      waypointBLabel: "Park",
      additionalWaypoints: [[-3.69, 40.415]],
      timeOfDayMinutes: 18 * 60,
      dateIso: "2026-09-15",
      version: 2,
      trip: v1!.trip!,
    });
    expect(saved.version).toBe(2);
    const [listed] = getRoutes();
    expect(listed.id).toBe(saved.id);
    expect(listed.trip?.stops.map((s) => s.label)).toEqual(["Café", null, "Park"]);
  });
});
