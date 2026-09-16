import { describe, expect, it } from "vitest";
import { matchEntranceToTrainStation, type TrainStation } from "../trainGraph";

function station(id: string, name: string, lat: number, lon: number): TrainStation {
  return { id, name, lat, lon, lines: [] };
}

/**
 * Two real traps from the published NYC data, both of which the unbounded
 * substring match fell into: a station whose whole name is a substring of a
 * distant entrance's name, and a station named after a street that runs the
 * length of the island.
 */
function stations(): Map<string, TrainStation> {
  return new Map(
    [
      // Lower Manhattan. "Wall St" is a substring of "…Stonewall Station".
      station("subway:wall", "Wall St", 40.7074, -74.0089),
      // Upper West Side, ~9 km from the 23rd St entrances below.
      station("subway:bway", "Broadway", 40.7906, -73.9744),
      // The station the entrances below actually belong to.
      station("subway:chris", "Christopher St-Sheridan Sq", 40.7332, -74.0031),
      station("subway:23", "23 St", 40.7429, -73.9892),
    ].map((s) => [s.id, s]),
  );
}

describe("matchEntranceToTrainStation", () => {
  it("does not match a station whose name is a substring of a distant entrance", () => {
    // "Wall St" ⊂ "christopher street-stonewall station", but it is 3 km away.
    const match = matchEntranceToTrainStation(
      { lat: 40.7332, lon: -74.0031, name: "Christopher Street-Stonewall Station" },
      stations(),
    );
    expect(match).toBe("subway:chris");
  });

  it("does not match a street-named station kilometres up that street", () => {
    const match = matchEntranceToTrainStation(
      { lat: 40.7429, lon: -73.9892, name: "Broadway & 23rd Street at Northeast Corner" },
      stations(),
    );
    expect(match).toBe("subway:23");
  });

  it("still matches a genuine named entrance", () => {
    const match = matchEntranceToTrainStation(
      { lat: 40.7075, lon: -74.009, name: "Wall St entrance" },
      stations(),
    );
    expect(match).toBe("subway:wall");
  });

  it("picks the nearest station when several share a name", () => {
    const shared = new Map(
      [
        station("subway:rector-1", "Rector St", 40.7075, -74.0134),
        station("subway:rector-r", "Rector St", 40.7079, -74.0131),
      ].map((s) => [s.id, s]),
    );
    // Both names match; only one owns this door.
    expect(
      matchEntranceToTrainStation({ lat: 40.7079, lon: -74.0131, name: "Rector St" }, shared),
    ).toBe("subway:rector-r");
  });

  it("falls back to the nearest centroid, and gives up beyond its radius", () => {
    expect(
      matchEntranceToTrainStation({ lat: 40.7076, lon: -74.0088 }, stations()),
    ).toBe("subway:wall");
    // Middle of the Hudson: nothing within the fallback radius.
    expect(matchEntranceToTrainStation({ lat: 40.75, lon: -74.05 }, stations())).toBeNull();
  });
});
