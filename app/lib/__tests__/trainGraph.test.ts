import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTrainDrawData,
  fetchTrainGraph,
  stationConnectors,
  type TrainDrawData,
  findBestTrainRoute,
  headwayKey,
  matchEntranceToTrainStation,
  serviceDayHour,
  TRAIN_SPEED_MPS,
  TRANSFER_PENALTY_SEC,
  trainDijkstra,
  findBestTransitRoute,
  MAX_TRANSIT_BOARDINGS,
  coveredHourKey,
  railExposure,
  RAIL_VEHICLE_EXPOSURE,
  type TrainDayType,
  type TrainEdgeStructure,
  type TrainGraph,
  type TrainGraphEdge,
  type TrainHeadways,
  type TrainMode,
  type TrainRouteSegment,
  type TrainSegment,
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

// ─── Pricing the change and the wait ────────────────────────────────────────

/**
 * Both terms depend on **which route you board**, so both are invisible to a
 * search keyed on the station alone. These build the smallest graph in which
 * that distinction changes the answer: two ways from the same platform to the
 * same destination, differing only in what boarding them costs.
 */
function toyStation(
  id: string,
  lat: number,
  changeSec?: number,
): TrainStation {
  const station: TrainStation = { id, name: id, lat, lon: -74.0, lines: [] };
  if (changeSec !== undefined) station.changeSec = changeSec;
  return station;
}

function toyGraph(
  stations: TrainStation[],
  edges: Array<{
    from: string;
    to: string;
    line?: string;
    sec: number;
    direction?: number;
    structure?: Partial<Record<string, number>>;
    geom?: string;
  }>,
  headways?: TrainHeadways,
  modes?: Record<string, TrainMode>,
): TrainGraph {
  const stationMap = new Map(stations.map((s) => [s.id, s]));
  const adj = new Map<string, TrainGraphEdge[]>(stations.map((s) => [s.id, []]));
  const lineModes = new Map<string, TrainMode>();
  for (const e of edges) {
    // No `line` is a transfer edge, exactly as both producers emit one.
    if (e.line === undefined) {
      adj.get(e.from)!.push({ to: e.to, weightSec: e.sec, type: "transfer" });
      continue;
    }
    adj.get(e.from)!.push({
      to: e.to,
      weightSec: e.sec,
      type: "rail",
      line: e.line,
      direction: e.direction ?? 0,
      ...(e.structure ? { structure: e.structure as TrainEdgeStructure } : {}),
      ...(e.geom ? { geom: e.geom } : {}),
    });
    const from = stationMap.get(e.from)!;
    if (!from.lines.includes(e.line)) from.lines.push(e.line);
    lineModes.set(e.line, modes?.[e.line] ?? "subway");
  }
  return {
    stations: stationMap,
    adj,
    lineColors: new Map(),
    lineNames: new Map(),
    lineModes,
    headways,
  };
}

/**
 * One slow line all the way, against two fast lines meeting at `M`. Riding is
 * 120 s the fast way and 180 s the slow way, so the change wins on ride time
 * alone — which is exactly what it used to do for free.
 */
function changeGraph(changeSecAtM?: number): TrainGraph {
  return toyGraph(
    [
      toyStation("X", 40.7),
      toyStation("M", 40.706, changeSecAtM),
      toyStation("Z", 40.712),
    ],
    [
      { from: "X", to: "M", line: "L", sec: 90 },
      { from: "M", to: "Z", line: "L", sec: 90 },
      { from: "X", to: "M", line: "F1", sec: 60 },
      { from: "M", to: "Z", line: "F2", sec: 60 },
    ],
  );
}

describe("trainDijkstra: changing lines inside one station", () => {
  it("charged nothing for a change, so the fast interchange always won", () => {
    // No changeSec anywhere: the two-line route is 60 s quicker and takes it.
    const path = trainDijkstra(changeGraph(), "X", "Z")!;
    expect(path.lines).toEqual(["F1", "F2"]);
    expect(path.totalSec).toBe(120);
  });

  it("makes a single-line ride beat an interchange the feed prices dearly", () => {
    // 200 s to cross between platforms is more than the 60 s the change saves.
    const path = trainDijkstra(changeGraph(200), "X", "Z")!;
    expect(path.lines).toEqual(["L"]);
    expect(path.totalSec).toBe(180);
  });

  it("leaves a change the agency priced no cost for unpriced, not defaulted", () => {
    // `changeSec` absent is not a number to make up (#384). It charges nothing,
    // which is what an unpriced change costs — and the fast route still wins.
    const withoutField = trainDijkstra(changeGraph(), "X", "Z")!;
    const crossPlatform = trainDijkstra(changeGraph(0), "X", "Z")!;
    expect(withoutField.totalSec).toBe(crossPlatform.totalSec);
    expect(crossPlatform.lines).toEqual(["F1", "F2"]);
  });

  it("does not charge a change for walking in off the street", () => {
    // Boarding at the origin is not an interchange, however dear `changeSec` is.
    const path = trainDijkstra(
      toyGraph(
        [toyStation("X", 40.7, 600), toyStation("M", 40.706), toyStation("Z", 40.712)],
        [
          { from: "X", to: "M", line: "L", sec: 90 },
          { from: "M", to: "Z", line: "L", sec: 90 },
        ],
      ),
      "X",
      "Z",
    )!;
    expect(path.totalSec).toBe(180);
  });
});

