import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type maplibregl from "maplibre-gl";
import { geocodeReverse } from "../lib/nominatim";
import { createRoute, getRoutes, getFolders, updateRoute, deleteRoute } from "../lib/savedRoutes";
import type { SavedRoute, SavedFolder } from "../lib/savedRoutes";
import {
  addStop,
  buildTrip,
  makeStop,
  removeStop,
  replaceStops,
  swapStops,
  withDefaultMode,
} from "../lib/trip/trip";
import type { StopEntry, Trip } from "../lib/trip/types";
import type { TravelModeId } from "../lib/travelMode";
import { zoneAt } from "../lib/tzLookup";
import type { NavSeam } from "./useRouting";

/**
 * Trip state, extracted from `useNavigation` (G6a). A `Trip` is the source of
 * truth for the journey's stops; the legacy waypointA/B + labels + via stops
 * shape is DERIVED from it so the `useNavigation` facade contract (pinned by
 * `useNavigationKeys.test.ts`) and every existing consumer keep working.
 *
 * Two deliberate mappings, both recorded in the E5 decisions:
 * - Which edges of the list are the origin and destination is remembered
 *   separately (`slotsRef`, a `SlotFill`): the legacy slots allow "B without
 *   A" (destination typed first) and "A plus stops, no destination yet", while
 *   a trip only orders stops. That is UI slot memory, not journey state.
 * - `departAt`/`defaultMode` sync from the map date, the departure stop's
 *   zone and the facade's travel mode during render (derived state, converged
 *   by comparison — no churn, no loop). Loading a record stamps its own
 *   anchor through the same path once its date commits.
 *
 * One mutation per event: every handler commits a single `setTrip`, so
 * updaters never observe a half-applied batch. The agent plan paths use the
 * single `replaceAllStops` op rather than the old setter sequence.
 *
 * The seam with `useRouting` arrives as a stable ref wired by the
 * `useNavigation` facade: trip is constructed before routing (routing reads
 * trip state), so trip handlers read routing's cancel/clear setters and the
 * current route list lazily through `seam.current` at event time. All seam
 * reads are event-time; the callbacks list only `seam` itself.
 */
export interface UseTripArgs {
  mapRef: React.MutableRefObject<maplibregl.Map | null>;
  dateRef: React.MutableRefObject<Date>;
  setDate: React.Dispatch<React.SetStateAction<Date>>;
  travelMode: TravelModeId;
  seam: React.MutableRefObject<NavSeam>;
}

/**
 * Dwell per stop, positional, as one comparable string. `useRouting`
 * fingerprints this to tell a dwell edit (which must invalidate an agent job,
 * C5) from the plan commit it asked for itself, so both producers — the render
 * memo and `replaceAllStops` — must derive it the same way.
 */
function dwellSignatureOf(trip: Trip): string {
  return JSON.stringify(trip.stops.map((s) => s.dwellMinutes ?? 0));
}

/** Full stop entries for index-wise replacement (id-preserving). */
function entriesOf(trip: Trip): StopEntry[] {
  return trip.stops.map((s) => ({
    coord: s.coord,
    label: s.label,
    dwellMinutes: s.dwellMinutes,
    placeId: s.placeId,
  }));
}

/**
 * Which legacy slots the stop list currently fills.
 *
 * The legacy state held `waypointA`, `waypointB` and `additionalWaypoints`
 * independently, so it could express "a destination and two stops, no origin
 * yet" — an ordered list cannot. These two booleans carry exactly that missing
 * information and nothing else: the first stop is the origin only when
 * `origin` is set, the last is the destination only when `dest` is set, and
 * everything between them is a via stop.
 *
 * A single flag for the one-stop case is NOT enough: clearing the origin of
 * [A, via, B] must leave [via, B] with no origin, or the via is silently
 * promoted into the start field and vanishes from the stop list.
 */
interface SlotFill {
  origin: boolean;
  dest: boolean;
}

/** Resolve the slots against a stop count, so the pair can never over-claim. */
function resolveSlots(stopCount: number, slots: SlotFill) {
  const origin = slots.origin && stopCount >= 1;
  const dest = slots.dest && stopCount >= (origin ? 2 : 1);
  return {
    origin,
    dest,
    /** Index range of the via stops, [start, end). */
    viaStart: origin ? 1 : 0,
    viaEnd: dest ? stopCount - 1 : stopCount,
  };
}

