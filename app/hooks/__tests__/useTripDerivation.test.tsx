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

/**
 * The regression that survived the first review round: clearing or retyping an
 * endpoint of a trip that HAS via stops promoted a via into the empty slot and
 * dropped it from the stop list. `WaypointInput` fires `onClear()` on the first
 * keystroke of a retype, so this was reachable by typing, not just by the ✗.
 */
describe("endpoints and via stops do not cannibalise each other", () => {
  const V1: [number, number] = [-3.69, 40.415];
  const V2: [number, number] = [-3.685, 40.417];

  function tripWithVias() {
    const { result } = renderNav();
    act(() => result.current.handleSetWaypointA(A, "Origin"));
    act(() => result.current.handleSetWaypointB(B, "Dest"));
    act(() => result.current.handleAddAdditionalWaypoint(V1));
    act(() => result.current.handleAddAdditionalWaypoint(V2));
    return result;
  }

  it("clearing the origin leaves every via stop and the destination alone", () => {
    const result = tripWithVias();
    act(() => result.current.handleClearWaypointA());
    expect(result.current.waypointA).toBeNull();
    expect(result.current.additionalWaypoints).toEqual([V1, V2]);
    expect(result.current.waypointB).toEqual(B);
  });

  it("clearing the destination leaves every via stop and the origin alone", () => {
    const result = tripWithVias();
    act(() => result.current.handleClearWaypointB());
    expect(result.current.waypointB).toBeNull();
    expect(result.current.additionalWaypoints).toEqual([V1, V2]);
    expect(result.current.waypointA).toEqual(A);
  });

  it("retyping the origin (clear then set) keeps the via stops", () => {
    const result = tripWithVias();
    const retyped: [number, number] = [-3.6, 40.5];
    act(() => result.current.handleClearWaypointA());
    act(() => result.current.handleSetWaypointA(retyped, "New origin"));
    expect(result.current.waypointA).toEqual(retyped);
    expect(result.current.additionalWaypoints).toEqual([V1, V2]);
    expect(result.current.waypointB).toEqual(B);
  });

  it("adding a stop with only a destination set does not steal the destination", () => {
    const { result } = renderNav();
    act(() => result.current.handleSetWaypointB(B, "Dest"));
    act(() => result.current.handleAddAdditionalWaypoint(V1));
    expect(result.current.waypointA).toBeNull();
    expect(result.current.waypointB).toEqual(B);
    expect(result.current.additionalWaypoints).toEqual([V1]);
  });

  it("adding a stop before the destination exists keeps it when one arrives", () => {
    const { result } = renderNav();
    act(() => result.current.handleSetWaypointA(A, "Origin"));
    act(() => result.current.handleAddAdditionalWaypoint(V1));
    act(() => result.current.handleSetWaypointB(B, "Dest"));
    expect(result.current.waypointA).toEqual(A);
    expect(result.current.waypointB).toEqual(B);
    expect(result.current.additionalWaypoints).toEqual([V1]);
  });

  it("removing a via removes that via, not a neighbour", () => {
    const result = tripWithVias();
    act(() => result.current.handleRemoveAdditionalWaypoint(0));
    expect(result.current.additionalWaypoints).toEqual([V2]);
    expect(result.current.waypointA).toEqual(A);
    expect(result.current.waypointB).toEqual(B);
  });

  it("setting the via list replaces only the vias", () => {
    const result = tripWithVias();
    act(() => result.current.handleSetAdditionalWaypoints([V2]));
    expect(result.current.additionalWaypoints).toEqual([V2]);
    expect(result.current.waypointA).toEqual(A);
    expect(result.current.waypointB).toEqual(B);
  });

  it("vias survive a swap of the two endpoints", () => {
    const result = tripWithVias();
    act(() => result.current.handleSwapWaypoints());
    expect(result.current.waypointA).toEqual(B);
    expect(result.current.waypointB).toEqual(A);
    expect(result.current.additionalWaypoints).toEqual([V1, V2]);
  });
});

describe("a slot pointed at a new place starts clean", () => {
  it("does not inherit the previous occupant's dwell", () => {
    const { result } = renderNav();
    act(() => result.current.handleSetWaypointA(A, "Origin"));
    act(() => result.current.handleSetWaypointB(B, "Dest", { dwellMinutes: 45 }));
    expect(result.current.dwellMinutes).toEqual([0, 45]);
    // A different coordinate is a different place; the 45 minutes belonged to
    // the place it replaced, and would otherwise reach the exported file.
    act(() => result.current.handleSetWaypointB([-3.5, 40.6], "Elsewhere"));
    expect(result.current.dwellMinutes).toEqual([0, 0]);
  });
});

/**
 * Partial share links. `page.tsx` treats a link with only `b` and/or `via` as
 * route state and opens directions on it, so these shapes are supported and
 * must land in the slots the link named — not shuffle up into whatever slot
 * happens to be first in the list.
 */
describe("partial share links restore into the slots the link named", () => {
  const V: [number, number] = [-3.69, 40.415];

  it("a destination and stops, with no start", () => {
    const { result } = renderNav();
    act(() => result.current.handleSetWaypointB(B, "Shared destination"));
    act(() => result.current.handleSetAdditionalWaypoints([V]));
    expect(result.current.waypointA).toBeNull();
    expect(result.current.waypointB).toEqual(B);
    expect(result.current.additionalWaypoints).toEqual([V]);
  });

  it("a start and stops, with no destination", () => {
    const { result } = renderNav();
    act(() => result.current.handleSetWaypointA(A, "Shared start"));
    act(() => result.current.handleSetAdditionalWaypoints([V]));
    expect(result.current.waypointA).toEqual(A);
    expect(result.current.waypointB).toBeNull();
    expect(result.current.additionalWaypoints).toEqual([V]);
  });

  it("a full link restores all three in order", () => {
    const { result } = renderNav();
    act(() => result.current.handleSetWaypointA(A, "Shared start"));
    act(() => result.current.handleSetWaypointB(B, "Shared destination"));
    act(() => result.current.handleSetAdditionalWaypoints([V]));
    expect(result.current.waypointA).toEqual(A);
    expect(result.current.waypointB).toEqual(B);
    expect(result.current.additionalWaypoints).toEqual([V]);
  });
});