describe("trainDijkstra: a change made over a transfer edge", () => {
  it("pays the agency's transfer time and not the change cost on top", () => {
    // `minSec` on the edge *is* what crossing between these two nodes costs.
    // Adding `changeSec` as well would charge the same walk twice.
    const graph = toyGraph(
      [
        toyStation("X", 40.7),
        toyStation("C", 40.706),
        // The change is charged where the rider boards, so this is the one
        // that would be charged twice.
        toyStation("D", 40.7061, 600),
        toyStation("Z", 40.712),
      ],
      [
        { from: "X", to: "C", line: "L", sec: 90 },
        { from: "C", to: "D", sec: 180 },
        { from: "D", to: "Z", line: "M", sec: 90 },
      ],
    );
    const path = trainDijkstra(graph, "X", "Z")!;
    expect(path.stationIds).toEqual(["X", "C", "D", "Z"]);
    expect(path.totalSec).toBe(360);
  });
});

describe("trainDijkstra: the searched mode and the boarding cap", () => {
  it("refuses a rail edge of another mode when a mode is searched", () => {
    // BUS reaches the change, SUB leaves it: a bus-only search cannot ride SUB.
    const graph = toyGraph(
      [toyStation("A", 40.7), toyStation("M", 40.702), toyStation("B", 40.704)],
      [
        { from: "A", to: "M", line: "BUS", sec: 60 },
        { from: "M", to: "B", line: "SUB", sec: 60 },
      ],
      undefined,
      { BUS: "bus", SUB: "subway" },
    );
    expect(trainDijkstra(graph, "A", "B", {}, "bus")).toBeNull();
    const mixed = trainDijkstra(graph, "A", "B")!;
    expect(mixed.lines).toEqual(["BUS", "SUB"]);
  });

  it("still crosses a transfer edge within the searched mode", () => {
    // The transfer carries no line, so filtering ride edges must not remove it.
    const graph = toyGraph(
      [toyStation("A", 40.7), toyStation("C", 40.702), toyStation("D", 40.7021), toyStation("B", 40.704)],
      [
        { from: "A", to: "C", line: "BUS", sec: 60 },
        { from: "C", to: "D", sec: 180 },
        { from: "D", to: "B", line: "BUS", sec: 60 },
      ],
      undefined,
      { BUS: "bus" },
    );
    const path = trainDijkstra(graph, "A", "B", {}, "bus")!;
    expect(path.stationIds).toEqual(["A", "C", "D", "B"]);
    expect(path.totalSec).toBe(300);
  });

  it("prunes a path that needs one more ride than the cap allows", () => {
    // Riding each line once is one boarding, so `lines` lines need that many.
    const chain = (lines: number): TrainGraph => {
      const stations = Array.from({ length: lines + 1 }, (_, i) =>
        toyStation(`S${i}`, 40.7 + i * 0.001),
      );
      const edges = Array.from({ length: lines }, (_, i) => ({
        from: `S${i}`,
        to: `S${i + 1}`,
        line: `L${i}`,
        sec: 60,
      }));
      return toyGraph(stations, edges, undefined, Object.fromEntries(
        Array.from({ length: lines }, (_, i) => [`L${i}`, "subway" as TrainMode]),
      ));
    };
    const within = trainDijkstra(chain(MAX_TRANSIT_BOARDINGS), "S0", `S${MAX_TRANSIT_BOARDINGS}`);
    expect(within).not.toBeNull();
    expect(within!.lines).toHaveLength(MAX_TRANSIT_BOARDINGS);
    expect(trainDijkstra(chain(MAX_TRANSIT_BOARDINGS + 1), "S0", `S${MAX_TRANSIT_BOARDINGS + 1}`)).toBeNull();
  });
});


// ─── The wait to board ──────────────────────────────────────────────────────

const NYC_UTC_OFFSET_MIN = -240; // EDT, which is what New York is in September

function headways(
  rows: Array<{ route: string; direction?: number; dayType: TrainDayType; hour: number; sec: number }>,
  nextDayType: Array<[TrainDayType, TrainDayType]> = [
    ["weekday", "weekday"],
    ["saturday", "sunday"],
    ["sunday", "weekday"],
  ],
): TrainHeadways {
  return {
    medianSec: new Map(
      rows.map((r) => [headwayKey(r.route, r.direction ?? 0, r.dayType, r.hour), r.sec]),
    ),
    coveredHours: new Set(rows.map((r) => coveredHourKey("", r.dayType, r.hour))),
    nextDayType: new Map(nextDayType),
  };
}

/**
 * Two ways from X to Z. `FAST` rides 480 s and `SLOW` 600 s, so before the wait
 * was priced `FAST` won every time — including when it runs every half hour and
 * the slower line runs every four minutes.
 */
function frequencyGraph(table?: TrainHeadways): TrainGraph {
  return toyGraph(
    [
      toyStation("X", 40.7),
      toyStation("S1", 40.706),
      toyStation("F1", 40.7061),
      toyStation("Z", 40.712),
    ],
    [
      { from: "X", to: "S1", line: "SLOW", sec: 300 },
      { from: "S1", to: "Z", line: "SLOW", sec: 300 },
      { from: "X", to: "F1", line: "FAST", sec: 240 },
      { from: "F1", to: "Z", line: "FAST", sec: 240 },
    ],
    table,
  );
}

// Wednesday 16 September 2026, 10:00 in New York.
const WEEKDAY_MORNING = new Date("2026-09-16T14:00:00Z");

