/* @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useNavigation } from "../useNavigation";

vi.mock("../../lib/nominatim", () => ({
  geocodeReverse: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../lib/overpass", async () => {
  const actual = await vi.importActual<typeof import("../../lib/overpass")>("../../lib/overpass");
  return { ...actual, fetchRoutingGraph: vi.fn(), fetchStationEntrances: vi.fn() };
});

vi.mock("../../lib/shadowField/ShadowField", async () => {
  const actual = await vi.importActual<typeof import("../../lib/shadowField/ShadowField")>(
    "../../lib/shadowField/ShadowField",
  );
  return { ...actual, createGeometryShadowField: () => null };
});

/**
 * E5 turned `waypointA`/`waypointB` and their labels into values DERIVED from
 * the `Trip`, which is the one place this checkpoint can change what the user
 * sees without any test noticing: the facade's key set is unchanged, the route
 * tests never build a partial trip, and `useNavigation.test.tsx` asserts that
 * clearing a waypoint aborts the calculation, not what survived it.
 *
 * The hard case is a trip with exactly ONE stop. The legacy slots can hold "B
 * without A" — you type the destination first — but a stop list only has
 * order, so `useTrip` remembers which slot a lone stop fills. Every sequence
 * below reaches that state through an ordinary flow.
 */
const A: [number, number] = [-3.7, 40.41];
const B: [number, number] = [-3.68, 40.42];

function renderNav() {
  return renderHook(() =>
    useNavigation({
      mapRef: { current: null },
      dateRef: { current: new Date("2026-08-16T12:00:00Z") },
      setDate: vi.fn(),
    }),
  );
}

describe("derived waypoints: a lone stop keeps its slot", () => {
  it("keeps the destination when it is set before the origin", () => {
    const { result } = renderNav();
    act(() => result.current.handleSetWaypointB(B, "Dest"));
    expect(result.current.waypointB).toEqual(B);
    expect(result.current.waypointBLabel).toBe("Dest");
    expect(result.current.waypointA).toBeNull();
  });

  it("then accepts an origin without displacing that destination", () => {
    const { result } = renderNav();
    act(() => result.current.handleSetWaypointB(B, "Dest"));
    act(() => result.current.handleSetWaypointA(A, "Origin"));
    expect(result.current.waypointA).toEqual(A);
    expect(result.current.waypointB).toEqual(B);
    expect(result.current.additionalWaypoints).toEqual([]);
  });

  it("keeps the destination when the origin is cleared from an A+B trip", () => {
    const { result } = renderNav();
    act(() => result.current.handleSetWaypointA(A, "Origin"));
    act(() => result.current.handleSetWaypointB(B, "Dest"));
    act(() => result.current.handleClearWaypointA());
    expect(result.current.waypointA).toBeNull();
    expect(result.current.waypointB).toEqual(B);
    expect(result.current.waypointBLabel).toBe("Dest");
  });

  it("keeps the origin when the destination is cleared from an A+B trip", () => {
    const { result } = renderNav();
    act(() => result.current.handleSetWaypointA(A, "Origin"));
    act(() => result.current.handleSetWaypointB(B, "Dest"));
    act(() => result.current.handleClearWaypointB());
    expect(result.current.waypointA).toEqual(A);
    expect(result.current.waypointALabel).toBe("Origin");
    expect(result.current.waypointB).toBeNull();
  });

  it("moves a lone origin into the destination slot on swap", () => {
    const { result } = renderNav();
    act(() => result.current.handleSetWaypointA(A, "Origin"));
    act(() => result.current.handleSwapWaypoints());
    expect(result.current.waypointA).toBeNull();
    expect(result.current.waypointB).toEqual(A);
    expect(result.current.waypointBLabel).toBe("Origin");
  });

  it("swaps both endpoints of a full trip", () => {
    const { result } = renderNav();
    act(() => result.current.handleSetWaypointA(A, "Origin"));
    act(() => result.current.handleSetWaypointB(B, "Dest"));
    act(() => result.current.handleSwapWaypoints());
    expect(result.current.waypointA).toEqual(B);
    expect(result.current.waypointALabel).toBe("Dest");
    expect(result.current.waypointB).toEqual(A);
    expect(result.current.waypointBLabel).toBe("Origin");
  });

  it("clearing everything leaves no slot remembered", () => {
    const { result } = renderNav();
    act(() => result.current.handleSetWaypointB(B, "Dest"));
    act(() => result.current.handleClear());
    expect(result.current.waypointA).toBeNull();
    expect(result.current.waypointB).toBeNull();
    // A fresh origin lands in the origin slot, not the remembered one.
    act(() => result.current.handleSetWaypointA(A, "Origin"));
    expect(result.current.waypointA).toEqual(A);
    expect(result.current.waypointB).toBeNull();
  });
});

describe("derived waypoints: via stops", () => {
  it("keeps via stops between the endpoints", () => {
    const { result } = renderNav();
    const via: [number, number] = [-3.69, 40.415];
    act(() => result.current.handleSetWaypointA(A, "Origin"));
    act(() => result.current.handleSetWaypointB(B, "Dest"));
    act(() => result.current.handleAddAdditionalWaypoint(via));
    expect(result.current.waypointA).toEqual(A);
    expect(result.current.waypointB).toEqual(B);
    expect(result.current.additionalWaypoints).toEqual([via]);
  });

  it("removing a via stop leaves the endpoints alone", () => {
    const { result } = renderNav();
    act(() => result.current.handleSetWaypointA(A, "Origin"));
    act(() => result.current.handleSetWaypointB(B, "Dest"));
    act(() => result.current.handleAddAdditionalWaypoint([-3.69, 40.415]));
    act(() => result.current.handleRemoveAdditionalWaypoint(0));
    expect(result.current.additionalWaypoints).toEqual([]);
    expect(result.current.waypointA).toEqual(A);
    expect(result.current.waypointB).toEqual(B);
  });
});

describe("plan revisions and dwell (C5)", () => {
  it("a dwell edit invalidates a job just like a coordinate edit", () => {
    const { result } = renderNav();
    act(() => result.current.handleSetWaypointA(A, "Origin"));
    act(() => result.current.handleSetWaypointB(B, "Dest"));
    const before = result.current.getCurrentPlanRevision();
    // Same coordinates, dwell only — the route-defining edit C5 must see.
    act(() => result.current.handleSetWaypointB(B, "Dest", { dwellMinutes: 45 }));
    expect(result.current.dwellMinutes).toEqual([0, 45]);
    expect(result.current.getCurrentPlanRevision()).toBeGreaterThan(before);
  });

  it("an agent plan advances the revision exactly once, dwell present or not", () => {
    const { result } = renderNav();
    act(() => result.current.handleSetWaypointA(A, "Origin"));
    // Dwell that `replaceStops` will PRESERVE, because the plan reuses B's
    // coordinates. A fingerprint that assumed "a plan means no dwell" would
    // miss its own commit, bump twice, and supersede the job it just made.
    act(() => result.current.handleSetWaypointB(B, "Dest", { dwellMinutes: 45 }));

    const before = result.current.getCurrentPlanRevision();
    let planRevision = -1;
    act(() => {
      planRevision = result.current.createRoutePlanRequest({
        from: A,
        to: B,
        via: [],
        fromLabel: "Origin",
        toLabel: "Dest",
      }).planRevision;
    });

    expect(planRevision).toBe(before + 1);
    // The commit must not advance it again, or the job is already stale.
    expect(result.current.getCurrentPlanRevision()).toBe(planRevision);
    // And the preserved dwell is still there.
    expect(result.current.dwellMinutes).toEqual([0, 45]);
  });
});
