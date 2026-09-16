import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchTrainGraph,
  matchEntranceToTrainStation,
  TRAIN_SPEED_MPS,
  TRANSFER_PENALTY_SEC,
  type TrainStation,
} from "../trainGraph";
import { haversineMeters } from "../routing";

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

// ─── The Overpass producer ──────────────────────────────────────────────────

/**
 * Until `VITE_TRANSIT_BASE` is set this is the only producer that runs, and it
 * is the only one that runs anywhere but New York. Its seconds are derived from
 * geometry rather than measured, so they need pinning.
 */
describe("fetchTrainGraph (Overpass producer)", () => {
  const A = { id: 1, lat: 40.7, lon: -74.0 };
  const B = { id: 2, lat: 40.709, lon: -74.0 }; // ~1 km north of A
  // Same name as A, 22 m away: an interchange by the producer's own heuristic.
  const C = { id: 3, lat: 40.7002, lon: -74.0 };
  const D = { id: 4, lat: 40.69, lon: -74.0 };

  function node(n: { id: number; lat: number; lon: number }, name: string) {
    return { type: "node", id: n.id, lat: n.lat, lon: n.lon, tags: { name, railway: "station" } };
  }
  function relation(id: number, ref: string, members: number[]) {
    return {
      type: "relation",
      id,
      tags: { type: "route", route: "subway", ref, name: `Line ${ref}`, colour: "#123456" },
      members: members.map((r) => ({ type: "node", ref: r, role: "stop" })),
    };
  }

  function stubOverpass(elements: unknown[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ elements }) })),
    );
  }

  afterEach(() => vi.unstubAllGlobals());

  it("prices a rail hop as the time to ride it, not its length", async () => {
    stubOverpass([node(A, "Alpha"), node(B, "Bravo"), relation(10, "X", [A.id, B.id])]);
    // A bbox no other test in this file uses — the producer caches by bbox.
    const graph = (await fetchTrainGraph(40.60, -74.10, 40.80, -73.90))!;
    const edge = graph.adj.get("osm:1")!.find((e) => e.to === "osm:2")!;

    const metres = haversineMeters([A.lon, A.lat], [B.lon, B.lat]);
    expect(edge.type).toBe("rail");
    expect(edge.weightSec).toBeCloseTo(metres / TRAIN_SPEED_MPS, 6);
    // ~1 km at 30 km/h is about two minutes — not ~1000 of anything.
    expect(edge.weightSec).toBeGreaterThan(100);
    expect(edge.weightSec).toBeLessThan(140);
  });

  it("charges a measured interchange for a transfer, not a distance", async () => {
    stubOverpass([
      node(A, "Alpha"),
      node(B, "Bravo"),
      node(C, "Alpha"),
      node(D, "Delta"),
      relation(10, "X", [A.id, B.id]),
      relation(11, "Y", [C.id, D.id]),
    ]);
    const graph = (await fetchTrainGraph(40.61, -74.11, 40.81, -73.91))!;
    const transfer = graph.adj.get("osm:1")!.find((e) => e.type === "transfer")!;
    expect(transfer.to).toBe("osm:3");
    expect(transfer.weightSec).toBe(TRANSFER_PENALTY_SEC);
    // The 22 m between the two platforms is not what a change of line costs.
    expect(transfer.weightSec).toBeGreaterThan(
      haversineMeters([A.lon, A.lat], [C.lon, C.lat]) / TRAIN_SPEED_MPS,
    );
  });

  it("namespaces OSM node ids so they cannot collide with a shard's", async () => {
    stubOverpass([node(A, "Alpha"), node(B, "Bravo"), relation(10, "X", [A.id, B.id])]);
    const graph = (await fetchTrainGraph(40.62, -74.12, 40.82, -73.92))!;
    expect([...graph.stations.keys()].sort()).toEqual(["osm:1", "osm:2"]);
  });
});