describe("trainDijkstra: waiting to board", () => {
  const table = headways([
    { route: "SLOW", dayType: "weekday", hour: 10, sec: 240 },
    { route: "FAST", dayType: "weekday", hour: 10, sec: 1800 },
  ]);

  it("rode the quicker line even when it runs every half hour", () => {
    const path = trainDijkstra(frequencyGraph(table), "X", "Z")!;
    expect(path.lines).toEqual(["FAST"]);
    expect(path.waitSec).toBe(0);
  });

  it("sends the rider to the frequent line once the wait is priced", () => {
    const path = trainDijkstra(frequencyGraph(table), "X", "Z", {
      at: WEEKDAY_MORNING,
      utcOffsetMin: NYC_UTC_OFFSET_MIN,
    })!;
    // 600 s riding plus half of a four-minute headway beats 480 plus half of
    // a thirty-minute one.
    expect(path.lines).toEqual(["SLOW"]);
    expect(path.waitSec).toBe(120);
    expect(path.totalSec).toBe(720);
  });

  it("charges the wait once per boarding, not once per stop", () => {
    const path = trainDijkstra(
      toyGraph(
        [toyStation("X", 40.7), toyStation("M", 40.706), toyStation("Z", 40.712)],
        [
          { from: "X", to: "M", line: "SLOW", sec: 300 },
          { from: "M", to: "Z", line: "SLOW", sec: 300 },
        ],
        table,
      ),
      "X",
      "Z",
      { at: WEEKDAY_MORNING, utcOffsetMin: NYC_UTC_OFFSET_MIN },
    )!;
    expect(path.waitSec).toBe(120);
  });

  it("leaves the wait unpriced where the feed publishes no headway", () => {
    // Nothing published for this hour: the ride is charged, the wait is not —
    // rather than a frequency being invented for it.
    const path = trainDijkstra(frequencyGraph(table), "X", "Z", {
      at: new Date("2026-09-16T07:00:00Z"), // 03:00 in New York
      utcOffsetMin: NYC_UTC_OFFSET_MIN,
    })!;
    expect(path.waitSec).toBe(0);
    expect(path.lines).toEqual(["FAST"]);
  });

  it("reads the hour where the rider boards, not the hour on their own clock", () => {
    // One instant, two travellers: the New Yorker and someone planning from
    // Berlin. The timetable is the same timetable, so the answer must be too.
    const table2 = headways([
      { route: "SLOW", dayType: "weekday", hour: 10, sec: 240 },
      { route: "FAST", dayType: "weekday", hour: 10, sec: 1800 },
      // 16:00 in New York is when the fast line is the frequent one.
      { route: "SLOW", dayType: "weekday", hour: 16, sec: 1800 },
      { route: "FAST", dayType: "weekday", hour: 16, sec: 240 },
    ]);
    const opts = { at: WEEKDAY_MORNING, utcOffsetMin: NYC_UTC_OFFSET_MIN };
    const berlin = { at: WEEKDAY_MORNING, utcOffsetMin: 120 };

    expect(trainDijkstra(frequencyGraph(table2), "X", "Z", opts)!.lines).toEqual(["SLOW"]);
    // Reading Berlin's 16:00 off a New York timetable picks the wrong line.
    expect(trainDijkstra(frequencyGraph(table2), "X", "Z", berlin)!.lines).toEqual(["FAST"]);
  });
});

describe("serviceDayHour: hours 24-27 are not hours 0-3", () => {
  // The 7's real published numbers: 1200 s at hour 1, 570 s at hour 24.
  const table = headways([
    { route: "SLOW", dayType: "weekday", hour: 1, sec: 1200 },
    { route: "SLOW", dayType: "weekday", hour: 24, sec: 570 },
    { route: "SLOW", dayType: "saturday", hour: 0, sec: 900 },
  ]);
  const oneLine = () =>
    toyGraph(
      [toyStation("X", 40.7), toyStation("M", 40.706), toyStation("Z", 40.712)],
      [
        { from: "X", to: "M", line: "SLOW", sec: 300 },
        { from: "M", to: "Z", line: "SLOW", sec: 300 },
      ],
      table,
    );

  it("reads the previous service day's late night, not the table's own small hours", () => {
    // 00:30 on Thursday is Wednesday's service day, hour 24.
    const path = trainDijkstra(oneLine(), "X", "Z", {
      at: new Date("2026-09-17T04:30:00Z"),
      utcOffsetMin: NYC_UTC_OFFSET_MIN,
    })!;
    expect(path.waitSec).toBe(285);
  });

  it("refuses a table whose hour 24 falls on a different morning than this one", () => {
    // Saturday 00:30 is Friday's late night, and the weekday table's hour 24 is
    // a Thursday morning — so it cannot describe this one, and nothing here is
    // charged rather than the wrong night's frequency.
    const path = trainDijkstra(oneLine(), "X", "Z", {
      at: new Date("2026-09-19T04:30:00Z"),
      utcOffsetMin: NYC_UTC_OFFSET_MIN,
    })!;
    expect(path.waitSec).toBe(0);
  });

  it("resolves the daytime hour straight off the boarding clock", () => {
    expect(
      serviceDayHour(WEEKDAY_MORNING, NYC_UTC_OFFSET_MIN, new Map([["weekday", "weekday"]])),
    ).toEqual({ dayType: "weekday", hour: 10 });
    // Saturday 13:00.
    expect(
      serviceDayHour(
        new Date("2026-09-19T17:00:00Z"),
        NYC_UTC_OFFSET_MIN,
        new Map([["weekday", "weekday"]]),
      ),
    ).toEqual({ dayType: "saturday", hour: 13 });
  });
});

