/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SavedRoutesSection from "../SavedRoutesSection";
import type { ResolvedExposureContext } from "../../lib/exposure";
import type { RouteOption } from "../../lib/routing";
import type { SavedFolder, SavedRoute } from "../../lib/savedRoutes";
import type { Trip } from "../../lib/trip/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LINE: GeoJSON.Feature<GeoJSON.LineString> = {
  type: "Feature",
  properties: {},
  geometry: { type: "LineString", coordinates: [] },
};

function saved(id: string, name: string, option: Partial<RouteOption>, extra: Partial<SavedRoute> = {}): SavedRoute {
  return {
    id,
    name,
    folderId: null,
    routeOption: {
      label: "Shortest",
      geojson: LINE,
      distanceM: 840,
      shadowCoverage: 0.62,
      longestContinuousShadowM: 0,
      longestContinuousSunM: 0,
      shadowTransitions: 0,
      detourRatio: 1,
      turnCount: 0,
      ...option,
    },
    waypointA: [-73.98, 40.75],
    waypointB: [-73.97, 40.76],
    waypointALabel: null,
    waypointBLabel: null,
    additionalWaypoints: [],
    timeOfDayMinutes: 9 * 60,
    dateIso: "2026-06-21",
    createdAt: 1,
    // 13:00Z is 9:00 AM in New York, the departure stop's zone.
    trip: { departAt: { instant: "2026-06-21T13:00:00Z", zone: "America/New_York" } } as unknown as Trip,
    ...extra,
  };
}

function show(routes: SavedRoute[], folders: SavedFolder[] = []) {
  const props = { routes, folders, onLoad: vi.fn(), onDelete: vi.fn(), onRename: vi.fn() };
  render(<SavedRoutesSection {...props} />);
  const toggle = screen.getByRole("button", { name: /Saved routes/ });
  fireEvent.click(toggle);
  return { ...props, toggle };
}

describe("SavedRoutesSection as ticket stubs (R8b)", () => {
  it("states whether it is open", () => {
    const { toggle } = show([saved("a", "Library walk", {})]);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Library walk")).toBeNull();
  });

  it("prints the date and time the saved figure was computed for on the stub", () => {
    show([saved("a", "Library walk", {})]);

    const ticket = screen.getByRole("button", { name: /^Library walk/ });
    expect(within(ticket).getByText("840 m · 62% shadow")).toBeTruthy();
    expect(within(ticket).getByText("Jun 21")).toBeTruthy();
    expect(within(ticket).getByText("9:00 AM")).toBeTruthy();
  });

  it("prints the stub in the departure stop's zone, not the browser's", () => {
    // 01:00Z on Jun 22 is 9 PM on Jun 21 in New York, whatever zone the test runs in.
    const trip = { departAt: { instant: "2026-06-22T01:00:00Z", zone: "America/New_York" } } as unknown as Trip;
    show([saved("a", "Evening walk", {}, { trip, dateIso: "2026-06-21", timeOfDayMinutes: 18 * 60 })]);

    expect(screen.getByText("Jun 21")).toBeTruthy();
    expect(screen.getByText("9:00 PM")).toBeTruthy();
  });

  it("prints no stub when the record holds no departure", () => {
    show([saved("a", "Library walk", {}, { trip: undefined })]);

    expect(screen.getByText("840 m · 62% shadow")).toBeTruthy();
    expect(screen.queryByText(/AM|PM/)).toBeNull();
  });

  it("says after sunset for a night walk, as its route card did", () => {
    const evaluatedContext = {
      objective: "sun",
      time: new Date("2026-06-21T03:00:00Z"),
      referenceLocation: { lat: 40.754, lng: -73.984 },
    } as ResolvedExposureContext;
    const trip = { departAt: { instant: "2026-06-21T03:00:00Z", zone: "America/New_York" } } as unknown as Trip;
    show([saved("a", "Late walk", { shadowCoverage: 1, objective: "sun", evaluatedContext }, { trip })]);

    expect(screen.getByText("840 m · after sunset")).toBeTruthy();
    expect(screen.getByText("Jun 20")).toBeTruthy();
    expect(screen.getByText("11:00 PM")).toBeTruthy();
    expect(screen.queryByText(/100% shadow/)).toBeNull();
  });

  it("keeps the rain figure and its unknown", () => {
    show([
      saved("a", "Errand", { distanceM: 1260, dryCoverage: 0.48 }),
      saved("b", "Errand two", { objective: "rain", exposure: { unknownDistanceM: 40 } as RouteOption["exposure"] }),
    ]);

    expect(screen.getByText("1.3 km · 48% sheltered")).toBeTruthy();
    expect(screen.getByText("840 m · shelter unknown")).toBeTruthy();
  });

  it("shows rename and delete as named controls without hover, and loads on the ticket", () => {
    vi.stubGlobal("confirm", () => true);
    const route = saved("a", "Library walk", {});
    const props = show([route]);

    fireEvent.click(screen.getByRole("button", { name: /Library walk.*Jun 21/ }));
    expect(props.onLoad).toHaveBeenCalledWith(route);
    fireEvent.click(screen.getByRole("button", { name: "Delete Library walk" }));
    expect(props.onDelete).toHaveBeenCalledWith("a");

    fireEvent.click(screen.getByRole("button", { name: "Rename Library walk" }));
    const input = screen.getByRole("textbox", { name: "Rename Library walk" });
    fireEvent.change(input, { target: { value: "Shady library walk" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRename).toHaveBeenCalledWith("a", "Shady library walk");
  });

  it("groups foldered routes under the folder's kicker", () => {
    show(
      [saved("a", "Library walk", {}), saved("b", "Coffee", {}, { folderId: "f1" })],
      [{ id: "f1", name: "Weekdays", createdAt: 1 }],
    );

    const folder = screen.getByRole("region", { name: "Weekdays" });
    expect(within(folder).getByText("Weekdays").className).toContain("umbra-kicker");
    expect(within(folder).getByRole("button", { name: /^Coffee/ })).toBeTruthy();
    expect(within(folder).queryByText("Library walk")).toBeNull();
  });
});
