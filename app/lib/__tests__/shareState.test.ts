import { describe, expect, it } from "vitest";
import { parseShareState, serializeShareState } from "../shareState";
import { fromMapLocal } from "../timezone";

describe("shareState", () => {
  it("serializes map position, local date/time, and waypoints", () => {
    const search = serializeShareState({
      mapCenter: [40.71278, -74.00597],
      mapZoom: 15.437,
      utcOffsetMin: -300,
      date: fromMapLocal(new Date("2026-07-05T12:00:00.000Z"), -300, 17, 45),
      waypointA: [-74.01, 40.71],
      waypointB: [-73.99, 40.72],
      additionalWaypoints: [[-74.0, 40.715]],
      travelMode: "walk",
    });

    expect(search).toBe(
      "?lat=40.71278&lng=-74.00597&z=15.44&date=2026-07-05&time=17%3A45&a=-74.01000%2C40.71000&b=-73.99000%2C40.72000&via=-74.00000%2C40.71500"
    );
  });

  it("round-trips bike mode through the share URL", () => {
    const search = serializeShareState({
      mapCenter: [40.71278, -74.00597],
      mapZoom: 15.437,
      utcOffsetMin: -300,
      date: fromMapLocal(new Date("2026-07-05T12:00:00.000Z"), -300, 17, 45),
      waypointA: [-74.01, 40.71],
      waypointB: [-73.99, 40.72],
      additionalWaypoints: [],
      travelMode: "bike",
    });

    expect(search).toContain("mode=bike");
    expect(parseShareState(search, -300).travelMode).toBe("bike");
  });

  it("round-trips scoot mode through the share URL", () => {
    const search = serializeShareState({
      mapCenter: [40.71278, -74.00597],
      mapZoom: 15.437,
      utcOffsetMin: -300,
      date: fromMapLocal(new Date("2026-07-05T12:00:00.000Z"), -300, 17, 45),
      waypointA: [-74.01, 40.71],
      waypointB: [-73.99, 40.72],
      additionalWaypoints: [],
      travelMode: "scoot",
    });

    expect(search).toContain("mode=scoot");
    expect(parseShareState(search, -300).travelMode).toBe("scoot");
  });

  it("defaults a missing or invalid mode to walk", () => {
    expect(parseShareState("?a=-74.01%2C40.71", 0).travelMode).toBe("walk");
    expect(parseShareState("?a=-74.01%2C40.71&mode=car", 0).travelMode).toBe("walk");
  });

  it("parses a valid shared route state", () => {
    const parsed = parseShareState(
      "?lat=40.71278&lng=-74.00597&z=15.44&date=2026-07-05&time=17%3A45&a=-74.01%2C40.71&b=-73.99%2C40.72&via=-74%2C40.715;-73.995%2C40.718",
      -300
    );

    expect(parsed.center).toEqual([-74.00597, 40.71278]);
    expect(parsed.zoom).toBe(15.44);
    expect(parsed.date?.toISOString()).toBe("2026-07-05T22:45:00.000Z");
    expect(parsed.waypointA).toEqual([-74.01, 40.71]);
    expect(parsed.waypointB).toEqual([-73.99, 40.72]);
    expect(parsed.additionalWaypoints).toEqual([[-74, 40.715], [-73.995, 40.718]]);
    expect(parsed.travelMode).toBe("walk");
  });

  it("drops invalid coordinates and zoom values", () => {
    const parsed = parseShareState(
      "?lat=140&lng=-181&z=99&a=nope&b=-73.99%2C92&via=-74%2C40.7;200%2C40",
      0
    );

    expect(parsed.center).toBeNull();
    expect(parsed.zoom).toBeNull();
    expect(parsed.waypointA).toBeNull();
    expect(parsed.waypointB).toBeNull();
    expect(parsed.additionalWaypoints).toEqual([[-74, 40.7]]);
  });
});