describe("findBestTrainRoute with a departure time", () => {
  const table = headways([
    { route: "SLOW", dayType: "weekday", hour: 10, sec: 240 },
    { route: "FAST", dayType: "weekday", hour: 10, sec: 1800 },
  ]);
  const a: [number, number] = [-74.0, 40.6995];
  const b: [number, number] = [-74.0, 40.7125];

  it("picks the line the rider actually gets on soonest", () => {
    const withoutTime = findBestTrainRoute(a, b, frequencyGraph(table))!;
    expect(withoutTime.path.lines).toEqual(["FAST"]);

    const withTime = findBestTrainRoute(a, b, frequencyGraph(table), 1500, 5, {
      at: WEEKDAY_MORNING,
      utcOffsetMin: NYC_UTC_OFFSET_MIN,
    })!;
    expect(withTime.path.lines).toEqual(["SLOW"]);
    // Door to door, the wait is part of what the rider is quoted.
    expect(withTime.path.waitSec).toBe(120);
    expect(withTime.totalCostSec).toBeGreaterThan(withoutTime.totalCostSec);
  });
});

describe("trainDijkstra: a train that is not running", () => {
  // The peak-only case, which is what the real feed is full of: the `7X`
  // publishes nothing at 10 a.m. and the `Z` runs two hours a day.
  const table = headways([
    { route: "SLOW", dayType: "weekday", hour: 10, sec: 1800 },
    // FAST has no row at hour 10, and hour 10 is an hour the table describes.
  ]);

  it("does not board a line the schedule lists no trips for", () => {
    const path = trainDijkstra(frequencyGraph(table), "X", "Z", {
      at: WEEKDAY_MORNING,
      utcOffsetMin: NYC_UTC_OFFSET_MIN,
    })!;
    // Riding SLOW costs 600 s plus a fifteen-minute wait. It still wins,
    // because the alternative is a train that is not coming.
    expect(path.lines).toEqual(["SLOW"]);
    expect(path.totalSec).toBe(1500);
  });

  it("still boards it in an hour the published table never reaches", () => {
    // 2 a.m. maps to hour 26, which nothing in the feed describes. Silence
    // there is ignorance, not a timetable — so nothing is refused and nothing
    // is priced, exactly as before any of this.
    const path = trainDijkstra(frequencyGraph(table), "X", "Z", {
      at: new Date("2026-09-16T06:00:00Z"),
      utcOffsetMin: NYC_UTC_OFFSET_MIN,
    })!;
    expect(path.lines).toEqual(["FAST"]);
    expect(path.waitSec).toBe(0);
  });
});

describe("trainDijkstra: the overnight tail prices but does not refuse", () => {
  // SLOW publishes an hour-24 headway; FAST publishes nothing overnight. The
  // real tables look exactly like this — nine route-directions at hour 24 and
  // nothing at 25-27, on a system that runs all night.
  const table = headways([
    { route: "SLOW", dayType: "weekday", hour: 10, sec: 240 },
    { route: "FAST", dayType: "weekday", hour: 10, sec: 1800 },
    { route: "SLOW", dayType: "weekday", hour: 24, sec: 1200 },
  ]);
  // 00:30 on Thursday, which is Wednesday's service day at hour 24.
  const afterMidnight = { at: new Date("2026-09-17T04:30:00Z"), utcOffsetMin: NYC_UTC_OFFSET_MIN };

  it("still boards the line the small hours say nothing about", () => {
    const path = trainDijkstra(frequencyGraph(table), "X", "Z", afterMidnight)!;
    // SLOW is priced at half of twenty minutes, which is more than FAST's ride
    // even unpriced — and FAST is not refused merely for going unmentioned.
    expect(path.lines).toEqual(["FAST"]);
    expect(path.waitSec).toBe(0);
  });

  it("charges the hour-24 headway it does publish", () => {
    const oneLine = toyGraph(
      [toyStation("X", 40.7), toyStation("M", 40.706), toyStation("Z", 40.712)],
      [
        { from: "X", to: "M", line: "SLOW", sec: 300 },
        { from: "M", to: "Z", line: "SLOW", sec: 300 },
      ],
      table,
    );
    expect(trainDijkstra(oneLine, "X", "Z", afterMidnight)!.waitSec).toBe(600);
  });
});

// ─── Per-segment sun exposure (#393) ────────────────────────────────────────

