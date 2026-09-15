/* @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useNavigation } from "../useNavigation";

vi.mock("../../lib/nominatim", () => ({
  geocodeReverse: vi.fn(),
}));

vi.mock("../../lib/overpass", async () => {
  const actual = await vi.importActual<typeof import("../../lib/overpass")>(
    "../../lib/overpass",
  );
  return { ...actual, fetchRoutingGraph: vi.fn(), fetchStationEntrances: vi.fn() };
});

vi.mock("../../lib/shadowField/ShadowField", async () => {
  const actual = await vi.importActual<typeof import("../../lib/shadowField/ShadowField")>(
    "../../lib/shadowField/ShadowField",
  );
  return { ...actual, createGeometryShadowField: () => null };
});

/**
 * G6(a) seam guard. `useNavigation` is being split into useTrip / useSketch /
 * useRouting behind this facade, and page.tsx, useAgent and every existing test
 * consume the returned object by key. Any added, removed or renamed key breaks
 * them at compile time at best — this test makes the contract explicit so the
 * split cannot silently change it.
 */
describe("useNavigation return contract", () => {
  it("returns exactly the keys its consumers destructure", () => {
    const { result } = renderHook(() =>
      useNavigation({
        mapRef: { current: null },
        dateRef: { current: new Date("2026-08-16T12:00:00Z") },
        setDate: vi.fn(),
      }),
    );
    expect(Object.keys(result.current).sort()).toEqual(
      [
        "additionalWaypoints",
        "canTransit",
        "cancelRoutePlan",
        "createRoutePlanRequest",
        "drawMode",
        "dwellMinutes",
        "filteredRoutes",
        "getCurrentPlanRevision",
        "getRouteReceiptMapObjects",
        "handleAddAdditionalWaypoint",
        "handleCalculateRoute",
        "handleClear",
        "handleClearSketch",
        "handleClearWaypointA",
        "handleClearWaypointB",
        "handleConfirmSave",
        "handleDeleteSavedRoute",
        "handleDrawModeToggle",
        "handleExportRoute",
        "handleLoadRoute",
        "handleLocateMe",
        "handleMapClick",
        "handleMarkerDragEnd",
        "handleOpenSaveModal",
        "handlePinDragStart",
        "handleRemoveAdditionalWaypoint",
        "handleRenameSavedRoute",
        "handleRouteModeChange",
        "handleSetAdditionalWaypoints",
        "handleSetWaypointA",
        "handleSetWaypointB",
        "handleShadowPreferenceChange",
        "handleSketchFinish",
        "handleSketchPointClick",
        "handleSketchPointDrag",
        "handleSwapWaypoints",
        "handleToggleNavMode",
        "handleTravelModeChange",
        "handleUseLocationAsA",
        "handleUseLocationAsB",
        "isCalculating",
        "isLocating",
        "navError",
        "navMode",
        "navMrtEntrances",
        "navRoutes",
        "navTrainDrawData",
        "navWarning",
        "pendingSlot",
        "routeMode",
        "routeProgress",
        "routeSolarIntensity",
        "saveModalRouteIndex",
        "savedFolders",
        "savedRoutes",
        "selectedNavRoute",
        "selectedRouteIndex",
        "setPendingSlot",
        "setSaveModalRouteIndex",
        "setSelectedRouteIndex",
        "shadowField",
        "shadowPreference",
        "simplifiedWaypoints",
        "sketchPoints",
        "submitRoutePlan",
        "travelMode",
        "userLocation",
        "waypointA",
        "waypointALabel",
        "waypointB",
        "waypointBLabel",
      ].sort(),
    );
  });
});