/**
 * Slot-aware upsert, pure. Replaces the slot's stop when that slot is filled,
 * otherwise inserts one at the slot's edge and leaves every other stop alone.
 *
 * The entry is built fresh rather than spread over the outgoing stop: a slot
 * being pointed at a different place must not inherit the previous occupant's
 * dwell or `placeId`. `replaceStops` still keeps the id when the coordinate
 * did not move, which is the case that means "same stop, relabelled".
 */
function upsertSlot(
  prev: Trip,
  slot: "A" | "B",
  slots: SlotFill,
  coord: [number, number],
  label?: string | null,
  dwellMinutes?: number,
): Trip {
  const r = resolveSlots(prev.stops.length, slots);
  const entries = entriesOf(prev);
  const entry: StopEntry = { coord, label: label ?? null, dwellMinutes };
  if (slot === "A") {
    if (r.origin) entries[0] = entry;
    else entries.unshift(entry);
  } else {
    if (r.dest) entries[entries.length - 1] = entry;
    else entries.push(entry);
  }
  return replaceStops(prev, entries);
}

export function useTrip({ mapRef, dateRef, setDate, travelMode, seam }: UseTripArgs) {
  const [trip, setTrip] = useState<Trip>(() =>
    buildTrip({
      stops: [],
      departAt: { instant: new Date(0).toISOString(), zone: "UTC" },
      defaultMode: "walk",
    }),
  );
  const tripRef = useRef(trip);
  tripRef.current = trip;
  const slotsRef = useRef<SlotFill>({ origin: false, dest: false });

  // Anchor the journey to the map date and the departure stop's real zone.
  // The zone lookup resolves asynchronously; until it does the existing zone
  // stands (a loaded record keeps its anchor instead of flapping to UTC).
  const departInstant = dateRef.current.toISOString();
  const firstCoord = trip.stops[0]?.coord ?? null;
  // Keyed on the coordinate: the lookup is a point-in-polygon over a 29 kB
  // boundary set, and this runs on every render of a hook the map re-renders.
  const lookedUpZone = useMemo(
    () => (firstCoord ? zoneAt(firstCoord[1], firstCoord[0]) : null),
    [firstCoord],
  );
  const departZone = lookedUpZone ?? trip.departAt.zone;
  if (
    trip.defaultMode !== travelMode ||
    trip.departAt.instant !== departInstant ||
    trip.departAt.zone !== departZone
  ) {
    setTrip((prev) => {
      const next = withDefaultMode(prev, travelMode);
      if (next.departAt.instant === departInstant && next.departAt.zone === departZone) return next;
      return { ...next, departAt: { instant: departInstant, zone: departZone } };
    });
  }

  // Derive the legacy slot shape from the stop list plus which edges are
  // filled. Reading position alone loses the distinction the legacy state
  // carried, and promotes a via stop into a cleared endpoint.
  const slots = resolveSlots(trip.stops.length, slotsRef.current);
  const stopA = slots.origin ? trip.stops[0] : null;
  const stopB = slots.dest ? trip.stops[trip.stops.length - 1] : null;
  const waypointA = stopA?.coord ?? null;
  const waypointB = stopB?.coord ?? null;
  const waypointALabel = stopA?.label ?? null;
  const waypointBLabel = stopB?.label ?? null;
  // Memoized: `useRouting`'s plan-revision effect depends on this identity,
  // so a fresh array every render would advance the revision every render.
  const additionalWaypoints = useMemo(
    () => trip.stops.slice(slots.viaStart, slots.viaEnd).map((s) => s.coord),
    [trip.stops, slots.viaStart, slots.viaEnd],
  );
  /** Dwell per stop, positional. The plan-revision fingerprint reads this so
   * dwell edits invalidate agent jobs exactly like coordinate edits (C5). */
  const dwellSignature = useMemo(() => dwellSignatureOf(trip), [trip]);
  /** Dwell minutes positional over [A, ...via, B] — the share URL's `dwell`
   * parameter reads this. Zeros where no dwell is set. */
  const dwellMinutes = useMemo(
    () => trip.stops.map((s) => s.dwellMinutes ?? 0),
    [trip.stops],
  );

  const [pendingSlot, setPendingSlot] = useState<"A" | "B" | null>(null);
  const pendingSlotRef = useRef<"A" | "B" | null>(null);
  pendingSlotRef.current = pendingSlot;

  const [saveModalRouteIndex, setSaveModalRouteIndex] = useState<number | null>(null);
  const [savedRoutes, setSavedRoutes] = useState<SavedRoute[]>(() => getRoutes());
  const [savedFolders, setSavedFolders] = useState<SavedFolder[]>(() => getFolders());

  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);
  const [isLocating, setIsLocating] = useState(false);

  // Refs for stale-closure avoidance
  const waypointARef = useRef(waypointA);
  const waypointBRef = useRef(waypointB);
  const waypointALabelRef = useRef(waypointALabel);
  const waypointBLabelRef = useRef(waypointBLabel);
  const dragSlotRef = useRef<"A" | "B" | null>(null);
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const dragActiveRef = useRef(false);
  const ghostElRef = useRef<HTMLDivElement | null>(null);

  waypointARef.current = waypointA;
  waypointBRef.current = waypointB;
  waypointALabelRef.current = waypointALabel;
  waypointBLabelRef.current = waypointBLabel;

  // Escape to cancel pending slot
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPendingSlot(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const clearRoutes = useCallback(() => {
    seam.current.setNavRoutes([]);
    seam.current.setSelectedRouteIndex(0);
  }, [seam]);

  /**
   * Replace the whole stop list at once (agent plans, loaded records), and
   * return the dwell signature of the trip this actually commits.
   *
   * The caller needs that value, not a guess at it: `replaceStops` PRESERVES an
   * existing stop's dwell when the coordinates match and the entry leaves
   * `dwellMinutes` undefined, so a plan issued over a trip that already has
   * dwell commits a non-zero signature. `useRouting` fingerprints this to skip
   * exactly one revision bump; asserting "all zeros" there instead would miss
   * the skip, bump twice, and supersede the agent's own job.
   */
  const replaceAllStops = useCallback(
    (entries: StopEntry[]): string => {
      seam.current.cancelInFlightCalculation();
      slotsRef.current = { origin: entries.length >= 1, dest: entries.length >= 2 };
      const next = replaceStops(tripRef.current, entries);
      setTrip(next);
      clearRoutes();
      return dwellSignatureOf(next);
    },
    [seam, clearRoutes],
  );

  const clearTrip = useCallback(() => {
    slotsRef.current = { origin: false, dest: false };
    setTrip((prev) =>
      buildTrip({ stops: [], departAt: prev.departAt, defaultMode: prev.defaultMode }),
    );
  }, []);

  /** Relabel one slot's stop; a no-op when the slot holds no stop. */
  const relabelWaypoint = useCallback((slot: "A" | "B", label: string | null) => {
    setTrip((t) => {
      const r = resolveSlots(t.stops.length, slotsRef.current);
      if (slot === "A" ? !r.origin : !r.dest) return t;
      const at = slot === "A" ? 0 : t.stops.length - 1;
      const entries = entriesOf(t);
      entries[at] = { ...entries[at], label };
      return replaceStops(t, entries);
    });
  }, []);

  const handleOpenSaveModal = useCallback(
    (routeIndex: number) => {
      if (seam.current.navRoutes[routeIndex]?.partial) return;
      setSaveModalRouteIndex(routeIndex);
    },
    [seam],
  );

  const handleConfirmSave = useCallback(
    (name: string, folderId: string | null) => {
      if (saveModalRouteIndex === null) return;
      const route = seam.current.navRoutes[saveModalRouteIndex];
      const journey = tripRef.current;
      if (!route || journey.stops.length < 2) return;
      const first = journey.stops[0];
      const last = journey.stops[journey.stops.length - 1];
      const d = dateRef.current;
      const dateIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      createRoute({
        name,
        folderId,
        routeOption: route,
        // Legacy fields stay for readability and for any tooling that inspects
        // stored records; the trip is the source of truth from v2 on.
        waypointA: first.coord,
        waypointB: last.coord,
        waypointALabel: first.label,
        waypointBLabel: last.label,
        additionalWaypoints: journey.stops.slice(1, -1).map((s) => s.coord),
        timeOfDayMinutes: Math.floor(d.getHours() * 60 + d.getMinutes()),
        dateIso,
        version: 2,
        trip: journey,
      });
      setSavedRoutes(getRoutes());
      setSavedFolders(getFolders());
      setSaveModalRouteIndex(null);
    },
    [saveModalRouteIndex, seam, dateRef],
  );

  const handleLoadRoute = useCallback(
    (saved: SavedRoute) => {
      seam.current.cancelInFlightCalculation();
      if (saved.version === 2 && saved.trip) {
        // Adopt the saved journey wholesale (copied — state never aliases
        // storage). The render sync keeps the current travel mode, exactly as
        // v1 loads never touched it.
        const journey = saved.trip;
        slotsRef.current = { origin: journey.stops.length >= 1, dest: journey.stops.length >= 2 };
        setTrip({
          ...journey,
          stops: journey.stops.map((s) => ({ ...s })),
          legs: journey.legs.map((l) => ({ ...l })),
          departAt: { ...journey.departAt },
        });
        const at = new Date(journey.departAt.instant);
        if (!Number.isNaN(at.getTime())) setDate(at);
      } else {
        // A v1 record carries no dwell, so every stop's dwell is stated as 0
        // rather than left undefined — `replaceStops` preserves the dwell of a
        // coordinate-matched stop, which would otherwise let the journey
        // currently on screen leak its dwell into the loaded one.
        slotsRef.current = { origin: true, dest: true };
        setTrip((prev) =>
          replaceStops(prev, [
            { coord: saved.waypointA, label: saved.waypointALabel, dwellMinutes: 0 },
            ...saved.additionalWaypoints.map((coord) => ({ coord, dwellMinutes: 0 })),
            { coord: saved.waypointB, label: saved.waypointBLabel, dwellMinutes: 0 },
          ]),
        );
        const d = new Date(saved.dateIso + "T00:00:00");
        d.setHours(Math.floor(saved.timeOfDayMinutes / 60), saved.timeOfDayMinutes % 60, 0, 0);
        setDate(d);
      }
      seam.current.setNavRoutes([saved.routeOption]);
      seam.current.setSelectedRouteIndex(0);
    },
    [seam, setDate],
  );

  const handleRemoveAdditionalWaypoint = useCallback(
    (index: number) => {
      seam.current.cancelInFlightCalculation();
      setTrip((prev) => {
        const r = resolveSlots(prev.stops.length, slotsRef.current);
        if (index < 0 || index >= r.viaEnd - r.viaStart) return prev;
        return removeStop(prev, r.viaStart + index);
      });
      clearRoutes();
    },
    [seam, clearRoutes],
  );

  const handleSetAdditionalWaypoints = useCallback(
    (waypoints: [number, number][], dwellMinutes?: number[]) => {
      seam.current.cancelInFlightCalculation();
      setTrip((prev) => {
        // Replace the via RANGE, leaving whichever endpoints exist in place.
        // Appending instead would make a via the destination of a trip that
        // has none yet, which is how a `b`+`via` share link lost its slots.
        const r = resolveSlots(prev.stops.length, slotsRef.current);
        const entries = entriesOf(prev);
        const middles = waypoints.map((coord, i) => ({ coord, dwellMinutes: dwellMinutes?.[i] }));
        return replaceStops(prev, [
          ...entries.slice(0, r.viaStart),
          ...middles,
          ...entries.slice(r.viaEnd),
        ]);
      });
      clearRoutes();
    },
    [seam, clearRoutes],
  );

  const handleAddAdditionalWaypoint = useCallback(
    (coord: [number, number]) => {
      seam.current.cancelInFlightCalculation();
      // Append to the via range. Adding a stop must never claim an endpoint
      // slot — doing so swapped the user's destination into the start field.
      setTrip((t) => {
        const r = resolveSlots(t.stops.length, slotsRef.current);
        return addStop(t, makeStop(coord), r.viaEnd);
      });
      clearRoutes();
    },
    [seam, clearRoutes],
  );

  const handleDeleteSavedRoute = useCallback((id: string) => {
    deleteRoute(id);
    setSavedRoutes(getRoutes());
  }, []);

  const handleRenameSavedRoute = useCallback((id: string, name: string) => {
    updateRoute(id, { name });
    setSavedRoutes(getRoutes());
  }, []);

  const handleLocateMe = useCallback(() => {
    if (!navigator.geolocation) {
      seam.current.setNavError("Geolocation is not supported by your browser.");
      return;
    }
    setIsLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords: [number, number] = [pos.coords.longitude, pos.coords.latitude];
        setUserLocation(coords);
        setIsLocating(false);
        mapRef.current?.jumpTo({ center: coords, zoom: 15 });
      },
      () => {
        seam.current.setNavError("Unable to get your location. Check browser permissions.");
        setIsLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, [mapRef, seam]);

  const handleSetWaypointA = useCallback(
    (coord: [number, number], label: string, opts?: { jump?: boolean; dwellMinutes?: number }) => {
      const slotsAtEvent = slotsRef.current;
      slotsRef.current = { ...slotsAtEvent, origin: true };
      seam.current.cancelInFlightCalculation();
      setTrip((t) => upsertSlot(t, "A", slotsAtEvent, coord, label, opts?.dwellMinutes));
      clearRoutes();
      const map = mapRef.current;
      if (map && opts?.jump !== false) map.jumpTo({ center: coord, zoom: Math.max(map.getZoom(), 15) });
    },
    [seam, clearRoutes, mapRef],
  );

  const handleSetWaypointB = useCallback(
    (coord: [number, number], label: string, opts?: { jump?: boolean; dwellMinutes?: number }) => {
      const slotsAtEvent = slotsRef.current;
      slotsRef.current = { ...slotsAtEvent, dest: true };
      seam.current.cancelInFlightCalculation();
      setTrip((t) => upsertSlot(t, "B", slotsAtEvent, coord, label, opts?.dwellMinutes));
      clearRoutes();
      const map = mapRef.current;
      if (map && opts?.jump !== false) map.jumpTo({ center: coord, zoom: Math.max(map.getZoom(), 15) });
    },
    [seam, clearRoutes, mapRef],
  );

  const handleUseLocationAsA = useCallback(
    (coord: [number, number]) => {
      handleSetWaypointA(coord, "Your location");
    },
    [handleSetWaypointA],
  );

  const handleUseLocationAsB = useCallback(
    (coord: [number, number]) => {
      handleSetWaypointB(coord, "Your location");
    },
    [handleSetWaypointB],
  );

  const handleSwapWaypoints = useCallback(() => {
    const r = resolveSlots(tripRef.current.stops.length, slotsRef.current);
    seam.current.cancelInFlightCalculation();
    if (r.origin && r.dest) {
      setTrip((t) => (t.stops.length >= 2 ? swapStops(t, 0, t.stops.length - 1) : t));
    } else if (r.origin || r.dest) {
      // Only one endpoint exists: the stop stays put and changes slot. Commit
      // a new object anyway so the derived waypoints re-render.
      slotsRef.current = { origin: r.dest, dest: r.origin };
      setTrip((t) => ({ ...t }));
    }
    clearRoutes();
  }, [seam, clearRoutes]);

  /**
   * Clear one endpoint. The stop is removed and that edge is marked unfilled,
   * so the neighbouring via stop stays a via — it must NOT slide into the
   * empty slot. `WaypointInput` fires this on the first keystroke of a retype,
   * so a promotion here would delete a stop the user never touched.
   */
  const clearSlot = useCallback(
    (slot: "A" | "B") => {
      const r = resolveSlots(tripRef.current.stops.length, slotsRef.current);
      seam.current.cancelInFlightCalculation();
      if (slot === "A" ? r.origin : r.dest) {
        slotsRef.current =
          slot === "A" ? { ...slotsRef.current, origin: false } : { ...slotsRef.current, dest: false };
        setTrip((t) => removeStop(t, slot === "A" ? 0 : t.stops.length - 1));
      }
      clearRoutes();
    },
    [seam, clearRoutes],
  );

  const handleClearWaypointA = useCallback(() => clearSlot("A"), [clearSlot]);
  const handleClearWaypointB = useCallback(() => clearSlot("B"), [clearSlot]);

  const handleMarkerDragEnd = useCallback(
    (slot: "A" | "B", coord: { lng: number; lat: number }) => {
      const lngLat: [number, number] = [coord.lng, coord.lat];
      const coordLabel = `${coord.lat.toFixed(3)}, ${coord.lng.toFixed(3)}`;
      const slotsAtEvent = slotsRef.current;
      slotsRef.current =
        slot === "A" ? { ...slotsAtEvent, origin: true } : { ...slotsAtEvent, dest: true };
      seam.current.cancelInFlightCalculation();
      clearRoutes();
      setTrip((t) => upsertSlot(t, slot, slotsAtEvent, lngLat, coordLabel));
      geocodeReverse(coord.lat, coord.lng).then((lbl) => {
        if (lbl) relabelWaypoint(slot, lbl);
      });
    },
    [seam, clearRoutes, relabelWaypoint],
  );

  const handlePinDragStart = useCallback(
    (slot: "A" | "B") => {
      dragSlotRef.current = slot;
      dragActiveRef.current = false;
      dragStartPos.current = null;

      const color = slot === "A" ? "#22c55e" : "#ef4444";

      function onMove(e: PointerEvent) {
        const { clientX: x, clientY: y } = e;

        if (!dragStartPos.current) {
          dragStartPos.current = { x, y };
          return;
        }

        const dx = x - dragStartPos.current.x;
        const dy = y - dragStartPos.current.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (!dragActiveRef.current && dist > 6) {
          dragActiveRef.current = true;
          document.body.style.userSelect = "none";

          const ghost = document.createElement("div");
          ghost.style.cssText = [
            "position:fixed",
            "pointer-events:none",
            "z-index:9999",
            "transform:translate(-50%, -100%)",
            "transition:none",
          ].join(";");
          ghost.innerHTML = `<svg width="24" height="28" viewBox="0 0 12 14" fill="${color}" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 2px 4px rgba(0,0,0,0.5))"><path d="M6 0C3.24 0 1 2.24 1 5c0 3.75 5 9 5 9s5-5.25 5-9c0-2.76-2.24-5-5-5zm0 6.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>`;
          ghost.style.left = x + "px";
          ghost.style.top = y + "px";
          document.body.appendChild(ghost);
          ghostElRef.current = ghost;
        }

        if (dragActiveRef.current && ghostElRef.current) {
          ghostElRef.current.style.left = x + "px";
          ghostElRef.current.style.top = y + "px";
        }
      }

      function onUp(e: PointerEvent) {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.userSelect = "";

        if (ghostElRef.current) {
          ghostElRef.current.remove();
          ghostElRef.current = null;
        }

        if (!dragActiveRef.current) return;
        dragActiveRef.current = false;

        const currentSlot = dragSlotRef.current;
        if (!currentSlot) return;

        const map = mapRef.current;
        if (!map) return;

        const mapEl = map.getContainer();
        const rect = mapEl.getBoundingClientRect();
        const relX = e.clientX - rect.left;
        const relY = e.clientY - rect.top;

        if (relX < 0 || relY < 0 || relX > rect.width || relY > rect.height) return;

        const lngLat = map.unproject([relX, relY]);
        handleMarkerDragEnd(currentSlot, { lng: lngLat.lng, lat: lngLat.lat });
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [handleMarkerDragEnd, mapRef],
  );

  return {
    trip,
    dwellSignature,
    dwellMinutes,
    replaceAllStops,
    clearTrip,
    relabelWaypoint,
    waypointA,
    waypointB,
    waypointALabel,
    waypointBLabel,
    pendingSlot,
    saveModalRouteIndex,
    additionalWaypoints,
    savedRoutes,
    savedFolders,
    userLocation,
    isLocating,
    waypointARef,
    waypointBRef,
    waypointALabelRef,
    waypointBLabelRef,
    pendingSlotRef,
    setPendingSlot,
    setSaveModalRouteIndex,
    handleOpenSaveModal,
    handleConfirmSave,
    handleLoadRoute,
    handleRemoveAdditionalWaypoint,
    handleSetAdditionalWaypoints,
    handleAddAdditionalWaypoint,
    handleDeleteSavedRoute,
    handleRenameSavedRoute,
    handleLocateMe,
    handleSetWaypointA,
    handleSetWaypointB,
    handleUseLocationAsA,
    handleUseLocationAsB,
    handleSwapWaypoints,
    handleClearWaypointA,
    handleClearWaypointB,
    handleMarkerDragEnd,
    handlePinDragStart,
  };
}

export type UseTripResult = ReturnType<typeof useTrip>;