describe("railExposure", () => {
  const a = station("A", "Alpha", 40.75, -73.99);
  const b = station("B", "Beta", 40.76, -73.98);
  const c = station("C", "Gamma", 40.77, -73.97);

  it("reports no sun for a ride that is wholly in tunnel", () => {
    const graph = toyGraph([a, b], [{ from: "A", to: "B", line: "G", sec: 120, structure: { underground: 1 } }]);
    expect(railExposure(graph, ["A", "B"], ["G"])).toEqual({
      aboveGroundShare: 0,
      sunExposure: 0,
      coverage: 1,
    });
  });

  it("does not treat a seat on a viaduct as standing in full sun", () => {
    // The track is entirely open to the sky, and the rider is still behind
    // glass, under a roof and moving. Reporting 1.0 would say an elevated ride
    // is exactly as exposed as walking, which is what the per-mode constant
    // (light_rail: 0.25, "windowed surface vehicle") always denied.
    const graph = toyGraph([a, b], [{ from: "A", to: "B", line: "J", sec: 120, structure: { elevated: 1 } }]);
    expect(railExposure(graph, ["A", "B"], ["J"])).toEqual({
      aboveGroundShare: 1,
      sunExposure: RAIL_VEHICLE_EXPOSURE,
      coverage: 1,
    });
  });

  it("counts an open cut and an embankment as open to the sky", () => {
    // No invented constant: a cut is open above, and the shade its walls cast
    // is no more modelled than the buildings beside an elevated line.
    const graph = toyGraph(
      [a, b],
      [{ from: "A", to: "B", line: "Q", sec: 100, structure: { open_cut: 0.5, embankment: 0.5 } }],
    );
    expect(railExposure(graph, ["A", "B"], ["Q"])?.aboveGroundShare).toBe(1);
  });

  it("weights by time, so a slow elevated crawl outweighs a fast tunnel run", () => {
    const graph = toyGraph(
      [a, b, c],
      [
        { from: "A", to: "B", line: "7", sec: 60, structure: { underground: 1 } },
        { from: "B", to: "C", line: "7", sec: 180, structure: { elevated: 1 } },
      ],
    );
    const result = railExposure(graph, ["A", "B", "C"], ["7", "7"]);
    // 180 of 240 seconds above ground, not 1 of 2 hops.
    expect(result?.aboveGroundShare).toBeCloseTo(0.75, 5);
    expect(result?.sunExposure).toBeCloseTo(0.75 * RAIL_VEHICLE_EXPOSURE, 5);
    expect(result?.coverage).toBe(1);
  });

  it("measures exposure over the determined part and reports the coverage", () => {
    const graph = toyGraph(
      [a, b, c],
      [
        { from: "A", to: "B", line: "A", sec: 100, structure: { underground: 1 } },
        // Nothing known about this hop at all.
        { from: "B", to: "C", line: "A", sec: 100 },
      ],
    );
    const result = railExposure(graph, ["A", "B", "C"], ["A", "A"]);
    // The unknown half must not be counted as shaded, which is the #393 bug,
    // nor silently as sun. It is excluded and declared.
    expect(result).toEqual({ aboveGroundShare: 0, sunExposure: 0, coverage: 0.5 });
  });

  it("treats a partly-determined hop as partly unknown", () => {
    const graph = toyGraph(
      [a, b],
      // Shares sum to 0.8: a fifth of the hop matched no OSM way.
      [{ from: "A", to: "B", line: "F", sec: 100, structure: { underground: 0.4, elevated: 0.4 } }],
    );
    const result = railExposure(graph, ["A", "B"], ["F"]);
    expect(result?.aboveGroundShare).toBeCloseTo(0.5, 5);
    expect(result?.coverage).toBeCloseTo(0.8, 5);
  });

  it("returns null when nothing on the path carries structure", () => {
    const graph = toyGraph([a, b], [{ from: "A", to: "B", line: "M", sec: 120 }]);
    // Null, not zero: the caller must fall back to the per-mode constant and
    // say the figure is assumed, rather than report a measurement of nothing.
    expect(railExposure(graph, ["A", "B"], ["M"])).toBeNull();
  });

  it("ignores transfer edges, which are not a ride", () => {
    const graph = toyGraph(
      [a, b, c],
      [
        { from: "A", to: "B", line: "N", sec: 100, structure: { elevated: 1 } },
        { from: "B", to: "C", sec: 180 },
      ],
    );
    const result = railExposure(graph, ["A", "B", "C"], ["N", ""]);
    // The 180 s transfer must not dilute the ride's exposure.
    expect(result?.aboveGroundShare).toBe(1);
    expect(result?.coverage).toBe(1);
  });
});

// ─── Tie-breaking between equal-cost paths ──────────────────────────────────

describe("equal-cost paths", () => {
  /**
   * Two routes of identical cost between the same pair of stations. Nothing in
   * the rest of the suite pins which one wins — every other fixture is built
   * with a strict cost gap so the winner is unambiguous — which means the
   * priority queue could start returning the other one and no test would fail.
   *
   * The array scan pops the earliest-inserted entry among equal costs, because
   * its argmin uses a strict `<`. This asserts that order so the container can
   * be swapped without silently changing which route a rider is shown.
   */
  function twinGraph(): TrainGraph {
    return toyGraph(
      [
        station("X", "Start", 40.75, -73.99),
        station("P1", "Via P", 40.76, -73.99),
        station("Q1", "Via Q", 40.74, -73.99),
        station("Z", "End", 40.77, -73.99),
      ],
      [
        // Inserted first, so it is the one the argmin reaches first on a tie.
        { from: "X", to: "P1", line: "P", sec: 100 },
        { from: "P1", to: "Z", line: "P", sec: 100 },
        { from: "X", to: "Q1", line: "Q", sec: 100 },
        { from: "Q1", to: "Z", line: "Q", sec: 100 },
      ],
    );
  }

  it("returns the same route on every run", () => {
    const first = trainDijkstra(twinGraph(), "X", "Z");
    const second = trainDijkstra(twinGraph(), "X", "Z");
    expect(first?.totalSec).toBe(200);
    expect(second?.totalSec).toBe(200);
    expect(second?.stationIds).toEqual(first?.stationIds);
    expect(second?.lines).toEqual(first?.lines);
  });

  it("breaks a tie towards the edge declared first", () => {
    const result = trainDijkstra(twinGraph(), "X", "Z");
    expect(result?.totalSec).toBe(200);
    expect(result?.stationIds).toEqual(["X", "P1", "Z"]);
    expect(result?.lines).toEqual(["P"]);
  });
});

