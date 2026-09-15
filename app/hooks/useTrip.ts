import { useCallback, useEffect, useRef, useState } from "react";
import type maplibregl from "maplibre-gl";
import { geocodeReverse } from "../lib/nominatim";
import { createRoute, getRoutes, getFolders, updateRoute, deleteRoute } from "../lib/savedRoutes";
import type { SavedRoute, SavedFolder } from "../lib/savedRoutes";
import type { NavSeam } from "./useRouting";

/**
 * Trip state, extracted from `useNavigation` (G6a): waypoints A/B with labels,
 * via stops, the pending map-click slot, the user location, saved routes and
 * the save-modal slot, plus their handlers.
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
  seam: React.MutableRefObject<NavSeam>;
}

export function useTrip({ mapRef, dateRef, setDate, seam }: UseTripArgs) {
  const [waypointA, setWaypointA] = useState<[number, number] | null>(null);
  const [waypointB, setWaypointB] = useState<[number, number] | null>(null);
  const [waypointALabel, setWaypointALabel] = useState<string | null>(null);
  const [waypointBLabel, setWaypointBLabel] = useState<string | null>(null);
  const [pendingSlot, setPendingSlot] = useState<"A" | "B" | null>(null);
  const pendingSlotRef = useRef<"A" | "B" | null>(null);
  pendingSlotRef.current = pendingSlot;

  const [saveModalRouteIndex, setSaveModalRouteIndex] = useState<number | null>(null);
  const [additionalWaypoints, setAdditionalWaypoints] = useState<[number, number][]>([]);
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
      if (!route || !waypointA || !waypointB) return;
      const d = dateRef.current;
      const dateIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      createRoute({
        name,
        folderId,
        routeOption: route,
        waypointA,
        waypointB,
        waypointALabel: waypointALabel ?? null,
        waypointBLabel: waypointBLabel ?? null,
        additionalWaypoints: additionalWaypoints,
        timeOfDayMinutes: Math.floor(d.getHours() * 60 + d.getMinutes()),
        dateIso,
      });
      setSavedRoutes(getRoutes());
      setSavedFolders(getFolders());
      setSaveModalRouteIndex(null);
    },
    [
      saveModalRouteIndex,
      seam,
      waypointA,
      waypointB,
      waypointALabel,
      waypointBLabel,
      additionalWaypoints,
      dateRef,
    ],
  );

  const handleLoadRoute = useCallback(
    (saved: SavedRoute) => {
      seam.current.cancelInFlightCalculation();
      setWaypointA(saved.waypointA);
      setWaypointB(saved.waypointB);
      setWaypointALabel(saved.waypointALabel);
      setWaypointBLabel(saved.waypointBLabel);
      setAdditionalWaypoints(saved.additionalWaypoints ?? []);
      seam.current.setNavRoutes([saved.routeOption]);
      seam.current.setSelectedRouteIndex(0);
      const d = new Date(saved.dateIso + "T00:00:00");
      d.setHours(Math.floor(saved.timeOfDayMinutes / 60), saved.timeOfDayMinutes % 60, 0, 0);
      setDate(d);
    },
    [seam, setDate],
  );

  const handleRemoveAdditionalWaypoint = useCallback(
    (index: number) => {
      seam.current.cancelInFlightCalculation();
      setAdditionalWaypoints((prev) => prev.filter((_, i) => i !== index));
      seam.current.setNavRoutes([]);
      seam.current.setSelectedRouteIndex(0);
    },
    [seam],
  );

  const handleSetAdditionalWaypoints = useCallback(
    (waypoints: [number, number][]) => {
      seam.current.cancelInFlightCalculation();
      setAdditionalWaypoints(waypoints);
      seam.current.setNavRoutes([]);
      seam.current.setSelectedRouteIndex(0);
    },
    [seam],
  );

  const handleAddAdditionalWaypoint = useCallback(
    (coord: [number, number]) => {
      seam.current.cancelInFlightCalculation();
      setAdditionalWaypoints((prev) => [...prev, coord]);
      seam.current.setNavRoutes([]);
      seam.current.setSelectedRouteIndex(0);
    },
    [seam],
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
    (coord: [number, number], label: string) => {
      seam.current.cancelInFlightCalculation();
      setWaypointA(coord);
      setWaypointALabel(label);
      seam.current.setNavRoutes([]);
      seam.current.setSelectedRouteIndex(0);
      const map = mapRef.current;
      if (map) map.jumpTo({ center: coord, zoom: Math.max(map.getZoom(), 15) });
    },
    [seam, mapRef],
  );

  const handleSetWaypointB = useCallback(
    (coord: [number, number], label: string) => {
      seam.current.cancelInFlightCalculation();
      setWaypointB(coord);
      setWaypointBLabel(label);
      seam.current.setNavRoutes([]);
      seam.current.setSelectedRouteIndex(0);
      const map = mapRef.current;
      if (map) map.jumpTo({ center: coord, zoom: Math.max(map.getZoom(), 15) });
    },
    [seam, mapRef],
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
    const a = waypointARef.current;
    const b = waypointBRef.current;
    const aLabel = waypointALabelRef.current;
    const bLabel = waypointBLabelRef.current;
    seam.current.cancelInFlightCalculation();
    setWaypointA(b);
    setWaypointB(a);
    setWaypointALabel(bLabel);
    setWaypointBLabel(aLabel);
    seam.current.setNavRoutes([]);
    seam.current.setSelectedRouteIndex(0);
  }, [seam]);

  const handleClearWaypointA = useCallback(() => {
    seam.current.cancelInFlightCalculation();
    setWaypointA(null);
    setWaypointALabel(null);
    seam.current.setNavRoutes([]);
    seam.current.setSelectedRouteIndex(0);
  }, [seam]);

  const handleClearWaypointB = useCallback(() => {
    seam.current.cancelInFlightCalculation();
    setWaypointB(null);
    setWaypointBLabel(null);
    seam.current.setNavRoutes([]);
    seam.current.setSelectedRouteIndex(0);
  }, [seam]);

  const handleMarkerDragEnd = useCallback(
    (slot: "A" | "B", coord: { lng: number; lat: number }) => {
      const lngLat: [number, number] = [coord.lng, coord.lat];
      const coordLabel = `${coord.lat.toFixed(3)}, ${coord.lng.toFixed(3)}`;
      seam.current.cancelInFlightCalculation();
      seam.current.setNavRoutes([]);
      seam.current.setSelectedRouteIndex(0);
      if (slot === "A") {
        setWaypointA(lngLat);
        setWaypointALabel(coordLabel);
        geocodeReverse(coord.lat, coord.lng).then((lbl) => {
          if (lbl) setWaypointALabel(lbl);
        });
      } else {
        setWaypointB(lngLat);
        setWaypointBLabel(coordLabel);
        geocodeReverse(coord.lat, coord.lng).then((lbl) => {
          if (lbl) setWaypointBLabel(lbl);
        });
      }
    },
    [seam],
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
    setWaypointA,
    setWaypointB,
    setWaypointALabel,
    setWaypointBLabel,
    setPendingSlot,
    setSaveModalRouteIndex,
    setAdditionalWaypoints,
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
