import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchTrainGraph,
  findBestTrainRoute,
  headwayKey,
  matchEntranceToTrainStation,
  serviceDayHour,
  TRAIN_SPEED_MPS,
  TRANSFER_PENALTY_SEC,
  trainDijkstra,
  type TrainDayType,
  type TrainGraph,
  type TrainGraphEdge,
  type TrainHeadways,
  type TrainMode,
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
  }>,
  headways?: TrainHeadways,
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
    });
    const from = stationMap.get(e.from)!;
    if (!from.lines.includes(e.line)) from.lines.push(e.line);
    lineModes.set(e.line, "subway");
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
    coveredHours: new Set(rows.map((r) => `${r.dayType}|${r.hour}`)),
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