describe("trainDijkstra: where the rider waits", () => {
  const table = headways([
    { route: "SLOW", dayType: "weekday", hour: 10, sec: 240 },
    { route: "FAST", dayType: "weekday", hour: 10, sec: 1800 },
  ]);
  const departure = { at: WEEKDAY_MORNING, utcOffsetMin: NYC_UTC_OFFSET_MIN };

  it("names the stop a priced wait is spent standing at", () => {
    // A total is enough to quote a time and useless for anything else. The sun
    // a rider takes waiting is a property of *where* they stand, so the stop
    // has to survive the search.
    const path = trainDijkstra(frequencyGraph(table), "X", "Z", departure)!;
    expect(path.waits).toEqual([{ stationId: "X", waitSec: 120 }]);
    expect(path.waitSec).toBe(120);
  });

  it("records one wait per boarding, each at its own stop", () => {
    const path = trainDijkstra(
      toyGraph(
        [toyStation("X", 40.7), toyStation("M", 40.706), toyStation("Z", 40.712)],
        [
          { from: "X", to: "M", line: "SLOW", sec: 300 },
          { from: "M", to: "Z", line: "FAST", sec: 300 },
        ],
        table,
      ),
      "X",
      "Z",
      departure,
    )!;
    expect(path.waits).toEqual([
      { stationId: "X", waitSec: 120 },
      { stationId: "M", waitSec: 900 },
    ]);
    // Still the sum it always was, so nothing that quotes a time changes.
    expect(path.waitSec).toBe(1020);
  });

  it("records no wait where the feed priced none", () => {
    // Unpriced is not a zero-second wait at a known stop; it is nothing to say.
    const path = trainDijkstra(frequencyGraph(table), "X", "Z")!;
    expect(path.waits).toEqual([]);
    expect(path.waitSec).toBe(0);
  });
});

// ─── Per-edge track geometry (item F) ─────────────────────────────────────────

describe("trainDijkstra: per-edge track geometry", () => {
  // One encoded interior point between X and M: (40.703, -74.0), due north of
  // both stops, so the drawn line bends visibly off the chord. Produced once
  // by the producer's encoder; pasted as a literal like the polyline vectors.
  const X_M_GEOM = "wxlwF~btbM";
  const stations = [toyStation("X", 40.7), toyStation("M", 40.706), toyStation("Z", 40.712)];

  function trainSegmentsOf(path: { segments: TrainSegment[] }): TrainRouteSegment[] {
    return path.segments.filter((s): s is TrainRouteSegment => s.type === "train");
  }

  it("carries a published slice onto the segment, between the stop endpoints", () => {
    const path = trainDijkstra(
      toyGraph(stations, [
        { from: "X", to: "M", line: "G", sec: 60, geom: X_M_GEOM },
        { from: "M", to: "Z", line: "G", sec: 60 },
      ]),
      "X",
      "Z",
    )!;
    const [first, second] = trainSegmentsOf(path);
    // Interior point from the slice, framed by the stops the shard carries.
    expect(first.geometry?.length).toBe(3);
    expect(first.geometry?.[0]).toEqual([-74, 40.7]);
    expect(first.geometry?.[1]?.[1]).toBeCloseTo(40.703, 5);
    expect(first.geometry?.[1]?.[0]).toBeCloseTo(-74, 5);
    expect(first.geometry?.[2]).toEqual([-74, 40.706]);
    // No slice published: no geometry key at all, and the chord is drawn.
    expect("geometry" in second).toBe(false);
    const drawData = buildTrainDrawData(path.segments, new Map());
    expect(drawData.polylines[0]?.coords).toEqual(first.geometry);
    expect(drawData.polylines[1]?.coords).toEqual([
      [-74, 40.706],
      [-74, 40.712],
    ]);
  });

  it("draws the chord when the slice does not decode", () => {
    const path = trainDijkstra(
      toyGraph(stations, [
        { from: "X", to: "M", line: "G", sec: 60, geom: "truncated" },
        { from: "M", to: "Z", line: "G", sec: 60 },
      ]),
      "X",
      "Z",
    )!;
    // "truncated" passes the contract regex but is not a decodable pair
    // sequence — it collapses into absent geometry, not a throw.
    const [first] = trainSegmentsOf(path);
    expect("geometry" in first).toBe(false);
    const drawData = buildTrainDrawData(path.segments, new Map());
    expect(drawData.polylines[0]?.coords).toEqual([
      [-74, 40.7],
      [-74, 40.706],
    ]);
  });

  it("draws each hop of a mixed path the right way", () => {
    const path = trainDijkstra(
      toyGraph(
        [...stations, toyStation("W", 40.718)],
        [
          { from: "X", to: "M", line: "G", sec: 60, geom: X_M_GEOM },
          { from: "M", to: "Z", line: "G", sec: 60 },
          { from: "Z", to: "W", line: "G", sec: 60, geom: X_M_GEOM },
        ],
      ),
      "X",
      "W",
    )!;
    const drawData = buildTrainDrawData(path.segments, new Map());
    expect(drawData.polylines).toHaveLength(3);
    expect(drawData.polylines[0]?.coords).toHaveLength(3);
    expect(drawData.polylines[1]?.coords).toHaveLength(2);
    expect(drawData.polylines[2]?.coords).toHaveLength(3);
  });
});

describe("stationConnectors", () => {
  const BOARD_DOOR: [number, number] = [-74.0017, 40.7556];
  const EXIT_DOOR: [number, number] = [-73.976, 40.7517];
  const ride = (...polylines: [number, number][][]): TrainDrawData => ({
    polylines: polylines.map((coords) => ({ coords, color: "#B933AD", line: "7" })),
    stops: [],
    transfers: [],
  });

  it("links each door to its own end of the ride, not the doors to each other", () => {
    const links = stationConnectors(
      [BOARD_DOOR, EXIT_DOOR],
      ride(
        [
          [-74.0019, 40.7559],
          [-73.9950, 40.7540],
          [-73.9877, 40.7555],
        ],
        [
          [-73.9877, 40.7555],
          [-73.9760, 40.7514],
        ],
      ),
    );
    expect(links).toEqual([
      [BOARD_DOOR, [-74.0019, 40.7559]],
      [[-73.976, 40.7514], EXIT_DOOR],
    ]);
  });

  it("draws nothing when there is no ride to link to", () => {
    expect(stationConnectors([BOARD_DOOR, EXIT_DOOR], ride())).toEqual([]);
  });
});

// ─── Route+direction onboard identity ────────────────────────────────────────

describe("trainDijkstra: direction is part of staying aboard", () => {
  // The same route number running the other way: X→A on L direction 0, then
  // A→Z on L direction 1. A route-only identity calls that staying aboard —
  // no boarding, no wait. Route **and** direction is a new vehicle, so it must
  // board and pay.
  // The headway rows are directional: L direction 1 is the reversal the rider
  // must board again for, so it needs its own row or the schedule reads
  // "nothing runs that way" and refuses the boarding outright.
  const table = headways([
    { route: "L", direction: 0, dayType: "weekday", hour: 10, sec: 300 },
    { route: "L", direction: 1, dayType: "weekday", hour: 10, sec: 300 },
  ]);
  const graph = toyGraph(
    [toyStation("X", 40.7), toyStation("A", 40.703), toyStation("Z", 40.706)],
    [
      { from: "X", to: "A", line: "L", sec: 120, direction: 0 },
      { from: "A", to: "Z", line: "L", sec: 120, direction: 1 },
      // The same-direction alternative: one longer hop around the corner.
      { from: "A", to: "Z", line: "L", sec: 300, direction: 0 },
    ],
    table,
  );
  const departure = { at: WEEKDAY_MORNING, utcOffsetMin: NYC_UTC_OFFSET_MIN };

  it("charges a boarding and a wait when the route reverses direction", () => {
    const path = trainDijkstra(graph, "X", "Z", departure)!;
    // Staying aboard direction 0 costs 120 + 300 = 420 s; reversing costs
    // 120 + 150 (wait) + 120 = 390 s. The reversal wins, and this proves the
    // reversal is priced as a *new boarding with its own wait* — a route-only
    // identity called the same hops free and totalled 240 s.
    // The wait at X is the boarding of direction 0; the wait at A is the
    // boarding of the reversed direction 1. Two boardings, two waits — a
    // route-only identity would have totalled 240 s with neither.
    expect(path.lines).toEqual(["L"]);
    expect(path.waits).toEqual([
      { stationId: "X", waitSec: 150 },
      { stationId: "A", waitSec: 150 },
    ]);
    expect(path.totalSec).toBe(540);
  });

  it("makes the reversal itself when staying aboard is slower", () => {
    const cheapTable = headways([
      { route: "L", direction: 0, dayType: "weekday", hour: 10, sec: 60 },
      { route: "L", direction: 1, dayType: "weekday", hour: 10, sec: 60 },
    ]);
    const cheapGraph = toyGraph(
      [toyStation("X", 40.7), toyStation("A", 40.703), toyStation("Z", 40.706)],
      [
        { from: "X", to: "A", line: "L", sec: 120, direction: 0 },
        { from: "A", to: "Z", line: "L", sec: 120, direction: 1 },
        { from: "A", to: "Z", line: "L", sec: 300, direction: 0 },
      ],
      cheapTable,
    );
    const path = trainDijkstra(cheapGraph, "X", "Z", departure)!;
    // 120 + 30 (board dir 0) + 120 + 30 (board the reversal) = 300 s against
    // 120 + 300 = 420 s staying aboard: the reversal is a real journey the
    // search may now find and price honestly, with each boarding waiting.
    expect(path.totalSec).toBe(300);
    expect(path.waits).toEqual([
      { stationId: "X", waitSec: 30 },
      { stationId: "A", waitSec: 30 },
    ]);
  });
});

// ─── One-stop rides ──────────────────────────────────────────────────────────

describe("findBestTrainRoute: a one-stop ride is a useful journey", () => {
  it("offers the single-hop ride the three-station minimum used to refuse", () => {
    const graph = toyGraph(
      [toyStation("X", 40.7), toyStation("Z", 40.712)],
      [{ from: "X", to: "Z", line: "L", sec: 240 }],
    );
    const result = findBestTrainRoute([-74.0, 40.6995], [-74.0, 40.7125], graph)!;
    expect(result).not.toBeNull();
    expect(result.path.stationIds).toEqual(["X", "Z"]);
  });
});

// ─── Multi-source candidate search ───────────────────────────────────────────

describe("findBestTransitRoute", () => {
  const a: [number, number] = [-74.0, 40.6995];
  const b: [number, number] = [-74.0, 40.7125];

  /**
   * The graph the candidate-cap missed: five nearer stops stand between the
   * origin and the useful boarding stop U, and none of them is an entry that
   * leads anywhere — they carry no edges at all, so *any* point-to-point
   * candidate pair among them returns null. Straight-line ranking still puts
   * U sixth from `a`, outside a 5-candidate cap; the multi-source search seeds
   * every eligible stop, so it rides.
   */
  function sixthStopGraph(): TrainGraph {
    const stations: TrainStation[] = [
      toyStation("X", 40.7),
      toyStation("Z", 40.712),
      toyStation("U", 40.706), // the useful boarding stop, sixth from `a`
    ];
    // Five decoy stops, each nearer to `a` than U, each served by nothing.
    for (let i = 1; i <= 5; i++) stations.push(toyStation(`D${i}`, 40.701 + i * 0.0008));
    const edges: Array<{ from: string; to: string; line?: string; sec: number }> = [
      { from: "U", to: "Z", line: "L", sec: 120 },
      { from: "Z", to: "U", line: "L", sec: 120 },
    ];
    return toyGraph(stations, edges);
  }

  const walkSec = (meters: number) => meters / 1.4;

  it("finds a journey whose boarding stop ranks sixth or later", () => {
    const graph = sixthStopGraph();
    const costs = {
      accessSecFor: (s: TrainStation) => walkSec(haversineMeters(a, [s.lon, s.lat])),
      egressSecFor: (s: TrainStation) => walkSec(haversineMeters([s.lon, s.lat], b)),
    };
    const result = findBestTransitRoute(a, b, graph, 1500, costs)!;
    expect(result.outcome).toBe("offered");
    expect(result.route!.entryStation.id).toBe("U");
    // The capped search cannot find it at all — the parity oracle pins that.
    const capped = findBestTrainRoute(a, b, graph, 1500, 5);
    expect(capped).toBeNull();
  });

  it("prices the journey with the actual routed access and egress seconds", () => {
    const graph = sixthStopGraph();
    // Access to U is 400 routed metres (not the ~570 m straight line): a
    // candidate with a *routed* walk must win over straight-line ranking.
    const costs = {
      accessSecFor: (s: TrainStation) =>
        s.id === "U" ? walkSec(400) : walkSec(haversineMeters(a, [s.lon, s.lat])),
      egressSecFor: (s: TrainStation) => walkSec(haversineMeters([s.lon, s.lat], b)),
    };
    const result = findBestTransitRoute(a, b, graph, 1500, costs)!;
    expect(result.route!.accessSec).toBeCloseTo(walkSec(400), 5);
    expect(result.route!.totalCostSec).toBeCloseTo(
      walkSec(400) + 120 + walkSec(haversineMeters([graph.stations.get("Z")!.lon, graph.stations.get("Z")!.lat], b)),
      0,
    );
    // The ride seconds exclude both walks.
    expect(result.route!.path.totalSec).toBe(120);
  });

  it("rejects a stop whose access walk cannot reach it", () => {
    // E is the only stop with service toward the destination, and its street
    // snap is unreachable (Infinity access). The search must drop it as an
    // entry — not silently attach it to whatever is nearby — and then no
    // journey exists: the other entry-capable stop leads nowhere.
    const graph = toyGraph(
      [toyStation("E", 40.702), toyStation("Z", 40.712)],
      [{ from: "E", to: "Z", line: "L", sec: 120 }],
    );
    const costs = {
      accessSecFor: (s: TrainStation) => (s.id === "E" ? Infinity : walkSec(haversineMeters(a, [s.lon, s.lat]))),
      egressSecFor: (s: TrainStation) => walkSec(haversineMeters([s.lon, s.lat], b)),
    };
    const result = findBestTransitRoute(a, b, graph, 1500, costs);
    expect(result.outcome).toBe("no-connected-journey");
    expect(result.route).toBeNull();
  });

  it("reports no-candidates when no eligible stop is reachable on either end", () => {
    const graph = sixthStopGraph();
    const costs = {
      accessSecFor: () => Infinity,
      egressSecFor: () => Infinity,
    };
    const result = findBestTransitRoute(a, b, graph, 1500, costs);
    expect(result.outcome).toBe("no-candidates");
  });

  it("prunes at the dominance bound but still accepts equality", () => {
    const graph = toyGraph(
      [toyStation("X", 40.7), toyStation("Z", 40.712)],
      [{ from: "X", to: "Z", line: "L", sec: 240 }],
    );
    const costs = {
      accessSecFor: (s: TrainStation) => walkSec(haversineMeters(a, [s.lon, s.lat])),
      egressSecFor: (s: TrainStation) => walkSec(haversineMeters([s.lon, s.lat], b)),
    };
    const walkTotal =
      walkSec(haversineMeters(a, [-74.0, 40.7])) +
      240 +
      walkSec(haversineMeters([-74.0, 40.712], b));
    // The bound equals exactly the door-to-door total: still an offer.
    expect(findBestTransitRoute(a, b, graph, 1500, costs, {}, undefined, walkTotal).outcome).toBe(
      "offered",
    );
    // One second tighter and nothing is found.
    expect(
      findBestTransitRoute(a, b, graph, 1500, costs, {}, undefined, walkTotal - 1).outcome,
    ).toBe("no-connected-journey");
  });

  it("agrees with exhaustive candidate enumeration on a small graph", () => {
    // The parity oracle: run the old point-to-point search with every station
    // as candidate (maxCandidates = stations.size) and compare door-to-door
    // seconds with the multi-source result. Straight-line costs, so both
    // searches see the same numbers.
    const graph = sixthStopGraph();
    const costs = {
      accessSecFor: (s: TrainStation) => walkSec(haversineMeters(a, [s.lon, s.lat])),
      egressSecFor: (s: TrainStation) => walkSec(haversineMeters([s.lon, s.lat], b)),
    };
    const multi = findBestTransitRoute(a, b, graph, 1500, costs)!;
    const exhaustive = findBestTrainRoute(a, b, graph, 1500, graph.stations.size);
    expect(exhaustive).not.toBeNull();
    expect(multi.route!.totalCostSec).toBeCloseTo(exhaustive!.totalCostSec, 5);
    expect(multi.route!.path.stationIds).toEqual(exhaustive!.path.stationIds);
  });
});
